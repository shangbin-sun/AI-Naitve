import asyncio
import base64
import copy
from pathlib import Path
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from app.agent_models import AgentRun
from app.agent_runs import NewAgentTask
from app.schemas import Draft
from app.service import apply_draft
from test_agent_runs import manager, create, active, control, child
from test_factory import DRAFT


def test_one_employee_one_node(manager):
    draft=copy.deepcopy(DRAFT)
    draft['workflow'].append({**draft['workflow'][0],'key':'another'})
    with manager.sessions.begin() as db:
        apply_draft(db,manager.project_id,1,Draft.model_validate(draft),'test')
    with pytest.raises(HTTPException,match='一个员工'):
        create(manager)
    single=create(manager,'node',request='single-legacy')
    assert len(single['state']['nodes'])==1
    node=next(iter(single['state']['nodes'].values()))
    assert len(node['step']['internal_steps'])==2


def test_draft_edit_start_and_input_isolation(manager):
    data=NewAgentTask(title='草稿',description='分析',scope='node',node='analyze',request_id='draft',save_draft=True,
                      attachments=[{'name':'input.txt','data':base64.b64encode(b'original').decode()}])
    run=manager.create(manager.project_id,data)
    assert run['status']=='draft'
    assert 'data' not in run['inputs']['attachments'][0]
    path=Path(run['directory'])/'inputs/files/input.txt'
    assert path.read_bytes()==b'original'
    manager.launch=lambda *args:None
    with TestClient(manager.app) as client:
        base=f'/api/workspaces/{manager.project_id}/agent-runs/{run["id"]}'
        payload={**data.model_dump(),'expected_updated_at':run['updated_at'],'attachments':[],'description':'修改后的工作'}
        edit=client.put(base,json=payload)
        assert edit.status_code==200,edit.text
        assert not path.exists()
        assert client.put(base,json=payload).status_code==409
        assert client.post(base+'/start').status_code==200
        assert client.post(base+'/start').status_code==409


def test_rerun_groups_history_and_freezes_inputs(manager):
    first=create(manager,'node')
    data=NewAgentTask(title=first['title'],description='新输入',scope='node',node='analyze',request_id='rerun',
                      task_id=first['task_id'],source_run=first['id'])
    second=manager.create(manager.project_id,data)
    assert second['task_id']==first['task_id'] and second['id']!=first['id']
    assert second['snapshot']['digest']==first['snapshot']['digest']
    assert manager.create(manager.project_id,data)['id']==second['id']
    with manager.sessions() as db:
        task,original=manager.rows(db,manager.project_id,first['id'])
        assert manager.describe(task,original)['inputs']['description']=='分析输入'
    with pytest.raises(HTTPException):
        manager.create('foreign',data)


def test_retry_archives_attempt_and_rejects_late_child_events(manager):
    run=create(manager,'node');active(manager,run)
    begun=control(manager,run,'begin',node='analyze');child(manager,run)
    file=Path(begun['attempt_path'])/'outputs/partial.txt';file.write_text('partial')
    with manager.sessions.begin() as db:
        row=db.get(AgentRun,run['id']);row.status='failed'
        state=copy.deepcopy(row.state);state['nodes']['analyze']['status']='failed';row.state=state
    launched=[];manager.launch=lambda *args:launched.append(args)
    with TestClient(manager.app) as client:
        base=f'/api/workspaces/{manager.project_id}/agent-runs/{run["id"]}'
        assert client.post(base+'/retry',json={'node':'analyze'}).status_code==200
        assert client.post(base+'/retry',json={'node':'analyze'}).status_code==409
    with manager.sessions() as db:
        row=db.get(AgentRun,run['id']);node=row.state['nodes']['analyze']
        assert node['attempt'] is None and len(node['attempts'])==1 and row.thread_id is None
        assert node['attempts'][0]['attempt']==begun['attempt']
    child(manager,run)
    with manager.sessions() as db:
        assert db.get(AgentRun,run['id']).state['nodes']['analyze']['thread_id'] is None
    assert file.read_text()=='partial'


def test_review_rejection_invalidates_downstream_and_preserves_results(manager):
    run=create(manager);active(manager,run)
    begun=control(manager,run,'begin',node='analyze');child(manager,run)
    (Path(begun['attempt_path'])/'outputs/result.txt').write_text('result')
    control(manager,run,'finish',node='analyze',thread_id='child',artifacts=['result.txt'])
    with manager.sessions.begin() as db:
        row=db.get(AgentRun,run['id']);row.status='awaiting_review'
        state=copy.deepcopy(row.state);state['nodes']['approve']['status']='completed';row.state=state
    with TestClient(manager.app) as client:
        base=f'/api/workspaces/{manager.project_id}/agent-runs/{run["id"]}'
        manager.launch=lambda *a:None
        response=client.post(base+'/rework',json={'node':'analyze','reason':'补充依据'})
        assert response.status_code==200,response.text
        data=client.get(f'/api/workspaces/{manager.project_id}/agent-runs').json()[0];assert data['status']=='queued'
        assert all(n['status']=='pending' for n in data['state']['nodes'].values())
        old=data['state']['nodes']['analyze']['attempts'][0]['artifacts'][0]
        assert client.get(base+'/artifact',params={'path':old['path']}).content==b'result'


