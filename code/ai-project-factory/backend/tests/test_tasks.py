from pathlib import Path
from sqlalchemy import select
from app.models import Evaluation
from app.tasks import TaskRun
from test_factory import workspace, new


def definition(**changes):
    return {'title':'开发 Agent1','description':'根据任务输入开发一个可测试的 Agent','acceptance':'原有测试全部通过','code_source_id':None,**changes}


def test_task_crud_version_scope_and_missing_input(workspace):
    client,_=workspace
    p=new(client); other=new(client); url=f'/api/workspaces/{p}/tasks'
    a=client.post(url,json=definition()).json()
    b=client.post(url,json=definition(title='开发 Agent2')).json()
    assert {t['id'] for t in client.get(url).json()}=={a['id'],b['id']}
    assert client.get(f'/api/workspaces/{other}/tasks/{a["id"]}').status_code==404
    changed=client.put(url+'/'+a['id'],json={**definition(title='Agent1 新输入'),'expected_version':1})
    assert changed.json()['version']==2
    assert client.put(url+'/'+a['id'],json={**definition(),'expected_version':1}).status_code==409
    assert client.post(url+'/'+a['id']+'/runs',json={'expected_version':2,'request_id':'first'}).status_code==422
    assert client.get(url+'/'+a['id']).json()['runs']==[]


def source(client,p,manager,tmp_path):
    repo=tmp_path/'code';repo.mkdir(exist_ok=True)
    test=repo/'app/src/test/java/Reference.java';test.parent.mkdir(parents=True,exist_ok=True);test.write_text('reference')
    (repo/'build.gradle.kts').write_text('// sample')
    manager.allowed=repo
    response=client.post(f'/api/workspaces/{p}/sources/import-code',json={'path':str(repo)})
    assert response.status_code==201,response.text
    return response.json()['id']


def test_task_run_snapshot_idempotency_and_resume_isolation(workspace,tmp_path):
    client,_=workspace; manager=client.app.state.evidence
    p=new(client,True); code=source(client,p,manager,tmp_path)
    dispatched=[];manager.start=lambda identity:dispatched.append(identity)
    url=f'/api/workspaces/{p}/tasks'
    task=client.post(url,json=definition(code_source_id=code)).json(); tid=task['id']
    body={'expected_version':1,'request_id':'once'}
    started=client.post(f'{url}/{tid}/runs',json=body)
    assert started.status_code==202,started.text
    run=started.json()
    assert run['inputs']['task_snapshot']['title']=='开发 Agent1'
    assert run['inputs']['code_source_id']==code
    assert run['inputs']['workflow_snapshot']['workflow']
    assert run['inputs']['team_snapshot'][0]['version']==1
    assert client.post(f'{url}/{tid}/runs',json=body).json()['id']==run['id']
    assert dispatched==[run['id']]
    exported=client.get(f'{url}/{tid}/runs/{run["id"]}/export')
    assert exported.status_code==200 and exported.json()['id']==run['id']
    assert 'attachment' in exported.headers['content-disposition']
    prepared=client.post(f'{url}/{tid}/runs/{run["id"]}/output-workspace')
    assert prepared.status_code==200 and prepared.json()['folder_uri'].startswith('vscode://file/')
    assert client.post(f'{url}/missing-task/runs/{run["id"]}/output-workspace').status_code==404
    assert client.post(f'{url}/{tid}/runs/missing-run/output-workspace').status_code==404
    # Updating live inputs must not mutate the run's frozen task.
    assert client.put(f'{url}/{tid}',json={**definition(description='这是修改后的全新任务说明与输入',code_source_id=code),'expected_version':1}).status_code==200
    assert client.get(f'{url}/{tid}').json()['runs'][0]['inputs']['task_snapshot']['version']==1
    assert client.post(f'{url}/{tid}/runs',json={'expected_version':1,'request_id':'stale'}).status_code==409
    with manager.sessions.begin() as db:
        row=db.get(Evaluation,run['id']);row.status='blocked';row.result={'workspace':str(manager.root/code),'stage':'blocked'}
    second=client.post(url,json=definition(title='Agent2',code_source_id=code)).json()
    assert client.post(f'{url}/{second["id"]}/runs',json={'expected_version':1,'request_id':'cross','resume_run_id':run['id']}).status_code==422
    resumed=client.post(f'{url}/{tid}/runs',json={'expected_version':2,'request_id':'resume','resume_run_id':run['id']})
    assert resumed.status_code==202,resumed.text
    assert resumed.json()['inputs']['task_snapshot']['version']==2
    assert len(client.get(f'{url}/{tid}').json()['runs'])==2
    assert client.get(f'{url}/{second["id"]}').json()['runs']==[]


def test_task_rejects_foreign_source(workspace,tmp_path):
    client,_=workspace;manager=client.app.state.evidence
    p=new(client);other=new(client);code=source(client,other,manager,tmp_path)
    assert client.post(f'/api/workspaces/{p}/tasks',json=definition(code_source_id=code)).status_code==422


def test_task_execution_does_not_redefine_shared_team(workspace,tmp_path,monkeypatch):
    import importlib,time
    client,_=workspace;manager=client.app.state.evidence
    p=new(client,True);code=source(client,p,manager,tmp_path)
    original=client.get(f'/api/workspaces/{p}').json()
    installed=[]
    async def execution(*args):
        return {'plan':{'summary':'execution plan'},'reference_tests':{},'attempts':[],'summary':'test fixture'},'completed'
    monkeypatch.setattr(importlib.import_module('app.evidence'),'delivery',execution)
    manager.materialize_delivery_workers=lambda identity:installed.append(identity)
    url=f'/api/workspaces/{p}/tasks'
    task=client.post(url,json=definition(code_source_id=code)).json()
    assert client.post(f'{url}/{task["id"]}/runs',json={'expected_version':1,'request_id':'run'}).status_code==202
    for _ in range(100):
        data=client.get(f'{url}/{task["id"]}').json()
        if data['runs'][0]['status']=='completed':break
        time.sleep(.01)
    assert data['runs'][0]['status']=='completed'
    assert installed==[]
    current=client.get(f'/api/workspaces/{p}').json()
    assert current['draft']==original['draft'] and current['version']==original['version']
