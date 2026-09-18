"""Explicit employee capability updates and clean, frozen single-node verification."""
import base64
import copy
import hashlib
import json
from pathlib import PurePosixPath

from fastapi import HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select

from .models import Employee, now
from .schemas import EditEmployee
from .service import edit_employee, validate_files
from .task_center import TaskOptions
from .workspaces import safe_path


class AbilityUpdate(BaseModel):
    expected_version: int
    instructions: str = Field(min_length=1, max_length=50000)
    files: dict[str, str]
    workflow: dict | None = None


class WorkflowUpdate(BaseModel):
    workflow: dict
    expected_version: int
    proposal_id: str


def validate_workflow(workflow):
    """Keep the visible workflow small, structured, and safe to persist."""
    if not isinstance(workflow, dict):
        raise HTTPException(422, 'WorkFlow 必须是对象')
    if len(str(workflow)) > 120000:
        raise HTTPException(422, 'WorkFlow 内容过大')
    steps = workflow.get('steps')
    if any(field in workflow for field in ('approach', 'inputs', 'outputs')):
        from .workflow_generation import ContractItem
        if not isinstance(workflow.get('approach'), str):
            raise HTTPException(422, '请填写全局做事思路')
        for field in ('inputs', 'outputs'):
            items = workflow.get(field)
            if not isinstance(items, list) or len(items) > 40:
                raise HTTPException(422, '输入输出必须为不超过 40 项的条目列表')
            identities = set()
            for item in items:
                try:
                    parsed = ContractItem.model_validate(item, strict=True)
                except ValueError:
                    raise HTTPException(422, '输入输出条目格式不正确')
                if not parsed.id.strip() or parsed.id in identities or not parsed.name.strip():
                    raise HTTPException(422, '输入输出条目须有名称和唯一编号')
                identities.add(parsed.id)
    for field in ('title', 'goal'):
        if not isinstance(workflow.get(field), str):
            raise HTTPException(422, f'WorkFlow 缺少 {field}')
    if not isinstance(steps, list) or not steps:
        raise HTTPException(422, 'WorkFlow 至少需要一个步骤')
    if len(steps) > 40:
        raise HTTPException(422, 'WorkFlow 步骤不能超过 40 个')
    ids = set()
    for step in steps:
        if not isinstance(step, dict):
            raise HTTPException(422, 'WorkFlow 步骤格式不正确')
        step_id = str(step.get('id', '')).strip()
        if not step_id or step_id in ids:
            raise HTTPException(422, 'WorkFlow 步骤 ID 必须唯一')
        ids.add(step_id)
        for field in ('requirements', 'actions'):
            if not isinstance(step.get(field), list) or not all(isinstance(x, str) for x in step[field]):
                raise HTTPException(422, f'WorkFlow {field} 必须是字符串列表')
        for field in ('input', 'output', 'acceptance'):
            if not isinstance(step.get(field), str):
                raise HTTPException(422, f'WorkFlow 缺少 {field}')
        if 'description' in step and (not isinstance(step['description'], str) or not step['description'].strip()):
            raise HTTPException(422, 'WorkFlow 动作说明不能为空')
        for field in (('name',) if 'description' in step else ('name', 'goal')):
            if not isinstance(step.get(field), str) or not step[field].strip():
                raise HTTPException(422, f'WorkFlow 步骤缺少 {field}')
    return workflow


def workflow_file(workflow):
    return json.dumps(workflow, ensure_ascii=False, indent=2) + '\n'


def saved_workflow(employee):
    raw = employee.files.get('workflow.json')
    return validate_workflow(json.loads(raw)) if raw else None


class VerifyEmployee(TaskOptions):
    description: str = Field(min_length=1, max_length=20000)
    request_id: str = Field(min_length=1, max_length=100)


def validate_ability_files(files):
    validate_files(files)
    import yaml
    for name, content in files.items():
        if name.startswith('.agents/skills/') and name.endswith('/SKILL.md'):
            parts = content.split('---', 2)
            try:
                metadata = yaml.safe_load(parts[1]) if len(parts) == 3 and not parts[0].strip() else None
            except yaml.YAMLError:
                metadata = None
            if not isinstance(metadata, dict) or not all(isinstance(metadata.get(k), str) and metadata[k].strip() for k in ('name', 'description')):
                raise HTTPException(422, f'{name} 缺少有效的 name 和 description')
            if metadata['name'] != PurePosixPath(name).parent.name:
                raise HTTPException(422, 'Skill 名称必须与目录名称一致')


