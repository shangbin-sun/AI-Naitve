"""Opt-in real model and OS sandbox smoke; isolated in pytest's temporary directory."""
import asyncio
import os
from dataclasses import replace
from pathlib import Path

import pytest
from app.config import Settings
from app.codex_session import CodexConnection
from app.agent_models import AgentRun
from app.agent_runs import NewAgentTask
from app.independent_runs import ENGINE, FollowUp
from test_agent_runs import manager


@pytest.mark.skipif(os.getenv('RUN_INDEPENDENT_REAL')!='1', reason='显式启用真实模型烟测')
def test_real_submission_sandbox_and_same_thread_resume(manager):
    real=Settings.from_env()
    manager.settings=replace(manager.settings,codex_bin=real.codex_bin,codex_model=real.codex_model,
        chat_lean_context=True,run_timeout_seconds=120)
    manager.engine_mode=ENGINE;manager.connection_factory=CodexConnection
    run=manager.create(manager.project_id,NewAgentTask(title='隔离烟测',scope='node',node='analyze',request_id='real',
        description='本任务只做隔离烟测：在 outputs/result.txt 写入 sandbox-ok 并读取验证；用 shell 尝试在当前目录的父目录创建 probe-denied.txt，预期必须被沙盒拒绝。若成功如实报告隔离失败。不做其他任务。只提交 result.txt，验证说明应包含父目录写入的退出码和实际错误。'))
    async def check():
        await manager.independent.execute(manager.project_id,run['id'])
        with manager.sessions() as db:
            row=db.get(AgentRun,run['id']);node=row.state['nodes']['analyze']
            assert row.status=='completed',row.state.get('error')
            thread=node['thread_id'];directory=Path(run['directory'])/'nodes/analyze/attempts'/node['attempt']
            assert (directory/'outputs/result.txt').read_text().strip()=='sandbox-ok'
            assert not (directory.parent/'probe-denied.txt').exists()
            print('真实提交：',node['verification'])
        connection=CodexConnection(manager.settings)
        try:
            await connection.ensure()
            history=await connection.rpc('thread/read',{'threadId':thread,'includeTurns':True})
            commands=[i for t in history['thread']['turns'] for i in t.get('items',[]) if i.get('type')=='commandExecution']
            assert any('probe-denied' in str(i.get('command','')) and ('not permitted' in str(i.get('aggregatedOutput','')).lower() or 'permission denied' in str(i.get('aggregatedOutput','')).lower()) for i in commands)
        finally: await connection.close()
        route=next(r.endpoint for r in manager.app.routes if getattr(r,'path','').endswith('/nodes/{key}/conversation'))
        await route(manager.project_id,run['id'],'analyze',FollowUp(content='只读简短解释刚才的验证结果，不修改文件',request_id='discuss',mode='discuss'))
        await manager.tasks[run['id']]
        with manager.sessions() as db:
            row=db.get(AgentRun,run['id']);node=row.state['nodes']['analyze']
            assert row.status=='completed',row.state.get('error')
            assert node['thread_id']==thread
            assert (directory/'outputs/result.txt').read_text().strip()=='sandbox-ok'
            print('同会话恢复：',node['messages'][-1]['content'])
            previous_artifact=Path(run['directory'])/node['artifacts'][0]['path']
        await route(manager.project_id,run['id'],'analyze',FollowUp(content='把 outputs/result.txt 改成 sandbox-updated，读取验证，只提交 result.txt，不要再重复越界测试。',request_id='modify',mode='modify'))
        await manager.tasks[run['id']]
        with manager.sessions() as db:
            row=db.get(AgentRun,run['id']);node=row.state['nodes']['analyze']
            assert row.status=='completed',row.state.get('error')
            assert node['thread_id']==thread
            assert previous_artifact.read_text().strip()=='sandbox-ok'
            assert (Path(run['directory'])/node['artifacts'][0]['path']).read_text().strip()=='sandbox-updated'
            print('同会话修改：新产物已提交，旧版本保留，等待重新验收。')
    asyncio.run(check())
