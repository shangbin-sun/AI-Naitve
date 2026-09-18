import asyncio
import copy
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from app.agent_models import AgentRun
from app.independent_runs import ENGINE, NodeReview, Submission, validate_graph
from app.schemas import Draft
from app.service import apply_draft
from test_agent_runs import manager, create
from test_factory import DRAFT


def setup(manager, two=False):
    manager.engine_mode = ENGINE
    if two:
        draft=copy.deepcopy(DRAFT)
        draft['members'][1]={**draft['members'][0], 'key':'second', 'name':'第二员工'}
        draft['workflow'][1]={**draft['workflow'][0], 'key':'second', 'owner':'second', 'depends_on':['analyze']}
        with manager.sessions.begin() as db: apply_draft(db,manager.project_id,1,Draft.model_validate(draft),'test')
    run=create(manager,'workflow' if two else 'node')
    calls=[]
    class Connection:
        config={}
        async def ensure(self): pass
        async def close(self): pass
        async def rpc(self,method,params):
            calls.append((method,params))
            if method=='thread/read': return {'thread':{'status':{'type':'idle'},'turns':[]}}
            self.directory=Path(params['cwd'])
            self.options=params
            return {'thread':{'id':params.get('threadId') or 'thread-'+self.directory.parent.parent.name}}
        async def run_turn(self,thread,inputs,event,on_turn,identity,**kwargs):
            calls.append(('run_turn',thread))
            await on_turn('turn-'+str(len(calls)))
            if self.options['sandbox']=='read-only': return SimpleNamespace(reply='这是原任务的解释'),{}
            (self.directory/'outputs/result.txt').write_text('真实测试产物')
            return Submission(summary='已提交',verification='已检查文件内容',artifacts=['result.txt']),{}
    manager.connection_factory=lambda _:Connection()
    return run,calls


def state(manager,run):
    with manager.sessions() as db: return copy.deepcopy(db.get(AgentRun,run['id']).state)


def execute(manager,run): asyncio.run(manager.independent.execute(manager.project_id,run['id']))


def approve(manager,run,key):
    node=state(manager,run)['nodes'][key]
    assert node['status']=='completed'
    assert node['acceptance_record']['actor']=='system'


def test_current_outputs_read_directory_and_keep_history(manager):
    run, _ = setup(manager)
    execute(manager, run)
    node = state(manager, run)['nodes']['analyze']
    root = Path(run['directory'])
    output = root/'nodes/analyze/attempts'/node['attempt']/'outputs'
    client = TestClient(manager.app)
    url = f'/api/workspaces/{manager.project_id}/agent-runs/{run["id"]}/outputs?node=analyze'
    first = client.get(url).json()
    assert first['source'] == 'current'
    (output/'result.txt').write_text('changed output')
    (output/'new.md').write_text('new document')
    changed = client.get(url).json()
    assert len(changed['files']) == 2
    assert changed['files'][1]['revision'] != first['files'][0]['revision']
    assert (root/node['artifacts'][0]['path']).read_text() == '真实测试产物'
    (output/'new.md').unlink()
    assert len(client.get(url).json()['files']) == 1
    (output/'unsafe').symlink_to(root)
    assert client.get(url).json()['warnings']
    assert client.get(url.replace('node=analyze', 'node=other')).status_code == 404
    with manager.sessions.begin() as db:
        original = db.get(AgentRun, run['id'])
        db.add(AgentRun(id='later-run', task_id=original.task_id, status='completed',
            snapshot=original.snapshot, state=original.state, created_at='2099-01-01'))
    historical = client.get(url).json()
    assert historical['source'] == 'snapshot'
    assert historical['files'] == node['artifacts']


def test_dependencies_handoff_isolation_and_automatic_completion(manager):
    run,calls=setup(manager,True)
    execute(manager,run)
    nodes=state(manager,run)['nodes']
    assert nodes['analyze']['status']=='completed'
    assert nodes['second']['attempt'] is not None
    execute(manager,run)
    assert sum(c[0]=='run_turn' for c in calls)==2
    client=TestClient(manager.app)
    base=f'/api/workspaces/{manager.project_id}/agent-runs/{run["id"]}'
    assert client.post(base+'/review',json={'approved':True}).status_code==409
    approve(manager,run,'analyze');execute(manager,run)
    nodes=state(manager,run)['nodes']
    assert nodes['second']['status']=='completed'
    directory=Path(run['directory'])/'nodes/second/attempts'/nodes['second']['attempt']
    context=json.loads((directory/'inputs/context.json').read_text())
    assert context['handoff_files']['analyze'][0]['sha256']==nodes['analyze']['artifacts'][0]['sha256']
    assert (directory/context['handoff_files']['analyze'][0]['local_path']).read_text()=='真实测试产物'
    for method,params in calls:
        if method=='thread/start':
            assert params['config']['features']['multi_agent'] is False
            assert params['config']['sandbox_workspace_write']['writable_roots']==[params['cwd']]
            assert '/nodes/' in params['cwd']
    approve(manager,run,'second');execute(manager,run)
    manager.recover()
    with manager.sessions() as db: assert db.get(AgentRun,run['id']).status=='completed'
    assert (Path(run['directory'])/'outputs/index.json').is_file()


def test_tampered_artifact_blocks_acceptance_and_downstream(manager):
    run,calls=setup(manager,True)
    asyncio.run(manager.independent.worker(manager.project_id,run['id'],'analyze'))
    node=state(manager,run)['nodes']['analyze']
    artifact=Path(run['directory'])/node['artifacts'][0]['path']
    artifact.write_text('changed')
    before=len(calls);execute(manager,run)
    assert len(calls)==before
    assert '内容发生变化' in state(manager,run)['error']
    assert state(manager,run)['nodes']['second']['attempt'] is None


