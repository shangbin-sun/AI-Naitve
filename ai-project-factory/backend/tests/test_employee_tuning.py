import asyncio
import copy
import json
from pathlib import Path

import pytest
from fastapi import HTTPException

from app.agent_models import AgentRun
from app.employee_tuning import TuningMessage, SkillDraft, checked_report
from app.models import Employee
from test_agent_runs import manager, create, active, control, child


def endpoint(manager, suffix='', method='POST'):
    path='/api/workspaces/{project}/agent-runs/{run_id}/nodes/{key}/tuning'+suffix
    return next(r.endpoint for r in manager.app.routes if getattr(r, 'path', None)==path and method in r.methods)


def blocked(manager):
    run=create(manager, 'node'); active(manager, run)
    control(manager, run, 'begin', node='analyze'); child(manager, run)
    control(manager, run, 'human', node='analyze', question='环境受阻')
    with manager.sessions.begin() as db:
        db.get(AgentRun, run['id']).status='waiting_human'
    return run


class Connection:
    config={}
    calls=[]
    def __init__(self, settings): pass
    async def ensure(self): pass
    async def close(self): pass
    async def rpc(self, method, params):
        self.calls.append((method,params))
        if method in ('thread/resume','thread/start'):
            self.directory=Path(params['cwd'])
        return {'thread': {'id':'child', 'status':{'type':'idle'}, 'turns':[{'id':'repair-turn','status':'completed','items':[{'type':'commandExecution','exitCode':0}]}]}}
    async def run_turn(self, thread, inputs, event, turn, identity):
        await turn('repair-turn')
        (self.directory/'outputs/result.md').write_text('repaired')
        (self.directory/'repair-report.json').write_text(json.dumps({'passed':True,'verification':'运行验证通过','artifacts':['result.md']}))
        await event({'type':'reply','text':'1. 已修复。\n2. 验证通过。'})


def test_resume_isolated_and_skill_version_preserves_snapshot(manager):
    run=blocked(manager); Connection.calls=[]; manager.connection_factory=Connection
    with manager.sessions() as db:
        before=copy.deepcopy(db.get(AgentRun,run['id']).snapshot)
    async def send():
        request=TuningMessage(content='修复环境', request_id='repair')
        result=await endpoint(manager)(manager.project_id,run['id'],'analyze',request)
        duplicate=await endpoint(manager)(manager.project_id,run['id'],'analyze',request)
        assert duplicate['requests']==['repair']
        await manager.tasks[run['id']]
        return result
    asyncio.run(send())
    data=endpoint(manager,method='GET')(manager.project_id,run['id'],'analyze')
    assert data['report']['passed'] and data['session_mode']=='temporary'
    assert data['messages'][-1]['role']=='assistant'
    resumes=[p for m,p in Connection.calls if m=='thread/resume']
    assert not resumes
    assert any(m=='thread/start' for m,p in Connection.calls)
    with manager.sessions() as db:
        node=db.get(AgentRun,run['id']).state['nodes']['analyze']
        original=Path(run['directory'])/'nodes/analyze/attempts'/node['attempt']/'outputs/result.md'
        assert not original.exists()
    saved=endpoint(manager,'/skill')(manager.project_id,run['id'],'analyze',SkillDraft(name='environment-check',description='排查执行环境问题时使用',body='先核对运行环境，再执行回归验证。',expected_version=data['employee_version']))
    with manager.sessions() as db:
        employee=db.query(Employee).filter_by(key='analyst').one()
        assert saved['version']==employee.version
        assert '.agents/skills/environment-check/SKILL.md' in employee.files
        assert db.get(AgentRun,run['id']).snapshot==before
    with pytest.raises(HTTPException) as error:
        endpoint(manager,'/skill')(manager.project_id,run['id'],'analyze',SkillDraft(name='environment-check',description='scope',body='body',expected_version=data['employee_version']))
    assert error.value.status_code==409
    launches=[];manager.launch=lambda *args:launches.append(args)
    asyncio.run(endpoint(manager,'/continue')(manager.project_id,run['id'],'analyze'))
    with manager.sessions() as db:
        node=db.get(AgentRun,run['id']).state['nodes']['analyze']
        assert '/' not in node['attempt']
        assert node['attempts'] and node['status']=='running'
        assert not node.get('question')
        assert (Path(run['directory'])/'nodes/analyze/attempts'/node['attempt']/'outputs/result.md').exists()
    assert len(launches)==1


