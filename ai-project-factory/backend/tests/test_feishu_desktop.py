import asyncio
import copy
import pytest
from fastapi import HTTPException
from app.feishu_desktop import FeishuDesktop
from app.models import Job
from test_project_tools import tools_workspace


def test_observation_scope_staleness_and_single_use():
    async def check():
        bridge=FeishuDesktop(); calls=[]
        state={'frontmost':True,'nodes':[{'id':'0/1','role':'AXTextField','name':'搜索','value':''}]}
        async def execute(payload):
            calls.append(payload)
            return copy.deepcopy(state) if payload['action']=='inspect' else {'performed':True,'delivery_verified':False}
        bridge.execute=execute
        observed=await bridge.call('a','inspect')
        with pytest.raises(HTTPException):
            await bridge.call('b','set_text',state_id=observed['state_id'],element_id='0/1',text='x')
        state['nodes'][0]['value']='changed'
        with pytest.raises(HTTPException):
            await bridge.call('a','press',state_id=observed['state_id'],element_id='0/1')
        observed=await bridge.call('a','inspect')
        result=await bridge.call('a','set_text',state_id=observed['state_id'],element_id='0/1',text='中文消息')
        assert result['delivery_verified'] is False
        with pytest.raises(HTTPException):
            await bridge.call('a','set_text',state_id=observed['state_id'],element_id='0/1',text='中文消息')
        assert sum(p['action']=='set_text' for p in calls)==1
    asyncio.run(check())


def test_permission_status_actionable():
    async def check():
        bridge=FeishuDesktop()
        async def execute(payload): return {'accessibility':False,'running':True}
        bridge.execute=execute
        result=await bridge.call('a','status')
        assert not result['ready'] and '辅助功能' in result['required_action']
    asyncio.run(check())


def test_mcp_passes_desktop_action_without_shadowing(monkeypatch):
    from app import project_mcp
    captured=[]
    monkeypatch.setattr(project_mcp,'call',lambda *a,**kw:captured.append((a,kw)) or {})
    project_mcp.feishu_desktop('inspect')
    assert captured[0][0]==('feishu_desktop',)
    assert captured[0][1]['action']=='inspect'


def test_desktop_tool_bound_to_active_chat(tools_workspace):
    client,app,project,employee,call,job_id=tools_workspace
    calls=[]
    async def desktop(*args,**kwargs):
        calls.append((args,kwargs));return {'ready':True}
    app.state.project_tools.feishu.call=desktop
    token=app.state.project_tools.token(project)
    def invoke(action):
        return client.post(f'/api/internal/projects/{project}/tools', headers={'x-project-tool-token':token}, json={'action':'feishu_desktop','arguments':{'action':action}})
    assert invoke('status').status_code==200
    with app.state.sessions.begin() as db: db.get(Job,job_id).status='cancelled'
    assert invoke('open').status_code==409
    assert len(calls)==1
