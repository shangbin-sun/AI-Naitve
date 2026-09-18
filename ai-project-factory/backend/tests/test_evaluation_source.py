import copy
import base64
import hashlib
import json
import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from app.agent_models import AgentRun, AgentTask
from app.employee_evaluation import SourceSelection
from app.employee_evaluation import RunCreate, EmployeeEvaluationRecord
from app.models import Employee
from test_agent_runs import manager, create
from test_employee_evaluation import endpoint
from test_employee_ability import WORKFLOW


def ready(manager):
    with manager.sessions.begin() as db:
        employee = db.query(Employee).one()
        employee.files = {**employee.files, 'workflow.json': json.dumps(WORKFLOW)}
        eid = employee.id
    source = create(manager, 'node')
    with manager.sessions.begin() as db:
        run = db.get(AgentRun, source['id'])
        root = manager.directory(db.get(AgentTask, run.task_id), run)
        path = root / 'nodes/analyze/attempts/a1'
        (path / 'inputs').mkdir(parents=True)
        (path / 'outputs').mkdir()
        (path / 'inputs/context.json').write_text(json.dumps({'task': {'description': '原始输入', 'acceptance': '结论有依据'}, 'upstream': {}}))
        output = path / 'outputs/result.txt'
        output.write_text('实际输出内容')
        state = copy.deepcopy(run.state)
        state['nodes']['analyze'].update(status='completed', attempt='a1', summary='不能使用这段摘要',
            artifacts=[{'path': str(output.relative_to(root)), 'sha256': hashlib.sha256(output.read_bytes()).hexdigest()}])
        run.state = state
    return eid, SourceSelection(run_id=source['id'], node_key='analyze'), path


def test_automatic_preview_and_create_freeze_real_files_and_workflow(manager):
    eid, selection, path = ready(manager)
    preview = endpoint(manager, '/source-preview', 'POST')(eid, selection)
    assert '原始输入' in preview['input_text']
    assert preview['output_files'][0]['name'] == 'result.txt'
    assert '实际输出内容' not in preview['reference']
    assert '不能使用这段摘要' not in preview['reference']
    assert preview['source_workflow']['title'] == WORKFLOW['title']
    assert preview['checks'][0]['kind'] == 'manual'
    selection.preview_digest = preview['digest']
    case = endpoint(manager, '/cases/from-task', 'POST')(eid, selection)
    assert case['digest'] == preview['digest']
    with manager.sessions.begin() as db:
        e = db.get(Employee, eid)
        e.files = {**e.files, 'workflow.json': json.dumps({**WORKFLOW, 'title': '新流程'})}
    assert endpoint(manager, '/source-preview', 'POST')(eid, selection)['source_workflow']['title'] == WORKFLOW['title']
    (path / 'outputs/result.txt').write_text('篡改输出')
    assert (manager.settings.data_dir/'employees'/eid/'evaluations'/case['id']/'reference/result.txt').read_text() == '实际输出内容'
    with pytest.raises(HTTPException, match='任务证据已变化'):
        endpoint(manager, '/cases/from-task', 'POST')(eid, selection)


@pytest.mark.parametrize('missing', ['input', 'output', 'incomplete', 'escape'])
def test_missing_or_unsupported_evidence_fails_explicitly(manager, missing):
    eid, selection, path = ready(manager)
    with manager.sessions.begin() as db:
        run = db.get(AgentRun, selection.run_id)
        state, snapshot = copy.deepcopy(run.state), copy.deepcopy(run.snapshot)
        if missing == 'incomplete': state['nodes']['analyze']['status'] = 'pending'
        if missing == 'escape': (path/'outputs/escape').symlink_to(path/'inputs/context.json')
        if missing == 'binary':
            data = b'\xff\x00'
            (path / 'outputs/result.txt').write_bytes(data)
            state['nodes']['analyze']['artifacts'][0]['sha256'] = hashlib.sha256(data).hexdigest()
        run.state, run.snapshot = state, snapshot
    if missing == 'input': (path / 'inputs/context.json').unlink()
    if missing == 'output': (path / 'outputs/result.txt').unlink()
    with pytest.raises(HTTPException) as error:
        endpoint(manager, '/source-preview', 'POST')(eid, selection)
    assert error.value.status_code == 422


def test_create_requires_matching_preview(manager):
    eid, selection, _ = ready(manager)
    with pytest.raises(HTTPException) as error:
        endpoint(manager, '/cases/from-task', 'POST')(eid, selection)
    assert error.value.status_code == 409


def test_missing_historical_workflow_does_not_block_case(manager):
    eid, selection, _ = ready(manager)
    with manager.sessions.begin() as db:
        run = db.get(AgentRun, selection.run_id)
        snapshot = copy.deepcopy(run.snapshot)
        del snapshot['definition']['employees']['analyst']['files']['workflow.json']
        run.snapshot = snapshot
    preview = endpoint(manager, '/source-preview', 'POST')(eid, selection)
    assert preview['source_workflow'] is None
    assert preview['output_files'][0]['name'] == 'result.txt'
    selection.preview_digest = preview['digest']
    saved = endpoint(manager, '/cases/from-task', 'POST')(eid, selection)
    assert saved['source_workflow'] is None
    assert saved['checks']


