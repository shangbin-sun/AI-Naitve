"""Opt-in real Codex probe. Uses a separate project/database, never production data.

Run from app root: PYTHONPATH=backend backend/.venv/bin/python scripts/probe_native_runs.py
"""
import asyncio
import json
import tempfile
import sys
from pathlib import Path

from app.config import Settings
from app.main import create_app
from app.models import Design
from app.schemas import Draft
from app.service import apply_draft
from app.agent_runs import NewAgentTask


async def main():
    directory = Path(tempfile.mkdtemp(prefix='ai-studio-native-')).resolve()
    settings = Settings(directory, f'sqlite:///{directory}/factory.db', '/Applications/ChatGPT.app/Contents/Resources/codex', '', 240, chat_reasoning_effort='low', run_timeout_seconds=240)
    app = create_app(settings)
    manager = app.state.agent_runs
    draft = Draft.model_validate({'name':'原生运行验证', 'goal':'验证节点成果', 'ready':True,
        'members':[{'key':'writer','name':'验证员工','role':'写入验证文件','kind':'ai','responsibilities':['写文件'],
            'instructions':'按任务说明写入 outputs/result.txt，内容为 NATIVE_OK。只写指定目录，不读取宿主资料。',
            'skills':[],'inputs':['任务'],'outputs':['result.txt']}],
        'workflow':[{'key':'write','name':'写入成果','owner':'writer','kind':'work','depends_on':[],
            'input':'固定字符串','output':'result.txt','acceptance':'内容为 NATIVE_OK'}],
        'requirements':[], 'assumptions':[], 'questions':[]})
    workflow = '--workflow' in sys.argv
    cancel = '--cancel' in sys.argv
    if cancel:
        draft.members[0].instructions = '先执行 python sleep(90)，然后写 outputs/result.txt 为 NATIVE_OK。此任务用于验证主动停止。'
    if workflow:
        from app.schemas import Step, Member
        template = draft.workflow[0].model_dump()
        draft.workflow = [Step.model_validate({**template, 'key':key, 'name':key, 'depends_on':deps}) for key, deps in [('a', []), ('b',['a']), ('c',['b']), ('d',['b'])]]
        draft.members.append(Member.model_validate({'key':'human','name':'验收人','role':'确认','kind':'human','responsibilities':[],'instructions':'','skills':[],'inputs':['结果'],'outputs':['确认']}))
        draft.workflow.append(Step.model_validate({**template,'key':'review','name':'人工验收','owner':'human','kind':'approval','depends_on':['c','d']}))
    with manager.sessions.begin() as db:
        project = Design(title='隔离验证'); db.add(project); db.flush()
        apply_draft(db, project.id, 0, draft, 'probe')
        project_id = project.id
    run = manager.create(project_id, NewAgentTask(title='native probe', description='请派生验证员工子智能体，在各节点 outputs/result.txt 写入 NATIVE_OK。工作流中 c 和 d 必须并行派发，均完成后请求人工验收。', scope='workflow' if workflow else 'node', node=None if workflow else 'write', request_id='probe'))
    print(json.dumps({'probe_directory':str(directory), 'run':run['id']}, ensure_ascii=False), flush=True)
    if cancel:
        from app.agent_models import AgentRun
        manager.launch(project_id, run['id'])
        for _ in range(900):
            await asyncio.sleep(.1)
            with manager.sessions() as db:
                row = db.get(AgentRun, run['id'])
                if row.state['nodes']['write']['thread_id']:
                    break
        else:
            await manager.shutdown()
            raise AssertionError('未派生子智能体')
        connection = manager.connections[run['id']]
        await manager.stop(project_id, run['id'])
        with manager.sessions() as db:
            row = db.get(AgentRun, run['id'])
            assert row.status == 'cancelled'
            assert not row.state['nodes']['write']['artifacts']
        assert connection.proc is None and not manager.tasks
        print('NATIVE CANCEL PROBE PASSED', flush=True)
        return
    await manager.execute(project_id, run['id'])
    if workflow:
        from app.agent_models import AgentRun
        import copy
        with manager.sessions.begin() as db:
            row = db.get(AgentRun, run['id'])
            assert row.status == 'waiting_human', row.state
            old_thread = row.thread_id
            old_children = set(row.state['children'])
            state = copy.deepcopy(row.state)
            state['nodes']['review'].update(status='completed', answer='确认通过')
            row.state = state
        # New connection, same persisted parent and definition, no repeated children.
        await manager.execute(project_id, run['id'])
    with manager.sessions() as db:
        task, result = manager.rows(db, project_id, run['id'])
        output = manager.describe(task, result)
        print(json.dumps(output, ensure_ascii=False, indent=2), flush=True)
        (directory / 'probe-result.json').write_text(json.dumps(output, ensure_ascii=False, indent=2))
        assert result.status == 'completed', result.state.get('error', result.state.get('reply'))
        for node in result.state['nodes'].values():
            if node['employee']['kind'] == 'ai':
                assert node['artifacts']
                for artifact in node['artifacts']:
                    assert (manager.directory(task, result) / artifact['path']).read_text().strip() == 'NATIVE_OK'
        if workflow:
            assert result.thread_id == old_thread and set(result.state['children']) == old_children
            assert len(old_children) == 4
            events = result.state['events']
            begun = {e['node']:i for i,e in enumerate(events) if e.get('tool') == 'begin'}
            finished = {e['node']:i for i,e in enumerate(events) if e.get('tool') == 'finish'}
            assert finished['a'] < begun['b'] and finished['b'] < min(begun['c'],begun['d'])
            assert max(begun['c'],begun['d']) < min(finished['c'],finished['d'])
        else:
            assert result.state['nodes']['write']['thread_id']
    print('NATIVE PROBE PASSED', flush=True)


if __name__ == '__main__':
    asyncio.run(main())