def install_employee_ability(app, manager, state, idle):
    base = '/api/workspaces/{project}/agent-runs/{run_id}/nodes/{key}/tuning'

    def employee_for(db, project, node):
        employee = db.scalar(select(Employee).where(Employee.design_id == project, Employee.key == node['step']['owner'], Employee.active.is_(True)))
        if not employee:
            raise HTTPException(404, '员工已退出当前团队')
        return employee

    @app.get(base + '/ability')
    def ability(project: str, run_id: str, key: str):
        with manager.sessions() as db:
            _, _, _, node = state(db, project, run_id, key)
            employee = employee_for(db, project, node)
            stored = saved_workflow(employee)
            if stored is None and isinstance(employee.files.get('workflow.json'), str):
                try:
                    stored = json.loads(employee.files['workflow.json'])
                except json.JSONDecodeError:
                    stored = None
            return {'expected_version': employee.version, 'instructions': employee.profile['instructions'],
                    'files': employee.files, 'workflow': stored,
                    'proposal': node.get('tuning', {}).get('ability_proposal')}

    @app.post(base + '/ability')
    def save(project: str, run_id: str, key: str, body: AbilityUpdate):
        validate_ability_files(body.files)
        if body.workflow is not None:
            validate_workflow(body.workflow)
            body.files['workflow.json'] = workflow_file(body.workflow)
            from .workflow_generation import project_workflow
            body.files = project_workflow(body.files, body.workflow)
        with manager.sessions.begin() as db:
            task, run, data, node = state(db, project, run_id, key)
            idle(run)
            employee = employee_for(db, project, node)
            before = employee.version
            profile = {**employee.profile, 'instructions': body.instructions}
            employee = edit_employee(db, employee.id, EditEmployee(expected_version=body.expected_version, profile=profile, files=body.files))
            tuning = node.setdefault('tuning', {})
            if body.workflow is not None:
                tuning['workflow_draft'] = body.workflow
                if tuning.get('ability_proposal'):
                    tuning['ability_proposal']['workflow'] = body.workflow
            tuning.setdefault('ability_updates', []).append({'at': now(), 'from_version': before, 'version': employee.version,
                                                             'workflow': body.workflow is not None})
            manager.persist(task, run, data)
            version = employee.version
        manager.workspaces.snapshot(project)
        return {'version': version}

    @app.post(base + '/workflow')
    def save_workflow(project: str, run_id: str, key: str, body: WorkflowUpdate):
        workflow = validate_workflow(body.workflow)
        with manager.sessions.begin() as db:
            task, run, data, node = state(db, project, run_id, key)
            idle(run)
            employee = employee_for(db, project, node)
            tuning = node.setdefault('tuning', {})
            proposal = tuning.get('ability_proposal')
            if not proposal or proposal.get('id') != body.proposal_id:
                raise HTTPException(409, '候选已更新，请刷新后重新比较')
            if proposal.get('saved_version'):
                raise HTTPException(409, '候选已经保存')
            if employee.version != body.expected_version or proposal['expected_version'] != employee.version:
                raise HTTPException(409, '员工已有新版本，请重新生成候选后比较')
            validate_ability_files(proposal['files'])
            before = employee.version
            workflow = {**workflow, 'version': (saved_workflow(employee) or {}).get('version', 0) + 1}
            files = {**proposal['files'], 'workflow.json': workflow_file(workflow)}
            if proposal.get('generated_workflow') or 'approach' in workflow:
                from .workflow_generation import project_workflow
                files = project_workflow(files, workflow)
            validate_ability_files(files)
            employee = edit_employee(db, employee.id, EditEmployee(
                expected_version=before,
                profile={**employee.profile, 'instructions': proposal['instructions']},
                files=files,
            ))
            tuning['workflow_draft'] = workflow
            proposal.update(workflow=workflow, saved_version=employee.version)
            tuning.setdefault('ability_updates', []).append({'at': now(), 'from_version': before,
                                                             'version': employee.version, 'workflow': True})
            manager.persist(task, run, data)
            version = employee.version
        manager.workspaces.snapshot(project)
        return {'workflow': workflow, 'version': version}

    @app.get(base + '/verification-inputs')
    def inputs(project: str, run_id: str, key: str):
        with manager.sessions() as db:
            task, run, _, node = state(db, project, run_id, key)
            employee = employee_for(db, project, node)
            result = copy.deepcopy(run.state.get('task_inputs', task.inputs))
            attachments = result.setdefault('attachments', [])
            names = {f['name'] for f in attachments}
            for dep in node['step'].get('depends_on', []):
                upstream = run.state['nodes'].get(dep)
                if upstream is None:
                    if task.scope == 'node':
                        continue  # Its upstream files were frozen into task_inputs.
                    raise HTTPException(409, '原运行缺少上游节点，无法完整复用输入')
                for index, artifact in enumerate(upstream.get('artifacts', [])):
                    path = safe_path(manager.directory(task, run), artifact['path'])
                    if not path.is_file():
                        raise HTTPException(409, '原上游输入文件缺失，无法完整复用')
                    name = path.name
                    if name in names:
                        name = f'{dep}-{index}-{name}'
                    names.add(name)
                    attachments.append({'name': name, 'data': base64.b64encode(path.read_bytes()).decode()})
            # Validate limits rather than silently dropping original inputs.
            try:
                TaskOptions(attachments=attachments)
            except ValueError as exc:
                raise HTTPException(422, '原输入超过单次执行附件限制，请在任务入口选择输入') from exc
            return {'description': result.get('description', ''), 'input_text': result.get('input_text', ''),
                    'attachments': attachments, 'employee_version': employee.version}

    @app.post(base + '/verify')
    async def verify(project: str, run_id: str, key: str, body: VerifyEmployee):
        from .agent_runs import NewAgentTask
        from .agent_models import AgentTask, AgentRun
        from .task_center import task_inputs
        with manager.sessions() as db:
            task, run, _, node = state(db, project, run_id, key)
            employee = employee_for(db, project, node)
            owner, title = employee.key, task.title
            requested_inputs = task_inputs(NewAgentTask(title=title, scope='node', node=owner, description=body.description, input_text=body.input_text, attachments=body.attachments, request_id=body.request_id))
            task_key = 'verify-node:' + hashlib.sha256(key.encode()).hexdigest()
            request_key = 'verify:' + hashlib.sha256(f'{key}:{body.request_id}'.encode()).hexdigest()
            target = db.scalar(select(AgentTask).where(AgentTask.project_id == project, AgentTask.request_id == task_key))
            if target is None:
                # Adopt an existing node verification task without moving its files/history.
                for candidate in db.scalars(select(AgentTask).where(AgentTask.project_id == project, AgentTask.scope == 'node', AgentTask.request_id.like('verify:%')).order_by(AgentTask.created_at)):
                    prior = db.scalar(select(AgentRun).where(AgentRun.task_id == candidate.id).order_by(AgentRun.created_at.desc()))
                    if prior and key in prior.state.get('nodes', {}) and prior.state['nodes'][key]['step']['owner'] == owner:
                        target = candidate
                        break
            runs = list(db.scalars(select(AgentRun).where(AgentRun.task_id == target.id).order_by(AgentRun.created_at.desc()))) if target else []
            for prior in runs:
                if prior.state.get('request_id') == request_key:
                    if prior.state.get('task_inputs') != requested_inputs:
                        raise HTTPException(409, '请求标识已用于其他输入')
                    return manager.describe(target, prior)
                if prior.status in ('queued', 'running') or prior.id in manager.tasks:
                    return manager.describe(target, prior)
            idle(run)
            target_id = target.id if target else None
            source_id = runs[0].id if runs else None
        if len(manager.tasks) >= 4:
            raise HTTPException(429, '运行数量已达上限')
        if target_id:
            with manager.sessions.begin() as db:
                db.get(AgentTask, target_id).request_id = task_key
        result = manager.create(project, NewAgentTask(title=title, scope='node', node=owner,
            description=body.description, input_text=body.input_text, attachments=body.attachments,
            task_id=target_id, source_run=source_id, use_latest=True,
            request_id=request_key if target_id else task_key))
        if not target_id:
            with manager.sessions.begin() as db:
                created = db.get(AgentRun, result['id'])
                created.state = {**created.state, 'request_id': request_key}
                manager.persist(db.get(AgentTask, created.task_id), created, created.state)
        with manager.sessions.begin() as db:
            task, run, data, node = state(db, project, run_id, key)
            validations = node.setdefault('tuning', {}).setdefault('validations', [])
            if not any(v['run_id'] == result['id'] for v in validations):
                validations.append({'run_id': result['id'], 'at': now(), 'version': result['snapshot']['version']})
                manager.persist(task, run, data)
        if result['status'] == 'queued':
            manager.launch(project, result['id'])
        return result