def test_resume_reuses_thread_and_missing_environment_fails(manager):
    run,calls=setup(manager);execute(manager,run)
    node=state(manager,run)['nodes']['analyze']
    manager.independent.update(manager.project_id,run['id'],lambda r,s:s['nodes']['analyze'].update(status='interrupted'))
    execute(manager,run)
    assert any(m=='thread/resume' for m,p in calls)
    node=state(manager,run)['nodes']['analyze']
    directory=Path(run['directory'])/'nodes/analyze/attempts'/node['attempt']
    (directory/'workspace').rmdir()
    manager.independent.update(manager.project_id,run['id'],lambda r,s:s['nodes']['analyze'].update(status='interrupted'))
    before=len(calls);execute(manager,run)
    assert len(calls)==before
    assert '目录缺失' in state(manager,run)['error']


def test_recovery_reconciles_completed_turn_without_resending(manager):
    run,calls=setup(manager)
    directory,node=manager.independent.prepare(manager.project_id,run['id'],'analyze')
    (directory/'outputs/result.txt').write_text('已经执行的产物')
    manager.independent.update(manager.project_id,run['id'],lambda r,s:s['nodes']['analyze'].update(thread_id='existing',pending_turn='t1'))
    class Recovered:
        config={}
        async def ensure(self):pass
        async def close(self):pass
        async def rpc(self,method,params):
            assert method=='thread/read'
            return {'thread':{'status':{'type':'idle'},'turns':[{'id':'t1','status':'completed','items':[{'type':'agentMessage','text':Submission(summary='已完成',verification='实测',artifacts=['result.txt']).model_dump_json()}]}]}}
        async def run_turn(self,*args,**kwargs):raise AssertionError('必须复用已完成结果')
    manager.connection_factory=lambda _:Recovered()
    execute(manager,run)
    assert state(manager,run)['nodes']['analyze']['status']=='completed'


def test_discussion_and_modification_do_not_change_employee_rules(manager):
    run,calls=setup(manager,True);execute(manager,run);approve(manager,run,'analyze');execute(manager,run)
    node=state(manager,run)['nodes']['analyze'];old_artifacts=copy.deepcopy(node['artifacts'])
    route=next(r.endpoint for r in manager.app.routes if getattr(r,'path','').endswith('/nodes/{key}/conversation'))
    from app.independent_runs import FollowUp
    async def conversation(mode,request):
        await route(manager.project_id,run['id'],'analyze',FollowUp(content='解释结果' if mode=='discuss' else '补充说明',request_id=request,mode=mode))
        await manager.tasks[run['id']]
    asyncio.run(conversation('discuss','one'))
    assert state(manager,run)['nodes']['analyze']['status']=='completed'
    assert state(manager,run)['nodes']['analyze']['artifacts']==old_artifacts
    asyncio.run(conversation('modify','two'))
    nodes=state(manager,run)['nodes']
    assert nodes['analyze']['status']=='completed'
    assert nodes['second']['status']=='completed'
    assert nodes['second']['attempts']
    assert nodes['analyze']['artifacts']!=old_artifacts
    assert (Path(run['directory'])/old_artifacts[0]['path']).exists()


def test_graph_rejects_missing_dependency_and_cycle():
    with pytest.raises(ValueError):validate_graph({'a':{'step':{'depends_on':['b']}}},'workflow')
    with pytest.raises(ValueError):validate_graph({'a':{'step':{'depends_on':['a']}}},'workflow')


def test_old_pending_submission_completes_without_model_on_recovery(manager):
    run,calls=setup(manager);execute(manager,run)
    def old(run,state):
        run.status='awaiting_review'
        state['nodes']['analyze']['status']='awaiting_review'
        state['nodes']['analyze'].pop('acceptance_record',None)
    manager.independent.update(manager.project_id,run['id'],old)
    before=len(calls);manager.recover()
    assert len(calls)==before
    with manager.sessions() as db: assert db.get(AgentRun,run['id']).status=='completed'
    assert state(manager,run)['nodes']['analyze']['acceptance_record']['actor']=='system'


def test_failed_worker_never_starts_downstream_or_completes_task(manager):
    run,calls=setup(manager,True)
    async def broken(*args,**kwargs): raise ValueError('输出缺失')
    manager.independent.worker=broken
    execute(manager,run)
    assert state(manager,run)['nodes']['second']['attempt'] is None
    with manager.sessions() as db: assert db.get(AgentRun,run['id']).status=='interrupted'


def test_changed_inputs_block_resume_before_model_call(manager):
    run,calls=setup(manager)
    directory,node=manager.independent.prepare(manager.project_id,run['id'],'analyze')
    (directory/'inputs/context.json').write_text('{}')
    execute(manager,run)
    assert not calls
    assert '内容发生变化' in state(manager,run)['error']


def test_active_or_uncertain_turn_never_resends(manager):
    run,calls=setup(manager)
    manager.independent.prepare(manager.project_id,run['id'],'analyze')
    manager.independent.update(manager.project_id,run['id'],lambda r,s:s['nodes']['analyze'].update(thread_id='existing',pending_send=True))
    execute(manager,run)
    assert not any(m=='run_turn' for m,p in calls)
    assert '禁止自动重发' in state(manager,run)['error']


def test_same_run_execution_lock_and_submission_version_guard(manager):
    import fcntl
    run,calls=setup(manager)
    with (Path(run['directory'])/'scheduler.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        execute(manager,run)
        assert not calls
    execute(manager,run)
    with pytest.raises(HTTPException):
        manager.independent.approve(manager.project_id,run['id'],'analyze',NodeReview(approved=True,note='检查通过',submission_id='old-version'))
