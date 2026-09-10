import asyncio
import copy
from pathlib import Path

import pytest
from fastapi import HTTPException

from app.agent_models import AgentRun
from app.agent_runs import NewAgentTask
from app.main import create_app
from app.config import Settings
from app.models import Design, Employee
from app.service import apply_draft
from app.schemas import Draft
from app.workspaces import safe_path
from test_factory import DRAFT, ControlledRuntime


@pytest.fixture
def manager(tmp_path):
    app = create_app(Settings(tmp_path, f'sqlite:///{tmp_path}/db.sqlite', 'unused', '', 5), ControlledRuntime())
    manager = app.state.agent_runs
    manager.app = app
    with manager.sessions.begin() as db:
        project = Design(title='AI 团队')
        db.add(project); db.flush()
        apply_draft(db, project.id, 0, Draft.model_validate(DRAFT), 'test')
        manager.project_id = project.id
    return manager


def create(manager, scope='workflow', request='one'):
    return manager.create(manager.project_id, NewAgentTask(title='测试', description='分析输入', scope=scope, node='analyze' if scope == 'node' else None, request_id=request))


def control(manager, run, action, **args):
    return asyncio.run(manager.control(manager.project_id, run['id'], {'threadId':'parent', 'tool':'run_control', 'arguments':{'action':action, **args}}))


def active(manager, run):
    with manager.sessions.begin() as db:
        row = db.get(AgentRun, run['id']); row.thread_id = 'parent'; row.status = 'running'


def child(manager, run, status='completed'):
    manager.notification(manager.project_id, run['id'], {'method':'item/completed', 'params':{'item':{
        'type':'collabAgentToolCall', 'senderThreadId':'parent', 'receiverThreadIds':['child'],
        'prompt':'[node:analyze]', 'agentsStates':{'child':{'status':status}}, 'tool':'spawnAgent'}}})


def test_frozen_definition_and_matching_layout(manager):
    one = create(manager, 'node')
    two = create(manager, 'workflow', 'two')
    assert set(p.name for p in Path(one['directory']).iterdir()) == set(p.name for p in Path(two['directory']).iterdir())
    assert '/node-tasks/' in one['directory'] and '/workflow-tasks/' in two['directory']
    assert one['snapshot']['digest'] == two['snapshot']['digest']
    with manager.sessions.begin() as db:
        employee = db.query(Employee).first()
        employee.files = {**employee.files, 'new.txt':'new definition'}
    three = create(manager, 'node', 'three')
    assert three['snapshot']['digest'] != one['snapshot']['digest']
    assert not (Path(one['snapshot']['path']) / 'employees/analyst/new.txt').exists()
    assert (Path(three['snapshot']['path']) / 'employees/analyst/new.txt').read_text() == 'new definition'


def test_idempotency_and_project_scope(manager):
    one = create(manager)
    assert create(manager)['id'] == one['id']
    with pytest.raises(HTTPException): create(manager, 'node')
    with manager.sessions() as db:
        with pytest.raises(HTTPException): manager.rows(db, 'another-project', one['id'])


def test_dependency_child_evidence_and_artifacts(manager):
    run = create(manager); active(manager, run)
    with pytest.raises(ValueError, match='前置'): control(manager, run, 'human', node='approve', question='确认？')
    begun = control(manager, run, 'begin', node='analyze')
    assert control(manager, run, 'begin', node='analyze')['attempt'] == begun['attempt']
    output = Path(begun['attempt_path']) / 'outputs/result.txt'; output.write_text('分析成果')
    with pytest.raises(ValueError, match='实际派生'): control(manager, run, 'finish', node='analyze', thread_id='fake', artifacts=['result.txt'])
    child(manager, run, 'running')
    with pytest.raises(ValueError, match='实际完成'): control(manager, run, 'finish', node='analyze', thread_id='child', artifacts=['result.txt'])
    child(manager, run)
    with pytest.raises(ValueError): control(manager, run, 'finish', node='analyze', thread_id='child', artifacts=['../manifest.json'])
    done = control(manager, run, 'finish', node='analyze', thread_id='child', artifacts=['result.txt'])
    assert done['status'] == 'completed' and done['artifacts'][0]['sha256']
    assert control(manager, run, 'human', node='approve', question='确认？')['status'] == 'waiting_human'


def test_child_cannot_mutate_state_and_symlink_rejected(manager, tmp_path):
    run = create(manager); active(manager, run)
    with pytest.raises(ValueError, match='主会话'):
        asyncio.run(manager.control(manager.project_id, run['id'], {'threadId':'child', 'tool':'run_control', 'arguments':{'action':'state'}}))
    root = tmp_path / 'own'; root.mkdir()
    (root / 'link').symlink_to(tmp_path / 'secret')
    with pytest.raises(ValueError): safe_path(root, 'link')
    with pytest.raises(ValueError): safe_path(root, '../secret')


def test_restart_preserves_snapshot_and_child_mapping(manager):
    run = create(manager); active(manager, run)
    control(manager, run, 'begin', node='analyze'); child(manager, run, 'running')
    manager.recover()
    with manager.sessions() as db:
        row = db.get(AgentRun, run['id'])
        assert row.status == 'interrupted' and row.thread_id == 'parent'
        assert row.state['nodes']['analyze']['thread_id'] == 'child'
        assert row.snapshot['digest'] == run['snapshot']['digest']