def test_discussion_cannot_dispatch_or_change_nodes(manager):
    run=create(manager,'node');active(manager,run)
    with manager.sessions.begin() as db:
        row=db.get(AgentRun,run['id']);row.state={**row.state,'discussion_only':True}
    assert control(manager,run,'state')['id']==run['id']
    with pytest.raises(ValueError,match='只讨论结果'):
        control(manager,run,'begin',node='analyze')


@pytest.mark.parametrize('discussion', [False, True])
def test_execution_completes_without_review_and_discussion_preserves_result(manager, discussion):
    run=manager.create(manager.project_id,NewAgentTask(title='验收任务',description='分析',scope='node',node='analyze',request_id='review-run',require_review=True))
    active(manager,run)
    begun=control(manager,run,'begin',node='analyze');child(manager,run)
    (Path(begun['attempt_path'])/'outputs/result.txt').write_text('真实结果')
    control(manager,run,'finish',node='analyze',thread_id='child',artifacts=['result.txt'],verification='读取并检查结果')
    with manager.sessions.begin() as db:
        row=db.get(AgentRun,run['id']);row.status='completed' if discussion else 'queued'
    class Connection:
        config={}
        async def ensure(self): pass
        async def close(self): pass
        async def rpc(self,method,params):
            if method=='thread/resume' and discussion:
                assert params['sandbox']=='read-only'
                assert params['config']['features']['multi_agent'] is False
            return {'thread':{'id':'parent','status':{'type':'idle'},'turns':[]}}
        async def run_turn(self,*args):
            if discussion:
                result=await self.tool_handler({'threadId':'parent','tool':'run_control','arguments':{'action':'state'}})
                assert result['artifact_previews'][0]['text']=='真实结果'
    manager.connection_factory=lambda _:Connection()
    asyncio.run(manager.execute(manager.project_id,run['id'],'解释结果' if discussion else None))
    with manager.sessions() as db:
        row=db.get(AgentRun,run['id'])
        assert row.status=='completed'
        assert row.state['nodes']['analyze']['verification']=='读取并检查结果'
    if not discussion:
        assert (Path(run['directory'])/'outputs/index.json').is_file()


def test_rework_preserves_upstream_and_records_changes(manager):
    run=create(manager);active(manager,run)
    begun=control(manager,run,'begin',node='analyze');child(manager,run)
    (Path(begun['attempt_path'])/'outputs/result.txt').write_text('upstream')
    control(manager,run,'finish',node='analyze',thread_id='child',artifacts=['result.txt'])
    with manager.sessions.begin() as db:
        row=db.get(AgentRun,run['id']);row.status='completed'
        state=copy.deepcopy(row.state);state['nodes']['approve']['status']='completed';row.state=state
    launched=[];manager.launch=lambda *a:launched.append(a)
    with TestClient(manager.app) as client:
        url=f'/api/workspaces/{manager.project_id}/agent-runs/{run["id"]}/rework'
        assert client.post(url,json={'node':'approve','reason':'重新核对'}).status_code==200
        assert client.post(url,json={'node':'approve','reason':'重复'}).status_code==409
    with manager.sessions() as db:
        row=db.get(AgentRun,run['id']);nodes=row.state['nodes']
        assert row.status=='queued' and row.thread_id is None
        assert nodes['analyze']['status']=='completed'
        assert nodes['analyze']['attempt']==begun['attempt']
        assert nodes['approve']['status']=='pending'
        assert row.state['rework_note']=='重新核对'
        assert row.state['events'][-1]['affected']==['approve']
    assert len(launched)==1


def test_nonblocking_human_node_can_skip_but_real_question_cannot(manager):
    run=create(manager);active(manager,run)
    with manager.sessions.begin() as db:
        row=db.get(AgentRun,run['id']);state=copy.deepcopy(row.state)
        state['nodes']['analyze']['status']='completed';row.state=state
    result=control(manager,run,'skip',node='approve',note='无业务卡点，无需例行确认')
    assert result['status']=='skipped' and not result.get('answer')
    with manager.sessions.begin() as db:
        row=db.get(AgentRun,run['id']);state=copy.deepcopy(row.state)
        state['nodes']['approve'].update(status='waiting_human',question='需要业务决策');row.state=state
    with pytest.raises(ValueError,match='已有待处理问题'):
        control(manager,run,'skip',node='approve',note='试图跳过')


def test_local_open_only_accepts_verified_output(manager,monkeypatch):
    import sys
    monkeypatch.setattr(sys,'platform','darwin')
    run=create(manager,'node')
    with TestClient(manager.app) as client:
        base=f'/api/workspaces/{manager.project_id}/agent-runs/{run["id"]}/open-local'
        assert client.post(base,json={'path':'../../private.txt'}).status_code==404
