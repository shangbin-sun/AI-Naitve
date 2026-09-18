import copy
from pathlib import Path
from fastapi.testclient import TestClient
from test_agent_runs import manager
from test_independent_runs import setup, execute, state


def test_open_checks_without_executing_or_mutating_state(manager):
    run,calls=setup(manager); execute(manager,run)
    before=state(manager,run)
    count=len(calls)
    client=TestClient(manager.app)
    url=f'/api/workspaces/{manager.project_id}/agent-runs/{run["id"]}/nodes/analyze/conversation/readiness'
    for _ in range(2):
        response=client.get(url)
        assert response.status_code==200
        assert response.json()['can_send'] is True
    assert state(manager,run)==before
    assert [method for method,_ in calls[count:]]==['thread/read','thread/read']
    node=before['nodes']['analyze']
    directory=Path(run['directory'])/'nodes/analyze/attempts'/node['attempt']
    (directory/'workspace').rmdir()
    response=client.get(url)
    assert response.status_code==409
    assert '工作目录缺失' in response.json()['detail']
    assert state(manager,run)==before


def test_interrupted_turn_can_chat_without_auto_execution_on_open(manager):
    run,calls=setup(manager); execute(manager,run)
    factory=manager.connection_factory
    def connection(settings):
        value=factory(settings)
        rpc=value.rpc
        async def wrapped(method,params):
            if method=='thread/read':
                calls.append((method,params))
                return {'thread':{'status':{'type':'idle'},'turns':[{'id':'interrupted-turn','status':'interrupted','items':[]}]}}
            return await rpc(method,params)
        value.rpc=wrapped
        return value
    manager.connection_factory=connection
    manager.independent.update(manager.project_id,run['id'],lambda r,s:s['nodes']['analyze'].update(
        status='interrupted',pending_turn='interrupted-turn',pending_send=False))
    before=copy.deepcopy(state(manager,run))
    client=TestClient(manager.app)
    url=f'/api/workspaces/{manager.project_id}/agent-runs/{run["id"]}/nodes/analyze/conversation'
    assert client.get(url+'/readiness').json()['can_send'] is True
    assert state(manager,run)==before
    assert client.post(url,json={'content':'请继续处理','request_id':'continue-one'}).status_code==200
    after=state(manager,run)['nodes']['analyze']
    assert after['interrupted_turns']==['interrupted-turn']


def test_uncertain_send_is_not_silently_replayed(manager):
    run,calls=setup(manager); execute(manager,run)
    manager.independent.update(manager.project_id,run['id'],lambda r,s:s['nodes']['analyze'].update(pending_send=True,pending_turn=None))
    before=len(calls)
    client=TestClient(manager.app)
    url=f'/api/workspaces/{manager.project_id}/agent-runs/{run["id"]}/nodes/analyze/conversation'
    assert client.get(url+'/readiness').status_code==409
    assert client.post(url,json={'content':'继续','request_id':'uncertain'}).status_code==409
    assert all(method=='thread/read' for method,_ in calls[before:])
