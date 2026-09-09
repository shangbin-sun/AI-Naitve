import asyncio
import json

import pytest
from fastapi.testclient import TestClient

from app.codex_session import CodexConnection
from app.config import Settings
from app.main import create_app
from app.runtime import CodexRuntime
from test_factory import DRAFT


class MemoryConnection(CodexConnection):
    """Protocol peer: records exact wire payloads and emits interleaved turn events."""
    def __init__(self, settings, history=None):
        super().__init__(settings)
        self.history = history if history is not None else {}
        self.calls = []
        self.live_turns = {}
        self.closed = False

    async def ensure(self):
        self.config = {}
        self.closed = False

    async def close(self):
        self.closed = True
        self.loaded.clear()

    async def rpc(self, method, params):
        self.calls.append((method, params))
        if method == 'thread/start':
            identity = f'thread-{len(self.history)}'
            self.history[identity] = []
            return {'thread': {'id': identity}, 'model': 'test'}
        identity = params.get('threadId')
        if method in ('thread/resume', 'thread/read'):
            if identity not in self.history:
                raise RuntimeError('missing thread')
            return {'thread': {'id': identity, 'status': {'type': 'idle'}}}
        if method == 'thread/inject_items':
            self.history[identity].extend(params['items'])
            return {}
        if method == 'thread/fork':
            new_id = f'thread-{len(self.history)}'
            self.history[new_id] = self.history[identity].copy()
            return {'thread': {'id': new_id}}
        if method == 'turn/interrupt':
            self.queues[identity].put_nowait({'method': 'turn/completed', 'params': {'threadId': identity, 'turn': {'id': params['turnId'], 'status': 'interrupted'}}})
            return {}
        if method == 'turn/start':
            turn = f'turn-{len(self.calls)}'
            self.history[identity].append(params['input'])
            self.live_turns[identity] = turn
            text = params['input'][0]['text']
            if text != 'HOLD':
                queue = self.queues[identity]
                if text == 'COMPACT':
                    for lifecycle in ('started', 'completed'):
                        queue.put_nowait({'method': f'item/{lifecycle}', 'params': {'threadId': identity, 'turnId': turn, 'item': {'type': 'contextCompaction'}}})
                reply = json.dumps({'reply': '方案已生成', 'draft': DRAFT}, ensure_ascii=False) if 'outputSchema' in params else '原样回复：' + text
                for piece in (reply[:3], reply[3:]):
                    queue.put_nowait({'method': 'item/agentMessage/delta', 'params': {'threadId': identity, 'turnId': turn, 'itemId': 'answer', 'delta': piece}})
                queue.put_nowait({'method': 'thread/tokenUsage/updated', 'params': {'threadId': identity, 'tokenUsage': {'last': {'inputTokens': 10}, 'total': {'inputTokens': 999}}}})
                queue.put_nowait({'method': 'item/completed', 'params': {'threadId': identity, 'turnId': turn, 'item': {'id': 'answer', 'type': 'agentMessage', 'text': reply}}})
                queue.put_nowait({'method': 'turn/completed', 'params': {'threadId': identity, 'turn': {'id': turn, 'status': 'completed'}}})
            return {'turn': {'id': turn}}
        return {}


def runtime(tmp_path, history=None):
    settings = Settings(tmp_path, f'sqlite:///{tmp_path}/db.sqlite', 'unused', '', 5)
    value = CodexRuntime(settings)
    connection = MemoryConnection(settings, history)
    value.chat_connection = connection
    return settings, value, connection


def wait(client, identity):
    import time
    for _ in range(100):
        result = client.get(f'/api/workspaces/{identity}').json()
        if result['jobs'][0]['status'] not in ('queued', 'running'):
            return result
        time.sleep(.01)
    pytest.fail('job did not finish')


def test_exact_incremental_input_restart_and_separate_plan(tmp_path):
    settings, value, connection = runtime(tmp_path)
    with TestClient(create_app(settings, value)) as client:
        identity = client.post('/api/workspaces', json={'title': '项目'}).json()['id']
        client.post(f'/api/workspaces/{identity}/messages', json={'content': '  第一条\n原样  ', 'request_id': 'one', 'expected_version': 0})
        first = wait(client, identity)
        thread = first['codex_conversation']['thread_id']
        assert first['draft'] == {} and first['version'] == 0
        client.post(f'/api/workspaces/{identity}/messages', json={'content': '第二条', 'request_id': 'two', 'expected_version': 0})
        second = wait(client, identity)
        assert second['codex_conversation']['thread_id'] == thread
        turns = [params for method, params in connection.calls if method == 'turn/start']
        assert turns[0]['input'][0] == {'type': 'text', 'text': '  第一条\n原样  '}
        assert '界面上下文' in turns[0]['input'][1]['text']
        assert 'current_draft' not in turns[0]['input'][1]['text']
        assert turns[1]['input'][0] == {'type': 'text', 'text': '第二条'}
        assert all('outputSchema' not in params for params in turns)
        assert second['jobs'][0]['usage']['input_tokens'] == 10
        client.post(f'/api/workspaces/{identity}/plan', json={'content': '生成方案', 'request_id': 'plan', 'expected_version': 0})
        plan = wait(client, identity)
        assert plan['draft'] == DRAFT and plan['version'] == 1
        assert plan['codex_conversation']['thread_id'] == thread
        last = [params for method, params in connection.calls if method == 'turn/start'][-1]
        assert last['threadId'] != thread and 'outputSchema' in last
    settings, value, restored = runtime(tmp_path, connection.history)
    with TestClient(create_app(settings, value)) as client:
        client.post(f'/api/workspaces/{identity}/messages', json={'content': '重启后的增量', 'request_id': 'resume', 'expected_version': 1})
        result = wait(client, identity)
        assert result['codex_conversation']['thread_id'] == thread
        assert any(method == 'thread/resume' for method, _ in restored.calls)
        assert not any(method == 'thread/start' for method, _ in restored.calls)
        assert result['draft'] == DRAFT


