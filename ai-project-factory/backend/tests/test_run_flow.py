from types import SimpleNamespace
from pathlib import Path
import copy
from app.run_flow import nodes, editor_snapshot
from app.models import Evaluation
from test_factory import workspace, new
from test_tasks import source, definition


def run(**kw):
    return SimpleNamespace(id='a'*32, inputs={}, result={}, status='running', **kw)


def test_states_follow_evidence_not_project_labels():
    r=run();r.result={'stage':'develop','attempts':[{'attempt':0,'exit_code':1,'tests':{'executed':0}}], 'plan':{'summary':'real'},'planning_usage':{'tokens':1}}
    flow=nodes(r,{'changes':[]})
    assert [n['state'] for n in flow]==['needs_repair','completed','running','pending','unavailable']
    r.status='failed'
    assert nodes(r,{'changes':[]})[2]['state']=='failed'
    r.status='cancelled'
    assert nodes(r,{'changes':[]})[2]['state']=='cancelled'
    r.status='completed';r.result={'stage':'complete','attempts':[{'attempt':0,'exit_code':0,'tests':{'executed':2,'passed':2}}]}
    assert [n['state'] for n in nodes(r,{'changes':[]})]==['completed','skipped','skipped','completed','unavailable']
    assert nodes(r,{'changes':[{'name':'a','step_id':'id-develop-1'}]})[3]['stale']


def setup_run(client,manager,tmp_path):
    p=new(client,True);sid=source(client,p,manager,tmp_path);manager.start=lambda _:None
    url=f'/api/workspaces/{p}/tasks'
    task=client.post(url,json=definition(code_source_id=sid)).json()
    url+='/'+task['id']
    r=client.post(url+'/runs',json={'expected_version':1,'request_id':'initial'}).json()
    with manager.sessions.begin() as db:
        row=db.get(Evaluation,r['id']);row.status='completed';row.result={'stage':'complete','workspace':str(manager.root/sid),'attempts':[{'attempt':1,'artifacts':[{'path':'build.gradle.kts','content':'// sample'}]}]}
    return url,r['id']


def test_edit_digest_conflict_snapshot_and_task_isolation(workspace,tmp_path):
    client,_=workspace;manager=client.app.state.evidence
    url,rid=setup_run(client,manager,tmp_path)
    manifest=client.post(f'{url}/runs/{rid}/output-workspace').json()
    f=next(f for f in manifest['files'] if f['name']=='build.gradle.kts');path=Path(f['path'])
    original=client.get(url).json()['runs'][0]['result']
    path.write_text('// human edit')
    flow=client.get(f'{url}/runs/{rid}/flow').json()
    assert flow['changes'][0]['name']=='build.gradle.kts'
    assert flow['nodes'][2]['modified_files']==['build.gradle.kts']
    body={'expected_version':1,'request_id':'adopt','resume_run_id':rid,'restart_node':'test','edits_digest':flow['edits_digest']}
    path.write_text('// edit again')
    assert client.post(url+'/runs',json=body).status_code==409
    body['edits_digest']=client.get(f'{url}/runs/{rid}/flow').json()['edits_digest']
    started=client.post(url+'/runs',json=body)
    assert started.status_code==202,started.text
    r=started.json();assert r['inputs']['editor_snapshot']['changes'][0]['content']=='// edit again'
    path.write_text('// subsequent edit')
    assert client.post(url+'/runs',json=body).json()['id']==r['id']
    detail=client.get(url).json();assert next(x for x in detail['runs'] if x['id']==rid)['result']==original
    assert next(x for x in detail['runs'] if x['id']==r['id'])['inputs']['editor_snapshot']['changes'][0]['content']=='// edit again'
    foreign=new(client)
    assert client.get(f'/api/workspaces/{foreign}/tasks/{url.split("/")[-1]}/runs/{rid}/flow').status_code==404


def test_development_requires_plan_and_failed_run_can_retry(workspace,tmp_path):
    client,_=workspace;manager=client.app.state.evidence
    url,rid=setup_run(client,manager,tmp_path)
    assert client.post(url+'/runs',json={'expected_version':1,'request_id':'develop','resume_run_id':rid,'restart_node':'develop'}).status_code==422
    with manager.sessions.begin() as db:
        r=db.get(Evaluation,rid);r.status='failed';r.result={'stage':'environment'}
    response=client.post(url+'/runs',json={'expected_version':1,'request_id':'retry','resume_run_id':rid,'restart_node':'test'})
    assert response.status_code==202,response.text


