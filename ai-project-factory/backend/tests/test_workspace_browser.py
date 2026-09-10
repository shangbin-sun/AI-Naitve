from pathlib import Path
from fastapi.testclient import TestClient
from app.agent_runs import NewAgentTask
from app.agent_models import AgentRun
from test_agent_runs import manager


def test_roots_preview_and_cross_run_rejection(manager):
    with TestClient(manager.app) as client:
        base = f'/api/workspaces/{manager.project_id}'
        root = client.get(base + '/files').json()
        assert root['scope'] == 'project'
        assert Path(root['root']).name == manager.project_id
        assert {'definition','management','node-tasks','workflow-tasks'} <= {e['name'] for e in root['entries']}
        runs = [manager.create(manager.project_id, NewAgentTask(title=scope,description='test',scope=scope,node='analyze' if scope=='node' else None,request_id=scope)) for scope in ('node','workflow')]
        for run in runs:
            data = client.get(base + '/files', params={'run_id':run['id']}).json()
            assert data['root'] == run['directory']
            assert data['scope'] == run['scope']
            assert client.get(base + '/files', params={'run_id':run['id'], 'path':'..'}).status_code == 403
            file = client.get(base + '/file', params={'run_id':run['id'],'path':'inputs/task.json'}).json()
            assert 'test' in file['text']
            link = Path(run['directory'])/'outside'
            link.symlink_to(Path(root['root']))
            assert client.get(base + '/files', params={'run_id':run['id'],'path':'outside'}).status_code == 403
        other = client.post('/api/workspaces',json={'title':'other'}).json()['id']
        assert client.get(f'/api/workspaces/{other}/files',params={'run_id':runs[0]['id']}).status_code == 404


def test_run_question_uses_existing_binding(manager):
    with TestClient(manager.app) as client:
        run = manager.create(manager.project_id, NewAgentTask(title='test',description='test',scope='node',node='analyze',request_id='one'))
        base = f'/api/workspaces/{manager.project_id}/agent-runs/{run["id"]}/messages'
        assert client.post(base,json={'content':'说明结果'}).status_code == 409
        with manager.sessions.begin() as db:
            row=db.get(AgentRun,run['id']);row.status='completed';row.thread_id='persistent'
        calls=[]
        manager.launch=lambda *args:calls.append(args)
        assert client.post(base,json={'content':'说明结果'}).status_code == 202
        assert calls==[(manager.project_id,run['id'],'说明结果')]
        with manager.sessions() as db:
            row=db.get(AgentRun,run['id']);assert row.thread_id=='persistent'