def test_native_activity_events_bind_real_child(manager):
    run = create(manager); active(manager, run)
    control(manager, run, 'begin', node='analyze')
    for kind in ('started', 'completed'):
        manager.notification(manager.project_id, run['id'], {'method':'item/completed','params':{
            'threadId':'parent','item':{'type':'subAgentActivity','agentThreadId':'native-child','agentPath':'/root/analyze','kind':kind}}})
    state = control(manager, run, 'state')['state']
    assert state['nodes']['analyze']['thread_id'] == 'native-child'
    assert state['children']['native-child']['status'] == 'completed'


def test_platform_does_not_follow_output_directory_symlink(manager, tmp_path):
    run = create(manager); active(manager, run)
    begun = control(manager, run, 'begin', node='analyze'); child(manager, run)
    outputs = Path(begun['attempt_path']) / 'outputs'
    outputs.rmdir(); outputs.symlink_to(tmp_path)
    (tmp_path / 'secret.txt').write_text('outside output')
    with pytest.raises(ValueError):
        control(manager, run, 'finish', node='analyze', thread_id='child', artifacts=['secret.txt'])


def test_human_answer_resume_cancel_and_download_api(manager):
    from fastapi.testclient import TestClient
    with TestClient(manager.app) as client:
        run = create(manager); active(manager, run)
        begun = control(manager, run, 'begin', node='analyze'); child(manager, run)
        file = Path(begun['attempt_path']) / 'outputs/result.txt'; file.write_text('result')
        control(manager, run, 'finish', node='analyze', thread_id='child', artifacts=['result.txt'])
        control(manager, run, 'human', node='approve', question='确认？')
        base = f'/api/workspaces/{manager.project_id}/agent-runs/{run["id"]}'
        assert client.post(base + '/answer', json={'node':'approve','answer':'是'}).status_code == 409
        with manager.sessions.begin() as db: db.get(AgentRun, run['id']).status = 'waiting_human'
        assert client.post(base + '/resume').status_code == 409
        assert client.post(base + '/answer', json={'node':'approve','answer':'确认通过'}).status_code == 200
        assert client.post(base + '/answer', json={'node':'approve','answer':'第二次'}).status_code == 409
        artifact = control_after_answer(manager, run)
        assert client.get(base + '/artifact', params={'path':artifact}).content == b'result'
        file.write_text('modified')
        assert client.get(base + '/artifact', params={'path':artifact}).status_code == 409
        launched = []
        manager.launch = lambda project, rid: launched.append(rid)
        assert client.post(base + '/resume').status_code == 200
        assert launched == [run['id']]
        assert client.post(base + '/stop').status_code == 200
        with manager.sessions() as db:
            row = db.get(AgentRun, run['id'])
            assert row.status == 'cancelled' and row.snapshot['digest'] == run['snapshot']['digest']


def control_after_answer(manager, run):
    with manager.sessions() as db:
        row = db.get(AgentRun, run['id'])
        assert row.state['nodes']['approve']['status'] == 'completed'
        return row.state['nodes']['analyze']['artifacts'][0]['path']


def test_instruction_bundle_uses_frozen_employee_and_skills(manager):
    with manager.sessions.begin() as db:
        employee = db.query(Employee).filter_by(key='analyst').one()
        employee.files = {**employee.files, 'AGENTS.md': 'original rules',
                          '.agents/skills/analyze/SKILL.md': '---\nname: analyze\ndescription: Analyze records\n---\nCheck inputs'}
    run = create(manager); active(manager, run)
    with manager.sessions.begin() as db:
        employee = db.query(Employee).filter_by(key='analyst').one()
        employee.files = {**employee.files, 'AGENTS.md': 'changed rules'}
    begun = control(manager, run, 'begin', node='analyze')
    bundle = begun['instruction_bundle']
    assert bundle['snapshot_digest'] == run['snapshot']['digest']
    assert Path(bundle['employee_rules_path']).read_text() == 'original rules'
    assert Path(bundle['role_path']).is_file()
    assert '运行组织规则' in Path(bundle['organization_path']).read_text()
    assert len(bundle['skill_paths']) == 2
    assert 'name: analyze' in Path(bundle['skill_paths'][0]).read_text()
    manager.recover()
    active(manager, run)
    assert control(manager, run, 'begin', node='analyze')['instruction_bundle'] == bundle


def test_organization_rules_change_new_snapshot_only(manager, monkeypatch):
    first = create(manager)
    original = Path.read_text
    def changed(path, *args, **kwargs):
        text = original(path, *args, **kwargs)
        return text + '\nNew organization rule' if path.name == 'organization.md' else text
    monkeypatch.setattr(Path, 'read_text', changed)
    second = create(manager, request='new-policy')
    assert first['snapshot']['digest'] != second['snapshot']['digest']
    assert 'New organization rule' not in Path(first['snapshot']['path'], 'AGENTS.md').read_text()
    assert 'New organization rule' in Path(second['snapshot']['path'], 'AGENTS.md').read_text()