def test_only_test_applies_frozen_edit_without_calling_codex(workspace,tmp_path,monkeypatch):
    import asyncio, shutil, importlib
    mod=importlib.import_module('app.delivery')
    client,_=workspace;manager=client.app.state.evidence
    url,rid=setup_run(client,manager,tmp_path)
    manifest=client.post(f'{url}/runs/{rid}/output-workspace').json()
    path=Path(next(f['path'] for f in manifest['files'] if f['name']=='build.gradle.kts'))
    path.write_text('// adopted')
    flow=client.get(f'{url}/runs/{rid}/flow').json()
    response=client.post(url+'/runs',json={'expected_version':1,'request_id':'test-only','resume_run_id':rid,'restart_node':'test','edits_digest':flow['edits_digest']})
    r=response.json();assert response.status_code==202
    path.write_text('// changed after submit')
    async def chains(*args):return []
    async def baseline(identity,inputs,prepared=None):
        assert (prepared/'build.gradle.kts').read_text()=='// adopted'
        return {'workspace':str(prepared),'exit_code':1,'output':'real failure fixture'}
    async def forbidden(*args):raise AssertionError('test-only must not call Codex')
    monkeypatch.setattr(mod,'ensure_toolchains',chains)
    manager.baseline=baseline
    monkeypatch.setattr(manager.runtime,'structured',forbidden,raising=False)
    result,status=asyncio.run(mod.delivery(manager,r['id'],r['inputs']))
    assert status=='blocked' and len(result['attempts'])==1
    assert (Path(result['workspace'])/'build.gradle.kts').read_text()=='// adopted'
    assert (manager.root/r['inputs']['code_source_id']/'build.gradle.kts').read_text()=='// sample'
    assert path.read_text()=='// changed after submit'
    with manager.sessions() as db:
        current=db.get(Evaluation,r['id']);previous=db.get(Evaluation,rid)
        changes=editor_snapshot(manager.root.parent/'output-workspaces',[current,previous])['changes']
        assert changes[0]['content']=='// changed after submit'
        path.write_text('// adopted')
        assert editor_snapshot(manager.root.parent/'output-workspaces',[current,previous])['changes']==[]


def test_plan_edit_requires_development_and_valid_schema(workspace,tmp_path):
    import json
    client,_=workspace;manager=client.app.state.evidence
    url,rid=setup_run(client,manager,tmp_path)
    plan={'summary':'plan','requirements':['r'],'architecture':['a'],'employee_instructions':'implement','open_questions':[]}
    with manager.sessions.begin() as db:
        r=db.get(Evaluation,rid);r.result={**r.result,'plan':plan,'planning_usage':{'tokens':1}}
    manifest=client.post(f'{url}/runs/{rid}/output-workspace').json()
    path=Path(next(f['path'] for f in manifest['files'] if f['name']=='需求与架构方案'))
    path.write_text(json.dumps({**plan,'summary':'human revision'}))
    digest=client.get(f'{url}/runs/{rid}/flow').json()['edits_digest']
    body={'expected_version':1,'request_id':'plan','resume_run_id':rid,'restart_node':'test','edits_digest':digest}
    assert client.post(url+'/runs',json=body).status_code==422
    path.write_text('{broken')
    body.update(restart_node='develop',edits_digest=client.get(f'{url}/runs/{rid}/flow').json()['edits_digest'])
    assert client.post(url+'/runs',json=body).status_code==422
    path.write_text(json.dumps({**plan,'summary':'human revision'}))
    body['edits_digest']=client.get(f'{url}/runs/{rid}/flow').json()['edits_digest']
    response=client.post(url+'/runs',json=body)
    assert response.status_code==202,response.text
    assert response.json()['inputs']['previous_plan']['summary']=='human revision'


def test_cancelled_before_baseline_preserves_resume_code(workspace,tmp_path):
    import shutil
    client,_=workspace;manager=client.app.state.evidence
    url,rid=setup_run(client,manager,tmp_path)
    with manager.sessions.begin() as db:
        original=db.get(Evaluation,rid)
        fixed=tmp_path/'fixed-code';shutil.copytree(original.result['workspace'],fixed)
        (fixed/'build.gradle.kts').write_text('// fixed revision')
        original.result={**original.result,'workspace':str(fixed)}
    mid=client.post(url+'/runs',json={'expected_version':1,'request_id':'mid','resume_run_id':rid,'restart_node':'test'}).json()
    with manager.sessions.begin() as db:
        r=db.get(Evaluation,mid['id']);r.status='cancelled';r.result={}
    retry=client.post(url+'/runs',json={'expected_version':1,'request_id':'after-cancel','resume_run_id':mid['id'],'restart_node':'test'})
    assert retry.status_code==202,retry.text
    assert retry.json()['inputs']['resume_workspace']==str(fixed)


def test_cancelled_before_applying_edits_keeps_frozen_input(workspace,tmp_path):
    client,_=workspace;manager=client.app.state.evidence
    url,rid=setup_run(client,manager,tmp_path)
    manifest=client.post(f'{url}/runs/{rid}/output-workspace').json()
    path=Path(next(f['path'] for f in manifest['files'] if f['name']=='build.gradle.kts'))
    path.write_text('// frozen before cancellation')
    digest=client.get(f'{url}/runs/{rid}/flow').json()['edits_digest']
    mid=client.post(url+'/runs',json={'expected_version':1,'request_id':'mid-edit','resume_run_id':rid,'restart_node':'test','edits_digest':digest}).json()
    with manager.sessions.begin() as db:
        r=db.get(Evaluation,mid['id']);r.status='cancelled';r.result={}
    path.write_text('// later unsaved-to-run edit')
    retry=client.post(url+'/runs',json={'expected_version':1,'request_id':'retry-edit','resume_run_id':mid['id'],'restart_node':'test'})
    assert retry.status_code==202,retry.text
    assert retry.json()['inputs']['editor_snapshot']['changes'][0]['content']=='// frozen before cancellation'
