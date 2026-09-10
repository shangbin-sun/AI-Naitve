from pathlib import Path

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.dashboards import SaveDashboard, save_dashboard
from test_agent_runs import manager, create, active, control, child
from test_project_tools import tools_workspace


def package(version=0, **changes):
    return dict(expected_version=version, title='团队成果', files={
        'index.html':'<!doctype html><h1 id="value"></h1><script src="app.js"></script>',
        'app.js':'document.getElementById("value").textContent=JSON.stringify(window.DASHBOARD_DATA);',
    }, sample_data={'total':3}, **changes)


def save(manager, version=0, **changes):
    with manager.sessions.begin() as db:
        return save_dashboard(db, manager.project_id, SaveDashboard(**package(version, **changes)))


def test_tool_save_is_independent_versioned_and_idempotent(tools_workspace):
    client, app, project, employee, call, _ = tools_workspace
    before=client.get(f'/api/workspaces/{project}').json()
    assert call('get_dashboard').status_code==200
    args={**package(), 'request_id':'dashboard'}
    result=call('save_dashboard', **args)
    assert result.status_code==200, result.text
    assert call('save_dashboard', **args).json()==result.json()
    assert call('save_dashboard', **{**args,'request_id':'conflict'}).status_code==409
    after=client.get(f'/api/workspaces/{project}').json()
    assert before['version']==after['version']
    assert before['employees']==after['employees']
    assert before['draft']==after['draft']
    updated=call('update_employee', employee_id=employee['id'],expected_version=employee['version'],expected_project_version=before['version'],profile=employee['profile'],files=employee['files'],request_id='existing-editor')
    assert updated.status_code==200, updated.text
    assert call('get_dashboard').json()['dashboard']['version']==1


def test_runs_freeze_dashboard_version_and_sources(manager):
    legacy=create(manager,request='legacy')
    save(manager)
    run=create(manager,request='v1')
    save(manager,1)
    service=manager.app.state.dashboards
    assert service.view(manager.project_id)[0]['version']==2
    assert service.view(manager.project_id,run['id'])[0]['version']==1
    assert service.view(manager.project_id,version=1)[1]=={'total':3}
    assert (Path(run['snapshot']['path'])/'dashboard/index.html').exists()
    with pytest.raises(HTTPException) as error:
        service.view(manager.project_id,legacy['id'])
    assert error.value.status_code==404
    with pytest.raises(HTTPException): service.view('foreign',run['id'])


@pytest.mark.parametrize('changes',[
    {'files':{'index.html':'<img src="https://example.com/image">'}},
    {'files':{'index.html':'<form></form>'}},
    {'files':{'index.html':'ok','../bad.js':'x'}},
    {'data_schema':{'$ref':'https://example.com/schema'}},
    {'data_schema':{'$ref':'#/$defs/missing'}},
    {'data_schema':{'type':'object','required':['missing']}},
    {'data_file':'../secret.json'},
])
def test_invalid_packages_fail_before_save(manager, changes):
    args=package(); args.update(changes)
    with manager.sessions.begin() as db:
        with pytest.raises(HTTPException) as error: save_dashboard(db,manager.project_id,SaveDashboard(**args))
        assert error.value.status_code==422


def test_custom_run_artifact_is_validated(manager):
    save(manager,data_node='analyze')
    run=create(manager); active(manager,run)
    service=manager.app.state.dashboards
    with pytest.raises(HTTPException): service.view(manager.project_id,run['id'])
    begun=control(manager,run,'begin',node='analyze'); child(manager,run)
    path=Path(begun['attempt_path'])/'outputs/dashboard.json'
    path.write_text('{"total":42}')
    control(manager,run,'finish',node='analyze',thread_id='child',artifacts=['dashboard.json'])
    assert service.view(manager.project_id,run['id'])[1]=={'total':42}
    path.write_text('{"total":99}')
    with pytest.raises(HTTPException) as error: service.view(manager.project_id,run['id'])
    assert error.value.status_code==409


def test_preview_security_headers_and_data_escaping(manager):
    args=package(); args['sample_data']={'text':'</script><script>alert(1)</script>'}
    with manager.sessions.begin() as db: save_dashboard(db,manager.project_id,SaveDashboard(**args))
    client=TestClient(manager.app)
    base=f'/api/workspaces/{manager.project_id}/dashboard'
    page=client.get(base+'/page?version=1')
    assert page.status_code==200
    assert "connect-src 'none'" in page.headers['content-security-policy']
    assert 'allow-same-origin' not in page.headers['content-security-policy']
    assert '\\u003c/script' in page.text
    assert '<script>alert(1)' not in page.text
    frame=client.get(base+'/frame?version=1')
    assert "frame-src 'self'" in frame.headers['content-security-policy']
