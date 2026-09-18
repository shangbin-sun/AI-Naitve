import asyncio

import pytest

from app.codex_session import CodexConnection
from app.config import Settings


@pytest.mark.parametrize('value', [None, '', '   ', 'gpt-5.6-luna'])
def test_default_model_is_luna(monkeypatch, value):
    if value is None:
        monkeypatch.delenv('CODEX_MODEL', raising=False)
    else:
        monkeypatch.setenv('CODEX_MODEL', value)
    assert Settings.from_env().codex_model == 'gpt-5.6-luna'


def test_explicit_deployment_override(monkeypatch):
    monkeypatch.setenv('CODEX_MODEL', 'deployment-model')
    assert Settings.from_env().codex_model == 'deployment-model'


@pytest.mark.parametrize('method', ['thread/start', 'thread/resume', 'thread/fork', 'turn/start', 'thread/read'])
def test_model_selection_on_wire(monkeypatch, method):
    monkeypatch.delenv('CODEX_MODEL', raising=False)

    async def check():
        connection = CodexConnection(Settings.from_env())
        sent = []

        async def send(payload):
            sent.append(payload)
            connection.pending[payload['id']].set_result({})

        connection.send = send
        params = {'threadId': 'existing-thread'}
        if method != 'thread/read':
            params['model'] = 'previous-model'
        original = params.copy()
        await connection.rpc(method, params)
        assert params == original
        if method == 'thread/read':
            assert 'model' not in sent[0]['params']
        else:
            assert sent[0]['params']['model'] == 'gpt-5.6-luna'

    asyncio.run(check())