def test_active_run_and_unverified_repair_cannot_continue(manager):
    run=blocked(manager)
    with manager.sessions.begin() as db:
        db.get(AgentRun,run['id']).status='running'
    with pytest.raises(HTTPException) as error:
        asyncio.run(endpoint(manager)(manager.project_id,run['id'],'analyze',TuningMessage(content='fix',request_id='one')))
    assert error.value.status_code==409
    with manager.sessions.begin() as db:
        db.get(AgentRun,run['id']).status='waiting_human'
    with pytest.raises(HTTPException):
        asyncio.run(endpoint(manager,'/continue')(manager.project_id,run['id'],'analyze'))
    with pytest.raises(HTTPException) as error:
        endpoint(manager,method='GET')('foreign',run['id'],'analyze')
    assert error.value.status_code==404


def test_old_command_evidence_and_escaping_artifacts_are_rejected(tmp_path):
    tuning={'attempt':'repair','turn_id':'new'}
    folder=tmp_path/'repair';(folder/'outputs').mkdir(parents=True)
    (folder/'secret').write_text('not output')
    (folder/'repair-report.json').write_text(json.dumps({'passed':True,'verification':'ok','artifacts':['../secret']}))
    assert not checked_report(tmp_path,tuning,{'turns':[{'id':'old','items':[{'type':'commandExecution','exitCode':0}]}]})['passed']
    with pytest.raises(ValueError):
        checked_report(tmp_path,tuning,{'turns':[{'id':'new','items':[{'type':'commandExecution','exitCode':0}]}]})


def test_restart_recovers_tuning_without_resuming_task(manager):
    run=blocked(manager)
    with manager.sessions.begin() as db:
        row=db.get(AgentRun,run['id']);data=copy.deepcopy(row.state)
        data['nodes']['analyze']['tuning']={'status':'running','messages':[{'role':'user','content':'fix'}]}
        row.state=data
    manager.recover()
    data=endpoint(manager,method='GET')(manager.project_id,run['id'],'analyze')
    assert data['status']=='interrupted' and data['messages']
    assert not manager.tasks


def test_same_child_still_active_does_not_start_a_turn(manager):
    run=blocked(manager)
    class ActiveConnection(Connection):
        async def rpc(self, method, params):
            assert method == 'thread/read'
            return {'thread': {'status': {'type': 'active'}}}
        async def run_turn(self, *args):
            pytest.fail('must not execute alongside an active child')
    manager.connection_factory=ActiveConnection
    async def send():
        await endpoint(manager)(manager.project_id,run['id'],'analyze',TuningMessage(content='fix',request_id='one',new_session=True))
        await manager.tasks[run['id']]
    asyncio.run(send())
    assert endpoint(manager,method='GET')(manager.project_id,run['id'],'analyze')['status']=='interrupted'


def test_shared_attachments_are_bound_without_team_chat_messages(manager):
    from app.chat_attachments import ChatAttachment, TuningAttachmentUse
    from app.models import Message
    run=blocked(manager);manager.connection_factory=Connection
    with manager.sessions.begin() as db:
        attachment=ChatAttachment(design_id=manager.project_id,name='notes.txt',content_type='text/plain',data=b'context')
        db.add(attachment);db.flush();attachment_id=attachment.id
    async def send():
        await endpoint(manager)(manager.project_id,run['id'],'analyze',TuningMessage(content='fix',request_id='one',attachment_ids=[attachment_id]))
        await manager.tasks[run['id']]
    asyncio.run(send())
    data=endpoint(manager,method='GET')(manager.project_id,run['id'],'analyze')
    assert data['messages'][0]['attachments'][0]['id']==attachment_id
    with manager.sessions() as db:
        assert db.get(TuningAttachmentUse,attachment_id).run_id==run['id']
        assert not db.query(Message).count()
    assert list((Path(run['directory'])/data['attempt']/'inputs').rglob('notes.txt'))


def test_changed_output_cannot_resume(manager):
    run=blocked(manager);manager.connection_factory=Connection
    async def send():
        await endpoint(manager)(manager.project_id,run['id'],'analyze',TuningMessage(content='fix',request_id='one'))
        await manager.tasks[run['id']]
    asyncio.run(send())
    data=endpoint(manager,method='GET')(manager.project_id,run['id'],'analyze')
    (Path(run['directory'])/data['attempt']/'outputs/result.md').write_text('unverified edit')
    with pytest.raises(HTTPException) as error:
        asyncio.run(endpoint(manager,'/continue')(manager.project_id,run['id'],'analyze'))
    assert error.value.status_code==409


