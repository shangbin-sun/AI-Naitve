from fastapi.testclient import TestClient
from app.run_activity import activity_items
from test_agent_runs import manager, create, active, control, child


def test_projection_excludes_reasoning_and_caps_output():
    rows = activity_items({'turns':[{'status':'completed','items':[
        {'id':'secret','type':'reasoning','text':'private reasoning'},
        {'id':'input','type':'userMessage','text':'input'},
        {'id':'reply','type':'agentMessage','text':'done'},
        {'id':'cmd','type':'commandExecution','aggregatedOutput':'x'*5000,'status':'completed'},
        {'id':'tool','type':'mcpToolCall','tool':'read_file','arguments':{'token':'secret'}},
    ]}]})
    assert [r['id'] for r in rows] == ['reply','cmd','tool']
    assert len(rows[1]['text']) == 4000
    assert 'secret' not in str(rows)


def test_read_activity_is_scoped_and_does_not_start_turn(manager):
    run = create(manager, 'node'); active(manager, run)
    control(manager, run, 'begin', node='analyze'); child(manager, run)
    calls=[]
    class Connection:
        async def ensure(self): pass
        async def rpc(self, method, params):
            calls.append((method,params))
            return {'thread':{'turns':[{'items':[{'id':'one','type':'agentMessage','text':'正在检查输入'}]}]}}
    manager.connections[run['id']] = Connection()
    client=TestClient(manager.app)
    base=f'/api/workspaces/{manager.project_id}/agent-runs/{run["id"]}/activity'
    assert client.get(base+'?node=analyze').json()['items'][0]['text']=='正在检查输入'
    assert calls[0][1]['threadId']=='child'
    assert client.get(base).status_code==200
    assert calls[1][1]['threadId']=='parent'
    assert client.get(base+'?node=foreign').status_code==404
    assert client.get(base.replace(manager.project_id,'foreign')).status_code==404
    assert all(method=='thread/read' for method,_ in calls)
    assert len(calls)==2


def test_pending_node_returns_without_connecting(manager):
    run=create(manager,'node')
    client=TestClient(manager.app)
    response=client.get(f'/api/workspaces/{manager.project_id}/agent-runs/{run["id"]}/activity?node=analyze')
    assert response.status_code==200
    assert response.json()['items']==[]
    assert response.json()['activity']=='等待会话启动'
