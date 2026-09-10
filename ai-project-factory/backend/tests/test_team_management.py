from app.models import Job
from test_factory import workspace, new


def test_rename_versions_and_restore_preserve_team(workspace):
    client, _ = workspace
    identity = new(client, ready=True)
    employees = client.get('/api/employees').json()
    renamed = client.patch(f'/api/workspaces/{identity}', json={'title': '  新团队  ', 'expected_version': 1})
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()['title'] == renamed.json()['draft']['name'] == '新团队'
    assert renamed.json()['version'] == 2
    assert client.patch(f'/api/workspaces/{identity}', json={'title': '旧请求', 'expected_version': 1}).status_code == 409
    assert client.patch(f'/api/workspaces/{identity}', json={'title': '  ', 'expected_version': 2}).status_code == 422
    assert client.delete(f'/api/workspaces/{identity}').status_code == 200
    assert client.delete(f'/api/workspaces/{identity}').status_code == 200
    assert client.get('/api/workspaces').json() == []
    assert client.get('/api/employees').json() == []
    assert client.get(f'/api/workspaces/{identity}').status_code == 404
    assert client.patch(f'/api/workspaces/{identity}', json={'title': '已删除', 'expected_version': 2}).status_code == 404
    assert client.post(f'/api/workspaces/{identity}/restore').status_code == 200
    assert client.get(f'/api/workspaces/{identity}').json()['title'] == '新团队'
    assert client.get('/api/employees').json() == employees


def test_active_team_cannot_be_deleted_or_renamed(workspace):
    client, _ = workspace
    identity = new(client)
    with client.app.state.sessions.begin() as db:
        db.add(Job(design_id=identity, request_id='active-test', base_version=0, status='running'))
    assert client.delete(f'/api/workspaces/{identity}').status_code == 409
    assert client.patch(f'/api/workspaces/{identity}', json={'title': '新名字', 'expected_version': 0}).status_code == 409
    assert client.get(f'/api/workspaces/{identity}').status_code == 200
    assert client.delete('/api/workspaces/missing').status_code == 404


def test_rename_empty_team(workspace):
    client, _ = workspace
    identity = new(client)
    response = client.patch(f'/api/workspaces/{identity}', json={'title': '空团队', 'expected_version': 0})
    assert response.status_code == 200, response.text
    assert response.json()['title'] == '空团队'