def test_employee_files_are_rooted_in_repair_and_replay_keeps_verified_child(manager):
    from fastapi.testclient import TestClient
    run=blocked(manager);manager.connection_factory=Connection
    async def send():
        await endpoint(manager)(manager.project_id,run['id'],'analyze',TuningMessage(content='fix',request_id='one'))
        await manager.tasks[run['id']]
    asyncio.run(send())
    data=endpoint(manager,method='GET')(manager.project_id,run['id'],'analyze')
    client=TestClient(manager.app)
    response=client.get(f'/api/workspaces/{manager.project_id}/files',params={'run_id':run['id'],'node':'analyze'})
    assert response.status_code==200
    assert response.json()['root']==str(Path(run['directory'])/data['attempt'])
    assert client.get(f'/api/workspaces/{manager.project_id}/file',params={'run_id':run['id'],'node':'analyze','path':'../../manifest.json'}).status_code==403
    manager.launch=lambda *args:None
    asyncio.run(endpoint(manager,'/continue')(manager.project_id,run['id'],'analyze'))
    manager.notification(manager.project_id,run['id'],{'method':'item/completed','params':{'threadId':'parent','item':{'type':'subAgentActivity','agentThreadId':'child','agentPath':'/root/analyze','kind':'failed'}}},replay=True)
    with manager.sessions() as db:
        assert db.get(AgentRun,run['id']).state['children']['child']['status']=='completed'


def test_native_history_is_read_only_scoped_and_filters_internal_items(manager):
    run=blocked(manager)
    class History(Connection):
        calls=[]
        async def rpc(self, method, params):
            self.calls.append((method,params))
            return {'thread':{'turns':[
                {'id':'original','items':[{'id':'u','type':'userMessage','content':'internal dispatch'},
                    {'id':'r','type':'reasoning','text':'private'},
                    {'id':'a','type':'agentMessage','text':'1. 已完成代码。\n2. 窗口测试受阻。'}]},
                {'id':'repair','items':[{'id':'b','type':'agentMessage','text':'already saved'}]}]}}
    manager.connection_factory=History
    with manager.sessions.begin() as db:
        stored=db.get(AgentRun,run['id']);data=copy.deepcopy(stored.state)
        data['nodes']['analyze']['tuning']={'turn_ids':['repair']};stored.state=data
    result=asyncio.run(endpoint(manager,'/history','GET')(manager.project_id,run['id'],'analyze'))
    assert [m['content'] for m in result['messages']]==['1. 已完成代码。\n2. 窗口测试受阻。']
    assert [m for m,p in History.calls]==['thread/read']
    assert not manager.tasks
    with pytest.raises(HTTPException) as exc:
        asyncio.run(endpoint(manager,'/history','GET')('foreign',run['id'],'analyze'))
    assert exc.value.status_code==404


def test_history_failure_does_not_change_saved_conversation(manager):
    run=blocked(manager)
    class Unavailable(Connection):
        async def rpc(self,*args): raise RuntimeError('offline')
    manager.connection_factory=Unavailable
    with manager.sessions() as db:
        before=copy.deepcopy(db.get(AgentRun,run['id']).state)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(endpoint(manager,'/history','GET')(manager.project_id,run['id'],'analyze'))
    assert exc.value.status_code==503
    with manager.sessions() as db:
        assert db.get(AgentRun,run['id']).state==before
    assert not manager.tasks


def test_root_chat_imports_history_once_and_reuses_after_reconnect(manager):
    run=blocked(manager)
    class Root(Connection):
        calls=[]
        sent=[]
        async def rpc(self,method,params):
            assert method != 'thread/fork'
            assert not (method=='thread/resume' and params['threadId']=='child')
            if method=='thread/start':
                self.calls.append((method,params));self.directory=Path(params['cwd'])
                return {'thread':{'id':'root-chat','status':{'type':'idle'}}}
            if method=='thread/read' and params['threadId']=='child':
                self.calls.append((method,params))
                return {'thread':{'turns':[{'id':'original','items':[{'type':'agentMessage','text':'原执行结果'},{'type':'reasoning','text':'hidden'}]}]}}
            return await super().rpc(method,params)
        async def run_turn(self,thread,inputs,event,turn,identity):
            self.sent.append(thread)
            assert thread=='root-chat'
            await turn('greeting-turn')
            await event({'type':'reply','text':'你好！'})
    manager.connection_factory=Root
    with manager.sessions.begin() as db:
        stored=db.get(AgentRun,run['id']);data=copy.deepcopy(stored.state)
        data['nodes']['analyze']['tuning']={'messages':[{'role':'user','content':'之前的问题'},{'role':'assistant','content':'之前的回答'}]}
        stored.state=data
    async def send(request):
        await endpoint(manager)(manager.project_id,run['id'],'analyze',TuningMessage(content='你好',request_id=request))
        await manager.tasks[run['id']]
    asyncio.run(send('first'))
    result=endpoint(manager,method='GET')(manager.project_id,run['id'],'analyze')
    assert result['status']=='completed',result.get('error')
    assert result['thread_id']=='root-chat' and result['session_mode']=='temporary'
    assert result.get('report') is None
    asyncio.run(send('second'))
    assert Root.sent==['root-chat','root-chat']
    imports=[p for m,p in Root.calls if m=='thread/inject_items']
    assert len(imports)==1
    texts=[i['content'][0]['text'] for i in imports[0]['items']]
    assert texts==['原执行结果','之前的问题','之前的回答']
    assert len([m for m,p in Root.calls if m=='thread/start'])==1


