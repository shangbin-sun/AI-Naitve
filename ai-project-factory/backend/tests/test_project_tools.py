import copy
import time
import pytest
from fastapi.testclient import TestClient
from app.main import create_app
from app.config import Settings
from app.models import Message, Job, ChatOperation, ToolOperation
from test_factory import DRAFT


@pytest.fixture
def tools_workspace(tmp_path):
    settings = Settings(tmp_path, f'sqlite:///{tmp_path}/test.db', 'unused', '', 5)
    app = create_app(settings)
    with TestClient(app) as client:
        project = client.post('/api/workspaces', json={'title': 'tools'}).json()['id']
        client.put(f'/api/workspaces/{project}/draft', json={'expected_version': 0, 'draft': DRAFT})
        employee = client.get(f'/api/workspaces/{project}').json()['employees'][0]
        with app.state.sessions.begin() as db:
            message = Message(design_id=project, role='user', content='修改并验证员工')
            db.add(message); db.flush()
            job = Job(design_id=project, request_id='tools', base_version=1, status='running')
            db.add(job); db.flush()
            db.add(ChatOperation(job_id=job.id, message_id=message.id, mode='chat'))
            job_id = job.id
        app.state.project_tools.active[project] = job_id
        token = app.state.project_tools.token(project)
        def call(action, **args):
            return client.post(f'/api/internal/projects/{project}/tools', headers={'x-project-tool-token': token}, json={'action':action,'arguments':args})
        yield client, app, project, employee, call, job_id


def test_scope_versions_idempotency_and_sync(tools_workspace):
    client, app, project, employee, call, job_id = tools_workspace
    assert client.post(f'/api/internal/projects/{project}/tools', json={'action':'get_project_overview'}).status_code == 403
    other = client.post('/api/workspaces', json={'title':'other'}).json()['id']
    client.put(f'/api/workspaces/{other}/draft', json={'expected_version':0,'draft':DRAFT})
    foreign = client.get(f'/api/workspaces/{other}').json()['employees'][0]
    assert call('get_employee', employee_id=foreign['id']).status_code == 404
    latest = call('get_employee', employee_id=employee['id']).json()
    profile = {**latest['profile'], 'instructions':'先验证输入，再输出结果'}
    args = dict(employee_id=employee['id'], expected_version=employee['version'], expected_project_version=1, profile=profile, files=employee['files'], request_id='edit')
    result = call('update_employee', **args)
    assert result.status_code == 200, result.text
    assert call('update_employee', **args).json() == result.json()
    assert call('update_employee', **{**args,'request_id':'new'}).status_code == 409
    saved = client.get(f'/api/workspaces/{project}').json()
    assert saved['draft']['members'][0]['instructions'] == profile['instructions']
    assert saved['employees'][0]['files']['instructions/role.md'] == profile['instructions']
    with app.state.sessions.begin() as db: db.get(Job,job_id).status='cancelled'
    assert call('get_project_overview').status_code == 409


def test_actual_evaluation_and_comparison(tools_workspace):
    client, app, project, employee, call, _ = tools_workspace
    assert call('evaluate_employee', employee_id=employee['id'], expected_version=employee['version'], input_json='{}', request_id='missing').status_code == 422
    updated = call('update_employee', employee_id=employee['id'], expected_version=employee['version'], expected_project_version=1,
        profile=employee['profile'], files={**employee['files'],'employee.py':'import json,sys\nx=json.load(sys.stdin)\nprint(json.dumps({"value":x["value"]*2}))'},request_id='code').json()
    args = dict(employee_id=employee['id'], expected_version=updated['employee_version'], input_json='{"value":3}',expected_json='{"value":6}',request_id='run')
    run = call('evaluate_employee', **args).json()
    assert call('evaluate_employee', **args).json() == run
    result = call('get_run',run_id=run['run_id'],wait_seconds=10).json()
    assert result['status']=='completed', result
    assert result['result']['comparison']['passed'] is True
    failed = call('evaluate_employee', **{**args,'request_id':'fail','expected_json':'{"value":7}'}).json()
    result = call('get_run',run_id=failed['run_id'],wait_seconds=10).json()
    assert result['status']=='blocked'
    assert result['result']['comparison']['passed'] is False


def test_team_creation_and_reference_scope(tools_workspace):
    client, app, project, employee, call, _ = tools_workspace
    draft=copy.deepcopy(DRAFT)
    draft['members'].append({**draft['members'][0],'key':'reviewer','name':'复核员工'})
    assert call('apply_team_changes', expected_version=1, draft=draft, request_id='team').status_code==200
    assert len(client.get(f'/api/workspaces/{project}').json()['employees'])==2
    draft['members']=draft['members'][:1]
    assert call('apply_team_changes', expected_version=2, draft=draft, request_id='delete').status_code==422
    other=client.post('/api/workspaces',json={'title':'other'}).json()['id']
    response=client.post(f'/api/workspaces/{other}/messages',json={'content':'修改此员工','employee_id':employee['id'],'expected_version':0,'request_id':'foreign'})
    assert response.status_code==404


def test_mcp_preserves_json_strings(monkeypatch):
    import asyncio
    from app import project_mcp
    received = {}
    def capture(action, **args):
        received.update(args)
        return {'ok':True}
    monkeypatch.setattr(project_mcp, 'call', capture)
    asyncio.run(project_mcp.mcp.call_tool('evaluate_employee', {
        'employee_id':'employee','expected_version':1,'input_json':'{"value":3}',
        'expected_json':'{"value":6}','request_id':'sample'}))
    assert received['input_json']=='{"value":3}'
    assert received['expected_json']=='{"value":6}'


def test_human_routing_is_saved_and_exposed_to_codex(tools_workspace):
    client, app, project, employee, call, _ = tools_workspace
    draft = copy.deepcopy(DRAFT)
    draft['human_routing'] = {'default_owner':'owner','assignments':{'analyst':'owner'}}
    response = call('apply_team_changes',expected_version=1,draft=draft,request_id='routing')
    assert response.status_code==200, response.text
    current = call('get_project_overview').json()
    assert current['draft']['human_routing']==draft['human_routing']
    assert current['human_support']['assignments']=={'analyst':'owner'}
    schema = call('get_team_schema').json()
    assert 'human_routing' in schema['properties']
