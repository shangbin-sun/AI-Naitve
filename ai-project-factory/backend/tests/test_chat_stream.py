import asyncio
import json
import threading
import time

import pytest
from fastapi.testclient import TestClient

from app.chat_stream import partial_reply
from app.config import Settings
from app.main import create_app
from app.schemas import DesignResponse
from test_factory import DRAFT


@pytest.mark.parametrize('text', ['你好，团队！', '换行\n引号"反斜杠\\结束', 'emoji 😀 完成'])
@pytest.mark.parametrize('ascii', [True, False])
def test_partial_reply_at_every_split(text, ascii):
    raw = json.dumps({'reply': text, 'draft': {'reply': '不应显示'}}, ensure_ascii=ascii)
    previous = ''
    for i in range(len(raw)+1):
        value = partial_reply(raw[:i])
        assert text.startswith(value)
        assert value.startswith(previous)
        previous = value
    assert previous == text


def test_reply_after_other_field_and_incomplete_escape():
    assert partial_reply('{"draft":{"reply":"hidden"},"reply":"visible') == 'visible'
    assert partial_reply('{"reply":"hello\\uD83D') == 'hello'
    assert partial_reply('{"draft":{"reply":"hidden') == ''


class StreamRuntime:
    def __init__(self):
        self.ready = threading.Event()
        self.release = threading.Event()
        self.fail = False

    async def generate(self, context, on_event):
        await on_event({'type': 'reply', 'text': '正在输出'})
        self.ready.set()
        while not self.release.is_set():
            await asyncio.sleep(.01)
        if self.fail:
            raise RuntimeError('测试失败')
        await on_event({'type': 'reply', 'text': '正在输出完整回复'})
        return DesignResponse(reply='正在输出完整回复', draft=DRAFT), {}


@pytest.mark.parametrize('ending', ['completed', 'cancelled', 'failed', 'conflict'])
def test_stream_preview_and_terminal_state(tmp_path, ending):
    runtime = StreamRuntime()
    app = create_app(Settings(tmp_path, f'sqlite:///{tmp_path}/test.db', '', '', 5), runtime)
    with TestClient(app) as client:
        identity = client.post('/api/workspaces', json={'title': '流式测试'}).json()['id']
        job = client.post(f'/api/workspaces/{identity}/plan', json={'content': '设计团队', 'request_id': 'stream', 'expected_version': 0}).json()
        assert runtime.ready.wait(2)
        preview = client.get(f'/api/workspaces/{identity}').json()
        assert preview['jobs'][0]['proposal']['reply'] == '正在输出'
        assert preview['version'] == 0
        assert len(preview['messages']) == 1
        if ending == 'cancelled':
            client.post(f"/api/jobs/{job['id']}/cancel")
        else:
            if ending == 'conflict':
                client.put(f'/api/workspaces/{identity}/draft', json={'expected_version': 0, 'draft': DRAFT})
            runtime.fail = ending == 'failed'
            runtime.release.set()
        for _ in range(100):
            state = client.get(f'/api/workspaces/{identity}').json()
            if state['jobs'][0]['status'] == ending:
                break
            time.sleep(.02)
        assert state['jobs'][0]['status'] == ending
        assert len(state['messages']) == (2 if ending == 'completed' else 1)
        # A new/reconnected SSE client receives the full latest preview and terminal state.
        response = client.get(f"/api/jobs/{job['id']}/events")
        assert response.headers['content-type'].startswith('text/event-stream')
        snapshot = json.loads(response.text.split('data: ')[1])
        assert snapshot['status'] == ending
        assert snapshot['reply'].startswith('正在输出')
        assert client.get('/api/jobs/missing/events').status_code == 404


def test_timing_log_is_correlated_and_contains_no_chat_content(tmp_path):
    runtime = StreamRuntime()
    runtime.release.set()
    with TestClient(create_app(Settings(tmp_path, f'sqlite:///{tmp_path}/test.db', '', '', 5), runtime)) as client:
        identity = client.post('/api/workspaces', json={'title': 'SECRET_TITLE'}).json()['id']
        job = client.post(f'/api/workspaces/{identity}/messages', json={'content': 'SECRET_CONTENT', 'request_id': 'timing', 'expected_version': 0}).json()
        for _ in range(100):
            state = client.get(f'/api/workspaces/{identity}').json()
            if state['jobs'][0]['status'] == 'completed':
                break
            time.sleep(.02)
        client.get(f"/api/jobs/{job['id']}/events")
    raw = (tmp_path / 'chat-performance.jsonl').read_text()
    assert 'SECRET_CONTENT' not in raw and 'SECRET_TITLE' not in raw and '正在输出' not in raw
    events = [json.loads(line) for line in raw.splitlines()]
    assert all(e['job_id'] == job['id'] for e in events)
    summary = next(e for e in events if e['event'] == 'job_finished')
    assert summary['status'] == 'completed'
    stages = summary['stages_ms']
    assert stages['queue_acquired'] <= stages['context_ready'] <= stages['first_reply_persisted'] <= stages['save_committed']
    assert summary['counters']['reply_db_writes'] == 1
    assert any(e['event'] == 'sse_first_reply' for e in events)


