import asyncio
import copy
import json
from pathlib import Path

import pytest
from fastapi import HTTPException
from app.agent_models import AgentRun
from app.employee_ability import AbilityUpdate, VerifyEmployee
from app.employee_tuning import TuningMessage
from app.models import Employee
from app.chat_attachments import ChatAttachment
from test_employee_tuning import manager, blocked, endpoint, Connection


def test_save_rules_and_skill_then_verify_uses_new_version_clean_workspace(manager):
    run=blocked(manager)
    current=endpoint(manager,'/ability','GET')(manager.project_id,run['id'],'analyze')
    files={**current['files'],'.agents/skills/check-environment/SKILL.md':'---\nname: check-environment\ndescription: 检查员工执行环境\n---\n先检查环境再执行。'}
    saved=endpoint(manager,'/ability')(manager.project_id,run['id'],'analyze',AbilityUpdate(expected_version=current['expected_version'],instructions='先验证运行环境，再完成分析。',files=files))
    assert saved['version']==current['expected_version']+1
    inputs=endpoint(manager,'/verification-inputs','GET')(manager.project_id,run['id'],'analyze')
    launches=[];manager.launch=lambda *args:launches.append(args)
    async def verify():
        request=VerifyEmployee(description=inputs['description'],input_text=inputs['input_text'],attachments=inputs['attachments'],request_id='one')
        first=await endpoint(manager,'/verify')(manager.project_id,run['id'],'analyze',request)
        second=await endpoint(manager,'/verify')(manager.project_id,run['id'],'analyze',request)
        assert first['id']==second['id']
        return first
    result=asyncio.run(verify())
    assert result['id']!=run['id'] and result['thread_id'] is None
    assert result['inputs']['description']==inputs['description']
    assert result['state']['nodes']['analyze']['status']=='pending'
    assert not list((Path(result['directory'])/'outputs').iterdir())
    with manager.sessions() as db:
        newer=db.get(AgentRun,result['id'])
        assert newer.snapshot['definition']['employees']['analyst']['version']==saved['version']
        assert newer.snapshot['definition']['employees']['analyst']['profile']['instructions']=='先验证运行环境，再完成分析。'
        assert db.get(AgentRun,run['id']).state['nodes']['analyze']['status']=='waiting_human'
    with pytest.raises(HTTPException) as exc:
        endpoint(manager,'/ability')(manager.project_id,run['id'],'analyze',AbilityUpdate(expected_version=current['expected_version'],instructions='stale',files=files))
    assert exc.value.status_code==409


def test_generate_ability_readonly_and_image_content_reaches_employee(manager):
    run=blocked(manager)
    with manager.sessions.begin() as db:
        employee=db.query(Employee).one()
        files=copy.deepcopy(employee.files)
        attachment=ChatAttachment(design_id=manager.project_id,name='screen.png',content_type='image/png',data=b'png')
        db.add(attachment);db.flush();attachment_id=attachment.id
    seen=[]
    class ProposalConnection(Connection):
        async def rpc(self,method,params):
            if method in ('thread/start', 'thread/resume'):
                assert params['sandbox']=='read-only'
                assert not params['config']['features']['shell_tool']
            return await super().rpc(method,params)
        async def run_turn(self,thread,inputs,event,turn,identity):
            seen.extend(inputs)
            await turn('ability-turn')
            await event({'type':'reply','text':json.dumps({'summary':'增加环境检查','instructions':'先检查环境','files':files})})
    manager.connection_factory=ProposalConnection
    async def send():
        await endpoint(manager)(manager.project_id,run['id'],'analyze',TuningMessage(content='根据截图整理能力',purpose='ability',attachment_ids=[attachment_id],request_id='one'))
        await manager.tasks[run['id']]
    asyncio.run(send())
    assert any(i['type']=='image' and i['url'].startswith('data:image/png;base64,') for i in seen)
    result=endpoint(manager,'/ability','GET')(manager.project_id,run['id'],'analyze')
    assert result['proposal']['instructions']=='先检查环境'
    assert result['instructions']!='先检查环境'  # suggestion does not mutate capability


@pytest.mark.parametrize('invalid', [False, True])
def test_one_click_ability_update_saves_or_rejects_invalid_skill(manager, invalid):
    run=blocked(manager)
    with manager.sessions() as db:
        employee=db.query(Employee).one();version=employee.version;files=copy.deepcopy(employee.files)
    if invalid: files['.agents/skills/broken/SKILL.md']='invalid'
    class Auto(Connection):
        async def run_turn(self,thread,inputs,event,turn,identity):
            await turn('auto-ability')
            await event({'type':'reply','text':json.dumps({'summary':'已补充环境检查方法','instructions':'先检查环境，再执行。','files':files})})
    manager.connection_factory=Auto
    async def send():
        await endpoint(manager)(manager.project_id,run['id'],'analyze',TuningMessage(content='整理并保存能力',purpose='ability',auto_apply=True,request_id='auto'))
        await manager.tasks[run['id']]
    asyncio.run(send())
    result=endpoint(manager,method='GET')(manager.project_id,run['id'],'analyze')
    with manager.sessions() as db:
        employee=db.query(Employee).one()
        if invalid:
            assert employee.version==version
            assert result['status']=='interrupted'
        else:
            assert employee.version==version+1
            assert employee.profile['instructions']=='先检查环境，再执行。'
            assert '已更新员工能力至' in result['messages'][-1]['content']
            assert result['ability_updates'][-1]['version']==employee.version


def test_verification_from_multiple_chats_shares_task_and_adds_clean_runs(manager):
    from app.agent_models import AgentTask
    run=blocked(manager);manager.launch=lambda *args:None
    async def verify(source, request):
        return await endpoint(manager,'/verify')(manager.project_id,source,'analyze',VerifyEmployee(description='相同输入',request_id=request))
    first=asyncio.run(verify(run['id'],'chat-one'))
    active=asyncio.run(verify(run['id'],'chat-two'))
    assert active['id']==first['id']
    with manager.sessions.begin() as db:
        db.get(AgentRun,first['id']).status='completed'
    second=asyncio.run(verify(first['id'],'chat-three'))
    assert second['task_id']==first['task_id'] and second['id']!=first['id']
    assert second['thread_id'] is None and second['state']['nodes']['analyze']['status']=='pending'
    with manager.sessions() as db:
        assert db.query(AgentTask).count()==2  # original task + one verification task


def test_node_verification_inputs_reuse_frozen_attachments_without_upstream_node(manager):
    run=blocked(manager)
    with manager.sessions.begin() as db:
        stored=db.get(AgentRun,run['id']);data=copy.deepcopy(stored.state)
        data['nodes']['analyze']['step']['depends_on']=['missing-upstream']
        data['task_inputs']={'description':'原内容','attachments':[{'name':'requirements.md','data':'aGVsbG8='}]}
        stored.state=data
    result=endpoint(manager,'/verification-inputs','GET')(manager.project_id,run['id'],'analyze')
    assert result['description']=='原内容'
    assert result['attachments']==[{'name':'requirements.md','data':'aGVsbG8='}]
