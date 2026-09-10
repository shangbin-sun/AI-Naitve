"""Project-scoped business operations shared by the MCP transport and HTTP host."""
import copy
import hashlib
import json
import secrets
import asyncio
from fastapi import HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from .models import Design, Employee, Evaluation, Job, ChatOperation, ToolOperation, Source
from .schemas import EditEmployee, Draft
from .collaboration import human_support
from .service import edit_employee, apply_draft, get_design
from .agent_models import AgentRun, AgentTask
from .agent_runs import NewAgentTask


def record(row):
    return {c.name: getattr(row, c.name) for c in row.__table__.columns}


class ToolRequest(BaseModel):
    action: str
    arguments: dict = Field(default_factory=dict)


class ProjectTools:
    def __init__(self, sessions, manager, evidence):
        self.sessions, self.manager, self.evidence = sessions, manager, evidence
        self.tokens = {}
        self.active = {}
        from .feishu_desktop import FeishuDesktop
        self.feishu = FeishuDesktop()

    def token(self, project):
        return self.tokens.setdefault(project, secrets.token_urlsafe(32))

    def employee(self, db, project, identity):
        row = db.get(Employee, identity)
        if not row or row.design_id != project or not row.active:
            raise HTTPException(404, '当前AI 团队中不存在该员工')
        return row

    def run(self, db, project, identity):
        row = db.get(Evaluation, identity)
        if not row or row.design_id != project:
            raise HTTPException(404, '当前AI 团队中不存在该运行')
        return row

    async def call(self, project, action, args):
        # Every invocation is tied to an active host job, never to a model-supplied project ID.
        job_id = self.active.get(project)
        if not job_id:
            raise HTTPException(409, 'AI 团队当前没有活动对话')
        if action == 'feishu_desktop':
            async with self.manager.lock:
                with self.sessions() as db:
                    job = db.get(Job, job_id)
                    operation = db.get(ChatOperation, job_id)
                    if not job or job.status != 'running' or not operation or operation.mode != 'chat':
                        raise HTTPException(409, '本轮已停止或不允许工具操作')
                result = await self.feishu.call(project, **args)
            await self.manager.log(job_id, '飞书桌面操作：' + str(args.get('action')) + '；结果以实际界面为准')
            return result
        if action == 'run_task':
            async with self.manager.lock:
                with self.sessions() as db:
                    job = db.get(Job, job_id)
                    operation = db.get(ChatOperation, job_id)
                    if not job or job.status != 'running' or not operation or operation.mode != 'chat':
                        raise HTTPException(409, '本轮已停止或不允许工具操作')
                result = self.agent_runs.create(project, NewAgentTask(
                    title=args['title'], description=args['description'], scope='node' if args.get('node') else 'workflow',
                    node=args.get('node'), request_id=args['request_id']))
                if result['status'] == 'queued':
                    self.agent_runs.launch(project, result['id'])
                return result
        launch = None
        async with self.manager.lock:
            with self.sessions.begin() as db:
                job = db.get(Job, job_id)
                operation = db.get(ChatOperation, job_id)
                if not job or job.status != 'running' or not operation or operation.mode != 'chat':
                    raise HTTPException(409, '本轮已停止或不允许工具操作')
                design = get_design(db, project)
                if action == 'get_project_overview':
                    employees = list(db.scalars(select(Employee).where(Employee.design_id == project, Employee.active.is_(True))))
                    return {'id': project, 'version': design.version, 'draft': design.draft, 'human_support': human_support(design.draft),
                            'employees': [{'id': e.id, 'key': e.key, 'name': e.profile['name'], 'version': e.version} for e in employees],
                            'sources': [{'id': s.id, 'title': s.title, 'coverage': s.coverage} for s in db.scalars(select(Source).where(Source.design_id == project))]}
                if action == 'get_employee':
                    employee = self.employee(db, project, args['employee_id'])
                    return {**record(employee), 'project_version': design.version,
                            'workflow': design.draft.get('workflow', []), 'human_support': human_support(design.draft),
                            'edit_schema': EditEmployee.model_json_schema()}
                if action == 'get_team_schema':
                    return Draft.model_json_schema()
                if action == 'get_source':
                    source = db.get(Source, args['source_id'])
                    if not source or source.design_id != project:
                        raise HTTPException(404, '当前AI 团队中不存在该资料')
                    content = source.content
                    offset = max(0, int(args.get('offset', 0)))
                    return {'id': source.id, 'title': source.title, 'coverage': source.coverage,
                            'content': content[offset:offset+12000], 'next_offset': offset+12000 if len(content)>offset+12000 else None}
                if action == 'list_runs':
                    employee_id = args.get('employee_id')
                    if employee_id: self.employee(db, project, employee_id)
                    rows = db.scalars(select(Evaluation).where(Evaluation.design_id == project).order_by(Evaluation.created_at.desc())).all()
                    results = [{'id': r.id, 'kind': r.kind, 'status': r.status, 'employee_id': r.inputs.get('employee_id'),
                             'employee_version': r.inputs.get('employee_version'), 'created_at': r.created_at,
                             'scope': r.result.get('scope', '')} for r in rows if not employee_id or r.inputs.get('employee_id') == employee_id][:20]
                    for task, run in db.execute(select(AgentTask, AgentRun).join(AgentRun).where(AgentTask.project_id == project).order_by(AgentRun.created_at.desc()).limit(20)):
                        if employee_id and not any(e['id'] == employee_id and e['profile']['key'] in {n['employee']['key'] for n in run.state['nodes'].values()} for e in run.snapshot['definition']['employees'].values()):
                            continue
                        results.append({'id':run.id, 'kind':'agent_run', 'scope':task.scope, 'status':run.status, 'created_at':run.created_at})
                    return sorted(results, key=lambda r:r['created_at'], reverse=True)[:20]
                if action == 'get_run':
                    if db.get(AgentRun, args['run_id']):
                        task, run = self.agent_runs.rows(db, project, args['run_id'])
                        return self.agent_runs.describe(task, run)
                    run = self.run(db, project, args['run_id'])
                    return {**record(run), 'inputs': {k:v for k,v in run.inputs.items() if k not in ('files', 'sources')}}
                if action not in ('update_employee', 'apply_team_changes', 'evaluate_employee'):
                    raise HTTPException(422, '未知AI 团队工具')
                request_id = args.get('request_id', '')
                if not isinstance(request_id, str) or not 1 <= len(request_id) <= 100:
                    raise HTTPException(422, '写操作需要稳定的 request_id')
                key = hashlib.sha256(f'{project}:{action}:{request_id}'.encode()).hexdigest()
                fingerprint = hashlib.sha256(json.dumps(args, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
                prior = db.get(ToolOperation, key)
                if prior:
                    if prior.fingerprint != fingerprint: raise HTTPException(409, 'request_id 已用于不同参数')
                    return prior.result
                if action == 'update_employee':
                    employee = self.employee(db, project, args['employee_id'])
                    if design.version != args['expected_project_version']:
                        raise HTTPException(409, 'AI 团队已修改，请重新读取最新配置')
                    data = EditEmployee(expected_version=args['expected_version'], profile=args['profile'], files=args['files'])
                    edit_employee(db, employee.id, data)
                    result = {'employee_id': employee.id, 'employee_version': employee.version, 'project_version': design.version,
                              'changed': True, 'tested': False}
                elif action == 'apply_team_changes':
                    proposed = Draft.model_validate(args['draft']).model_dump()
                    # Team creation must not silently remove existing employees or workflow nodes.
                    for field in ('members', 'workflow'):
                        if not {v['key'] for v in design.draft.get(field, [])} <= {v['key'] for v in proposed[field]}:
                            raise HTTPException(422, '团队工具不能删除已有成员或节点；请在方案编辑页明确处理')
                    apply_draft(db, project, args['expected_version'], proposed, 'codex_tools')
                    result = {'project_version': design.version, 'saved': True, 'scope': '团队与员工工程草稿；不代表员工已构建或测试'}
                else:
                    employee = self.employee(db, project, args['employee_id'])
                    if employee.version != args['expected_version']: raise HTTPException(409, '员工版本已变化，请重新读取')
                    if 'employee.py' not in employee.files: raise HTTPException(422, '该员工尚无 employee.py 入口，不能声称已执行；请先实现员工或使用现有构建入口')
                    input_json = args['input_json']
                    if not isinstance(input_json, str) or len(input_json) > 30000: raise HTTPException(422, '输入超长或不是JSON文本')
                    json.loads(input_json)
                    expected = args.get('expected_json')
                    if expected is not None: json.loads(expected)
                    if db.scalar(select(Evaluation.id).where(Evaluation.design_id == project, Evaluation.status.in_(['queued','running']))):
                        raise HTTPException(409, 'AI 团队已有运行，请等待完成')
                    run = Evaluation(design_id=project, design_version=design.version, kind='employee_run', inputs={
                        'employee_id': employee.id, 'employee_version': employee.version, 'files': copy.deepcopy(employee.files),
                        'input_json': input_json, 'expected_json': expected})
                    db.add(run); db.flush(); launch = run.id
                    result = {'run_id': run.id, 'status': run.status, 'employee_version': employee.version,
                              'next': '使用 get_run 查询结果，状态结束之前不能宣称测试通过'}
                db.add(ToolOperation(id=key, design_id=project, job_id=job_id, action=action, fingerprint=fingerprint, result=result))
        if launch: self.evidence.start(launch)
        await self.manager.log(job_id, f'AI 团队工具：{action} 已完成；' + json.dumps(result, ensure_ascii=False))
        return result


def install_project_tools(app, tools):
    @app.post('/api/internal/projects/{project}/tools')
    async def invoke(project: str, payload: ToolRequest, request: Request):
        token = tools.tokens.get(project)
        if not token or not secrets.compare_digest(request.headers.get('x-project-tool-token', ''), token):
            raise HTTPException(403, '无效AI 团队工具凭据')
        try:
            if payload.action == 'get_run' and payload.arguments.get('wait_seconds'):
                # Bounded wait for background work, avoiding rapid polling by the model.
                seconds = min(20, max(0, int(payload.arguments['wait_seconds'])))
                for _ in range(seconds):
                    result = await tools.call(project, 'get_run', payload.arguments)
                    if result['status'] not in ('queued', 'running'): return result
                    await asyncio.sleep(1)
            return await tools.call(project, payload.action, payload.arguments)
        except (KeyError, ValueError, TypeError) as error:
            raise HTTPException(422, str(error))