def test_unrelated_rpc_error_does_not_fork_or_resend(manager):
    from app.codex_session import CodexRPCError
    run=blocked(manager)
    class Failed(Connection):
        calls=[]
        async def run_turn(self,*args):
            error=CodexRPCError({'code':-32000,'message':'other failure'})
            error.method='turn/start'
            raise error
    manager.connection_factory=Failed
    async def send():
        await endpoint(manager)(manager.project_id,run['id'],'analyze',TuningMessage(content='test',request_id='error'))
        await manager.tasks[run['id']]
    asyncio.run(send())
    result=endpoint(manager,method='GET')(manager.project_id,run['id'],'analyze')
    assert result['status']=='interrupted' and result['finished_at']
    assert result['error_info']=={'method':'turn/start','code':-32000}
    assert not any(m=='thread/fork' for m,p in Failed.calls)


def test_failed_history_import_never_binds_partial_root(manager):
    run=blocked(manager)
    class ImportFailure(Connection):
        async def rpc(self,method,params):
            if method=='thread/read':
                return {'thread':{'turns':[{'items':[{'type':'agentMessage','text':'旧结果'}]}]}}
            if method=='thread/inject_items': raise RuntimeError('import failed')
            if method=='thread/start': return {'thread':{'id':'unbound-root'}}
            return await super().rpc(method,params)
        async def run_turn(self,*args): raise AssertionError('must not send after failed import')
    manager.connection_factory=ImportFailure
    async def send():
        await endpoint(manager)(manager.project_id,run['id'],'analyze',TuningMessage(content='hello',request_id='import-fail'))
        await manager.tasks[run['id']]
    asyncio.run(send())
    result=endpoint(manager,method='GET')(manager.project_id,run['id'],'analyze')
    assert result['status']=='interrupted'
    assert result['thread_id']!='unbound-root'


def test_rebuilding_root_imports_uploaded_image(manager):
    from app.chat_attachments import ChatAttachment
    run=blocked(manager)
    with manager.sessions.begin() as db:
        file=ChatAttachment(design_id=manager.project_id,name='screen.png',content_type='image/png',data=b'png')
        db.add(file);db.flush()
        stored=db.get(AgentRun,run['id']);data=copy.deepcopy(stored.state)
        data['nodes']['analyze']['tuning']={'messages':[{'role':'user','content':'看截图','attachments':[{'id':file.id,'name':file.name}]}]}
        stored.state=data
    Connection.calls=[];manager.connection_factory=Connection
    async def send():
        await endpoint(manager)(manager.project_id,run['id'],'analyze',TuningMessage(content='继续',request_id='image-history'))
        await manager.tasks[run['id']]
    asyncio.run(send())
    result=endpoint(manager,method='GET')(manager.project_id,run['id'],'analyze')
    assert result['status']=='completed',result.get('error')
    imported=next(p['items'] for m,p in Connection.calls if m=='thread/inject_items')
    assert any(c.get('type')=='input_image' and c['image_url'].startswith('data:image/png;base64,') for i in imported for c in i['content'])


def test_chat_injects_latest_bundle_while_run_keeps_frozen_version(manager):
    from app.employee_context import employee_context
    run=blocked(manager)
    with manager.sessions.begin() as db:
        employee=db.query(Employee).one()
        employee.profile={**employee.profile,'instructions':'LATEST_EMPLOYEE_RULE'}
        employee.version+=1
    class Capture(Connection):
        calls=[]
        async def rpc(self,method,params):
            if method=='thread/start':
                assert params['config']['sandbox_workspace_write']['writable_roots']==[str(manager.workspaces.project(manager.project_id))]
                assert 'LATEST_EMPLOYEE_RULE' in params['baseInstructions']
                assert 'name: employee-work' in params['baseInstructions']
            return await super().rpc(method,params)
    manager.connection_factory=Capture
    async def send():
        await endpoint(manager)(manager.project_id,run['id'],'analyze',TuningMessage(content='hello',request_id='capability'))
        await manager.tasks[run['id']]
    asyncio.run(send())
    result=endpoint(manager,method='GET')(manager.project_id,run['id'],'analyze')
    assert result['status']=='completed',result.get('error')
    assert 'LATEST_EMPLOYEE_RULE' in result['loaded_capability']['content']
    with manager.sessions() as db:
        frozen=employee_context(db.get(AgentRun,run['id']).snapshot,'analyst')
        assert 'LATEST_EMPLOYEE_RULE' not in frozen['content']