def test_extracts_frozen_attachments_and_upstream_files(manager):
    eid, selection, path = ready(manager)
    root = path.parents[3]
    attachment = root / 'inputs/files/source.txt'
    attachment.parent.mkdir(parents=True, exist_ok=True)
    attachment.write_text('附件真实内容')
    upstream = root / 'handoffs/upstream.txt'
    upstream.parent.mkdir(parents=True, exist_ok=True)
    upstream.write_text('上游真实交付物')
    ctx = json.loads((path / 'inputs/context.json').read_text())
    ctx['task']['attachments'] = [{'name': 'source.txt', 'path': 'inputs/files/source.txt'}]
    ctx['upstream'] = {'previous': [{'path': 'handoffs/upstream.txt', 'sha256': hashlib.sha256(upstream.read_bytes()).hexdigest()}]}
    (path / 'inputs/context.json').write_text(json.dumps(ctx))
    with manager.sessions.begin() as db:
        run = db.get(AgentRun, selection.run_id)
        state = copy.deepcopy(run.state)
        state['task_inputs']['attachments'] = [{'name': 'source.txt', 'data': base64.b64encode(attachment.read_bytes()).decode()}]
        run.state = state
    preview = endpoint(manager, '/source-preview', 'POST')(eid, selection)
    assert len(preview['input_files']) == 2
    assert '附件真实内容' not in preview['input_text']
    assert '上游真实交付物' not in preview['input_text']
    upstream.unlink()
    with pytest.raises(HTTPException):
        endpoint(manager, '/source-preview', 'POST')(eid, selection)


def test_file_evaluation_preserves_binary_and_compares_all_text_outputs(manager):
    eid, selection, path = ready(manager)
    (path/'outputs/second.md').write_text('第二份文档')
    (path/'outputs/image.png').write_bytes(b'\x89PNG\x00\xff')
    (path/'outputs/disguised.txt').write_bytes(b'\xff\x00')
    preview = endpoint(manager, '/source-preview', 'POST')(eid, selection)
    assert len(preview['output_files']) == 4
    assert sum(f['text'] for f in preview['output_files']) == 2
    selection.preview_digest = preview['digest']
    case = endpoint(manager, '/cases/from-task', 'POST')(eid, selection)
    service = manager.app.state.employee_evaluations
    calls = []
    async def model(bundle, text, directory, config, schema=None):
        calls.append(Path(directory))
        if schema:
            assert '非文本文件不参与评测' in text
            return schema.model_validate({'conclusion':'更新了输出','objectives':[{'name':'完成文档','weight':100,'completion':80,
                'reason':'有文档','gap':'待完善','evidence':[{'file_id':'actual/result.txt','quote':'更新的输出'}]}],
                'matches':[{'reference_ids':['reference/result.txt'],'actual_ids':['actual/result.txt'],'reason':'内容对应'}],
                'improvements':['更新了输出'],'regressions':[]}),{},[]
        assert config['mode'] == 'files'
        assert (directory/'inputs/task.json').is_file()
        assert not (directory/'reference').exists()
        assert '第二份文档' not in text
        (directory/'outputs/result.txt').write_text('更新的输出')
        (directory/'outputs/second.md').write_text('第二份文档')
        (directory/'outputs/new.png').write_bytes(b'\x89PNG\x00')
        return SimpleNamespace(reply='完成文件生成'), {}, []
    service.call = model
    with manager.sessions() as db:
        version = db.get(Employee,eid).version
    async def run():
        created = await endpoint(manager, '/runs', 'POST')(eid, RunCreate(case_ids=[case['id']],expected_version=version))
        await service.tasks[created['id']]
        with manager.sessions() as db:
            row = db.get(EmployeeEvaluationRecord, created['id'])
            assert row.status == 'completed', row.data.get('error')
            result = row.data['results'][0]
            assert len(result['output_files']) == 3
            assert result['report']['completion_percent'] == 80
            assert len(result['report']['excluded_files']) == 3
            assert result['report']['status'] == 'estimated'
        archive = service.record_root(eid,created['id'])/'outputs'/case['id']
        assert (archive/'new.png').read_bytes() == b'\x89PNG\x00'
        count = len(calls)
        repeated = await endpoint(manager, '/runs/{run_id}/recompare', 'POST')(eid,created['id'])
        await service.tasks[repeated['id']]
        assert len(calls) == count + 1  # Judge only; no employee re-execution.
        with manager.sessions() as db:
            row = db.get(EmployeeEvaluationRecord,repeated['id'])
            assert row.status == 'completed', row.data.get('error')
            assert row.data['results'][0]['report']['completion_percent'] == 80
    asyncio.run(run())
    assert all(not p.exists() for p in calls)
    reference = service.record_root(eid,case['id'])/'reference'
    assert (reference/'image.png').read_bytes() == b'\x89PNG\x00\xff'
    (reference/'result.txt').write_text('changed')
    with pytest.raises(ValueError, match='快照文件已变化'):
        from app.evaluation_files import verify_snapshot
        verify_snapshot(reference,case['output_files'])


def test_file_model_call_uses_restricted_read_roots(manager, tmp_path):
    service = manager.app.state.employee_evaluations
    seen = {}
    class Connection:
        config = {}
        async def ensure(self): pass
        async def close(self): seen['closed'] = True
        async def rpc(self, method, params):
            seen['start'] = params
            return {'thread':{'id':'t'}}
        async def run_turn(self, *args, **kwargs):
            seen['turn'] = kwargs
            return SimpleNamespace(reply='done'), {}
    service.connection_factory = lambda _:Connection()
    asyncio.run(service.call('rules','read inputs',tmp_path,{'mode':'files','model':'gpt-5.6-luna'}))
    assert 'sandbox_policy' not in seen['turn']
    assert 'sandbox' not in seen['start']
    assert seen['start']['permissions'] == 'aiteam-evaluation'
    policy = seen['start']['config']['permissions']['aiteam-evaluation']
    assert policy['filesystem'] == {':minimal':'read', str(tmp_path):'write', str(tmp_path/'inputs'):'read'}
    assert policy['network']['enabled'] is False
    assert seen['start']['config']['features']['multi_agent'] is False
    assert seen['closed']