def test_legacy_import_once_and_new_images_only(tmp_path):
    from app.models import Message
    from test_chat import upload
    settings, value, connection = runtime(tmp_path)
    app = create_app(settings, value)
    with TestClient(app) as client:
        identity = client.post('/api/workspaces', json={'title': '旧项目'}).json()['id']
        with app.state.sessions.begin() as db:
            db.add(Message(design_id=identity, role='user', content='旧历史'))
            db.add(Message(design_id=identity, role='assistant', content='旧回复'))
        image, _ = upload(client, identity)
        client.post(f'/api/workspaces/{identity}/messages', json={'content': '新图片', 'attachment_ids': [image['id']], 'request_id': 'image', 'expected_version': 0})
        result = wait(client, identity)
        assert result['codex_conversation']['imported_messages'] == 2
        client.post(f'/api/workspaces/{identity}/messages', json={'content': '后续', 'request_id': 'next', 'expected_version': 0})
        wait(client, identity)
        imports = [params for method, params in connection.calls if method == 'thread/inject_items']
        assert len(imports) == 1 and len(imports[0]['items']) == 2
        turns = [params for method, params in connection.calls if method == 'turn/start']
        assert len(turns[0]['input']) == 3 and len(turns[1]['input']) == 2


def test_markdown_and_image_reach_separate_codex_inputs(tmp_path):
    import base64
    from test_chat import upload
    settings, value, connection = runtime(tmp_path)
    with TestClient(create_app(settings, value)) as client:
        identity = client.post('/api/workspaces', json={'title': '附件回归'}).json()['id']
        text = '# 整理日志\n识别码：MD-4827，已完成数据校验。'
        doc = client.post(f'/api/workspaces/{identity}/chat-attachments', json={
            'name': '整理日志.md', 'data': base64.b64encode(text.encode()).decode(),
        })
        assert doc.status_code == 201
        picture, _ = upload(client, identity)
        result = client.post(f'/api/workspaces/{identity}/messages', json={
            'content': '读取附件', 'attachment_ids': [doc.json()['id'], picture['id']],
            'request_id': 'mixed', 'expected_version': 0,
        })
        assert result.status_code == 202
        wait(client, identity)
        inputs = next(params['input'] for method, params in connection.calls if method == 'turn/start')
        images = [item for item in inputs if item['type'] == 'image']
        assert len(images) == 1 and images[0]['url'].startswith('data:image/png;base64,')
        documents = [item['text'] for item in inputs if item['type'] == 'text' and 'MD-4827' in item['text']]
        assert len(documents) == 1 and '整理日志.md' in documents[0]
        client.post(f'/api/workspaces/{identity}/messages', json={'content': '继续', 'request_id': 'next', 'expected_version': 0})
        wait(client, identity)
        latest = [params['input'] for method, params in connection.calls if method == 'turn/start'][-1]
        assert not any('MD-4827' in item.get('text', '') or item['type'] == 'image' for item in latest)


def test_cancellation_isolated_compaction_events_and_missing_resume(tmp_path):
    async def scenario():
        _, value, connection = runtime(tmp_path)
        ready = asyncio.Event()
        events = []
        async def emit(event):
            events.append(event)
            if isinstance(event, dict) and event['type'] == 'turn':
                ready.set()
        base = {'mode': 'chat', 'thread_id': None, 'legacy': [], 'chat_images': [], 'message_id': 'm'}
        held = asyncio.create_task(value.generate({**base, 'message': 'HOLD'}, emit))
        await ready.wait()
        response, _ = await value.generate({**base, 'message': 'COMPACT'}, emit)
        assert response.reply == '原样回复：COMPACT'
        assert 'Codex 正在压缩会话历史…' in events
        held.cancel()
        with pytest.raises(asyncio.CancelledError):
            await held
        assert any(method == 'turn/interrupt' for method, _ in connection.calls)
        assert not connection.closed and not connection.queues
        count = len([1 for method, _ in connection.calls if method == 'thread/start'])
        with pytest.raises(RuntimeError, match='missing'):
            await value.generate({**base, 'thread_id': 'missing', 'message': 'no retry'}, emit)
        assert len([1 for method, _ in connection.calls if method == 'thread/start']) == count
        await value.close()
    asyncio.run(scenario())


def test_employee_reference_is_separate_from_user_text_and_mcp_is_project_scoped(tmp_path):
    settings, value, connection = runtime(tmp_path)
    with TestClient(create_app(settings, value)) as client:
        project = client.post('/api/workspaces', json={'title': '项目'}).json()['id']
        client.put(f'/api/workspaces/{project}/draft', json={'expected_version':0, 'draft':DRAFT})
        employee = client.get(f'/api/workspaces/{project}').json()['employees'][0]
        client.post(f'/api/workspaces/{project}/messages', json={'content':'优化输出', 'employee_id':employee['id'], 'request_id':'ref', 'expected_version':1})
        result = wait(client, project)
        assert result['messages'][0]['content'] == '优化输出'
        assert result['messages'][0]['employee_reference']['id'] == employee['id']
        turn = next(p for m,p in connection.calls if m=='turn/start')
        assert turn['input'][0]['text']=='优化输出'
        assert employee['id'] in turn['input'][1]['text']
        start = next(p for m,p in connection.calls if m=='thread/start')
        assert start['config']['mcp_servers']['project_factory']['env']['FACTORY_TOOL_PROJECT']==project
        assert '先读最新版本再修改' in start['baseInstructions']
