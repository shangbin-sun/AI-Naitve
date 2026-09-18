import pytest
import asyncio
from fastapi.testclient import TestClient
from app.chat_timeline import project_turns
from app.independent_runs import Submission, work_manifest
from test_agent_runs import manager
from test_independent_runs import setup, execute, state, approve
from pathlib import Path
import copy
from test_employee_ability import WORKFLOW


def test_public_projection_is_ordered_untruncated_and_has_no_reasoning():
    messages, warnings = project_turns('thread', [{'id':'turn', 'items':[
        {'type':'userMessage','content':[{'type':'text','text':'真实派工'}]},
        {'type':'reasoning','text':'不显示'},
        {'type':'commandExecution','command':'echo test','aggregatedOutput':'x'*12000},
        {'type':'fileChange','changes':[{'path':'a.txt','diff':'+changed'}]},
        {'type':'agentMessage','text':'真实回复'}]}], {'turn'})
    assert len(messages) == 4
    assert messages[0]['source_label'] == '任务派工'
    assert 'x'*12000 in messages[1]['event']['detail']
    assert '+changed' in messages[2]['event']['detail']
    assert '不显示' not in str(messages)
    assert warnings == []


def test_independent_workflow_candidate_is_returned_and_saved(manager):
    run,_=setup(manager); execute(manager,run)
    client=TestClient(manager.app)
    base=f'/api/workspaces/{manager.project_id}/agent-runs/{run["id"]}/nodes/analyze/tuning'
    current=client.get(base+'/ability').json()
    proposal={'id':'existing-candidate','expected_version':current['expected_version'],
              'instructions':current['instructions'],'files':current['files'],
              'workflow':copy.deepcopy(WORKFLOW),'previous_workflow':copy.deepcopy(WORKFLOW)}
    manager.independent.update(manager.project_id,run['id'],lambda r,s:s['nodes']['analyze'].update(
        tuning={'ability_proposal':proposal},workflow_generation={'status':'completed'}))
    response=client.get(base).json()
    assert response['ability_proposal']==proposal
    assert response['messages']==[]
    edited=copy.deepcopy(WORKFLOW);edited['title']='用户编辑后的流程'
    edited.update(approach='保存后同步整体方法',inputs=[],outputs=[])
    edited['steps'][0]['description']='保存后同步具体执行方法'
    saved=client.post(base+'/workflow',json={'workflow':edited,'proposal_id':proposal['id'],
        'expected_version':proposal['expected_version']})
    assert saved.status_code==200, saved.text
    response=client.get(base).json()
    assert response['ability_proposal']['saved_version']==saved.json()['version']
    assert response['workflow_draft']['title']==edited['title']
    assert response['saved_workflow']['title']==edited['title']
    files=client.get(base+'/ability').json()['files']
    assert '保存后同步整体方法' in files['AGENTS.md']
    assert '保存后同步具体执行方法' in files['.agents/skills/employee-workflow/SKILL.md']


def test_paging_every_turn_without_starting_execution(manager):
    run, _ = setup(manager); execute(manager,run)
    calls=[]
    class Connection:
        async def ensure(self): pass
        async def close(self): pass
        async def rpc(self, method, params):
            calls.append(method)
            return {'thread':{'turns':[{'id':str(i),'items':[{'type':'agentMessage','text':str(i)}]} for i in range(45)]}}
    manager.connection_factory=lambda _:Connection()
    client=TestClient(manager.app)
    url=f'/api/workspaces/{manager.project_id}/agent-runs/{run["id"]}/nodes/analyze/tuning/history'
    rows=[]; cursor=''
    while True:
        response=client.get(url+'?limit=20'+('&before='+cursor if cursor else ''))
        assert response.status_code == 200
        page=response.json(); rows=page['messages']+rows
        cursor=page['next_cursor']
        if cursor is None: break
    assert [m['content'] for m in rows] == list(map(str,range(45)))
    assert set(calls)=={'thread/read'}
    assert client.get(url+'?limit=20&before=missing').status_code==409
    # Workflow generation invokes the endpoint as Python, bypassing FastAPI's
    # parameter injection. Default must be None, not a Query metadata object.
    endpoint=next(route.endpoint for route in manager.app.routes if getattr(route,'path','').endswith('/tuning/history'))
    complete=asyncio.run(endpoint(manager.project_id,run['id'],'analyze'))
    assert len(complete['messages'])==45
    assert complete['next_cursor'] is None
    assert client.get(url+'?limit=0').status_code==422


@pytest.mark.parametrize('changed', [False, True])
def test_auto_chat_only_invalidates_when_files_change(manager, changed):
    run,_=setup(manager,True); execute(manager,run); approve(manager,run,'analyze')
    before=state(manager,run)['nodes']['analyze']
    directory=Path(run['directory'])/'nodes/analyze/attempts'/before['attempt']
    manager.independent.update(manager.project_id,run['id'],lambda r,s:s['nodes']['analyze'].update(
        before_chat={'node_status':'completed','run_status':r.status,'files':work_manifest(directory)}))
    if changed: (directory/'outputs/result.txt').write_text('new output')
    manager.independent.submit(manager.project_id,run['id'],'analyze',Submission(
        summary='回复',verification='检查完成',artifacts=['result.txt'] if changed else []))
    after=state(manager,run)['nodes']['analyze']
    assert after['acceptance_record']['actor']=='system'
    assert after['status']=='completed'
    assert after['submission_id']==before['submission_id'] if not changed else after['submission_id']!=before['submission_id']