def test_reply_completion_is_marked_before_draft_finishes():
    marks = []
    assert partial_reply('{"reply":"正文', lambda: marks.append(True)) == '正文'
    assert marks == []
    assert partial_reply('{"reply":"正文","draft":{', lambda: marks.append(True)) == '正文'
    assert marks == [True]


def test_lean_config_scopes_overrides_without_mutating_user_config():
    from app.chat_stream import lean_config
    original = {'mcp_servers': {'local': {'enabled': True}}, 'plugins': {'demo': {'enabled': True}}}
    catalog = {'data': [{'skills': [{'path': '/skills/example/SKILL.md'}]}]}
    config = lean_config(original, catalog)
    assert original['mcp_servers']['local']['enabled'] is True
    assert config['mcp_servers']['local']['enabled'] is False
    assert config['plugins']['demo']['enabled'] is False
    assert config['skills']['config'][0]['enabled'] is False
    assert config['features']['multi_agent'] is False


def test_conversation_does_not_create_revision_or_change_draft(tmp_path):
    from app.schemas import ChatResponse
    class ConversationRuntime:
        async def generate(self, context, on_event):
            await on_event({'type': 'reply', 'text': '解释现有方案'})
            return ChatResponse(reply='解释现有方案', draft=None), {}
    with TestClient(create_app(Settings(tmp_path, f'sqlite:///{tmp_path}/test.db', '', '', 5), ConversationRuntime())) as client:
        identity = client.post('/api/workspaces', json={'title': '测试'}).json()['id']
        client.put(f'/api/workspaces/{identity}/draft', json={'expected_version': 0, 'draft': DRAFT})
        before = client.get(f'/api/workspaces/{identity}').json()
        client.post(f'/api/workspaces/{identity}/messages', json={'content': '解释方案，不要修改', 'request_id': 'chat', 'expected_version': before['version']})
        for _ in range(100):
            after = client.get(f'/api/workspaces/{identity}').json()
            if after['jobs'][0]['status'] == 'completed': break
            time.sleep(.01)
        assert after['jobs'][0]['status'] == 'completed'
        assert after['draft'] == before['draft'] and after['version'] == before['version']
        assert after['employees'] == before['employees']
        assert after['messages'][-1]['content'] == '解释现有方案'
        assert after['jobs'][0]['proposal']['draft'] is None


def test_coalesced_reply_flushes_latest_text_on_cancel(tmp_path):
    class BurstRuntime:
        ready = threading.Event()
        async def generate(self, context, on_event):
            await on_event({'type': 'reply', 'text': '第一段'})
            await on_event({'type': 'reply', 'text': '第一段和最后一段'})
            self.ready.set()
            await asyncio.sleep(100)
    runtime = BurstRuntime()
    app = create_app(Settings(tmp_path, f'sqlite:///{tmp_path}/test.db', '', '', 5), runtime)
    with TestClient(app) as client:
        identity = client.post('/api/workspaces', json={'title': '测试'}).json()['id']
        job = client.post(f'/api/workspaces/{identity}/messages', json={'content': 'test', 'request_id': 'burst', 'expected_version': 0}).json()
        assert runtime.ready.wait(2)
        assert app.state.manager.previews[job['id']] == '第一段和最后一段'
        result = client.post(f"/api/jobs/{job['id']}/cancel").json()
        assert result['proposal']['reply'] == '第一段和最后一段'
        assert job['id'] not in app.state.manager.previews
        assert job['id'] not in app.state.manager.preview_written_at


def test_browser_timing_accepts_only_bounded_content_free_metrics(tmp_path):
    runtime = StreamRuntime()
    runtime.release.set()
    with TestClient(create_app(Settings(tmp_path, f'sqlite:///{tmp_path}/test.db', '', '', 5), runtime)) as client:
        identity = client.post('/api/workspaces', json={'title': '测试'}).json()['id']
        job = client.post(f'/api/workspaces/{identity}/messages', json={'content': 'test', 'request_id': 'browser', 'expected_version': 0}).json()
        path = f"/api/jobs/{job['id']}/browser-timing"
        assert client.post(path, json={'event': 'first_reply_received', 'elapsed_ms': 120.5}).status_code == 204
        assert client.post(path, json={'event': 'body', 'elapsed_ms': 120.5}).status_code == 422
        assert client.post(path, json={'event': 'frame_after_reply', 'elapsed_ms': -1}).status_code == 422
        assert client.post('/api/jobs/missing/browser-timing', json={'event': 'frame_after_reply', 'elapsed_ms': 10}).status_code == 404
    events = [json.loads(line) for line in (tmp_path/'chat-performance.jsonl').read_text().splitlines()]
    assert any(e['event'] == 'browser_first_reply_received' and e['connection_elapsed_ms'] == 120.5 for e in events)
