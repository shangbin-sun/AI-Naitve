"""Explicit employee capability updates and clean, frozen single-node verification."""
import base64
import copy
import hashlib
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
            return {'expected_version': employee.version, 'instructions': employee.profile['instructions'],
                    'files': employee.files, 'proposal': node.get('tuning', {}).get('ability_proposal')}

    @app.post(base + '/ability')
    def save(project: str, run_id: str, key: str, body: AbilityUpdate):
        validate_ability_files(body.files)
        with manager.sessions.begin() as db:
            task, run, data, node = state(db, project, run_id, key)
            idle(run)
            employee = employee_for(db, project, node)
            before = employee.version
            profile = {**employee.profile, 'instructions': body.instructions}
            employee = edit_employee(db, employee.id, EditEmployee(expected_version=body.expected_version, profile=profile, files=body.files))
            node.setdefault('tuning', {}).setdefault('ability_updates', []).append({'at': now(), 'from_version': before, 'version': employee.version})
            manager.persist(task, run, data)
            version = employee.version
        manager.workspaces.snapshot(project)
        return {'version': version}

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
