import asyncio
import copy
from pathlib import Path

import pytest
from fastapi import HTTPException

from app.agent_models import AgentRun
from app.employee_evaluation import ChatEvaluationCreate, EmployeeEvaluationRecord
from app.models import Employee
from test_agent_runs import manager, create
from test_employee_evaluation import setup, complete_node, endpoint


def chat_endpoint(manager):
    path = '/api/workspaces/{project}/agent-runs/{run_id}/nodes/{key}/tuning/evaluation'
    return next(route.endpoint for route in manager.app.routes
                if getattr(route, 'path', None) == path and 'POST' in route.methods)


def ready(manager):
    source, employee, version = setup(manager)
    complete_node(manager, source)
    return source, employee, version


def fake_execution(service):
    calls = []

    async def execute(identity):
        calls.append(identity)
        service.update(identity, status='completed')
        service.tasks.pop(identity, None)

    service.execute = execute
    return calls


def test_chat_reuses_imported_case_with_latest_saved_employee_and_keeps_task_unchanged(manager):
    source, employee_id, version = ready(manager)
    case = next(row for row in endpoint(manager)(employee_id) if row['kind'] == 'case')
    service = manager.app.state.employee_evaluations
    calls = fake_execution(service)
    with manager.sessions.begin() as db:
        employee = db.get(Employee, employee_id)
        employee.version += 1
        run = db.get(AgentRun, source['id'])
        original_state, original_snapshot = copy.deepcopy(run.state), copy.deepcopy(run.snapshot)
        original_case = copy.deepcopy(db.get(EmployeeEvaluationRecord, case['id']).data)
        original_run_ids = {row.id for row in db.query(AgentRun)}
    # The task case is immutable and already imported; its old source need not be read again.
    for path in Path(source['directory']).glob('nodes/*/attempts/*/outputs/result.md'):
        path.unlink()

    async def run():
        result = await chat_endpoint(manager)(manager.project_id, source['id'], 'analyze', ChatEvaluationCreate(request_id='click-one'))
        await service.tasks[result['run_id']]
        return result

    result = asyncio.run(run())
    assert result['employee_id'] == employee_id
    assert result['employee_version'] == version + 1
    assert result['case_id'] == case['id']
    assert result['reused'] is False
    assert calls == [result['run_id']]
    with manager.sessions() as db:
        row = db.get(EmployeeEvaluationRecord, result['run_id'])
        assert row.kind == 'run' and row.status == 'completed'
        assert row.data['employee_version'] == version + 1
        assert [item['id'] for item in row.data['cases']] == [case['id']]
        assert db.get(EmployeeEvaluationRecord, case['id']).data == original_case
        assert db.get(AgentRun, source['id']).state == original_state
        assert db.get(AgentRun, source['id']).snapshot == original_snapshot
        assert {row.id for row in db.query(AgentRun)} == original_run_ids
        assert db.query(EmployeeEvaluationRecord).filter_by(kind='case').count() == 1


def test_chat_imports_only_its_own_completed_case_when_not_yet_synced(manager):
    source, employee, _ = ready(manager)
    another = create(manager, 'node', 'another-task')
    complete_node(manager, another)
    service = manager.app.state.employee_evaluations
    fake_execution(service)

    async def run():
        result = await chat_endpoint(manager)(manager.project_id, source['id'], 'analyze', ChatEvaluationCreate(request_id='import'))
        await service.tasks[result['run_id']]
        return result

    result = asyncio.run(run())
    with manager.sessions() as db:
        cases = db.query(EmployeeEvaluationRecord).filter_by(employee_id=employee, kind='case').all()
        assert len(cases) == 1
        assert cases[0].id == result['case_id']
        assert cases[0].data['run_id'] == source['id']
    assert (service.record_root(employee, result['case_id'])/'reference/result.md').read_text() == '真实任务输出'


def test_chat_deduplicates_concurrent_clicks_and_persisted_retries_but_allows_next_evaluation(manager):
    source, _, _ = ready(manager)
    service = manager.app.state.employee_evaluations
    calls = []

    async def run():
        gate = asyncio.Event()

        async def execute(identity):
            calls.append(identity)
            await gate.wait()
            service.update(identity, status='completed')
            service.tasks.pop(identity, None)

        service.execute = execute
        start = chat_endpoint(manager)
        first, second = await asyncio.gather(*[
            start(manager.project_id, source['id'], 'analyze', ChatEvaluationCreate(request_id=request))
            for request in ('click-one', 'click-two')])
        assert first['run_id'] == second['run_id']
        assert second['reused'] is True
        assert len(service.tasks) == 1
        service.tasks['occupied-slot'] = asyncio.create_task(gate.wait())
        retry = await start(manager.project_id, source['id'], 'analyze', ChatEvaluationCreate(request_id='click-one'))
        reopen = await start(manager.project_id, source['id'], 'analyze', ChatEvaluationCreate(request_id='click-three'))
        assert retry['run_id'] == reopen['run_id'] == first['run_id']
        tasks = list(service.tasks.values())
        gate.set()
        await asyncio.gather(*tasks)
        service.tasks.pop('occupied-slot')
        # A lost-response retry remains idempotent even after completion.
        replay = await start(manager.project_id, source['id'], 'analyze', ChatEvaluationCreate(request_id='click-two'))
        assert replay['run_id'] == first['run_id']
        fresh = await start(manager.project_id, source['id'], 'analyze', ChatEvaluationCreate(request_id='next-evaluation'))
        assert fresh['run_id'] != first['run_id']
        await service.tasks[fresh['run_id']]
        assert calls == [first['run_id'], fresh['run_id']]

    asyncio.run(run())
    with manager.sessions() as db:
        assert db.query(EmployeeEvaluationRecord).filter_by(kind='case').count() == 1
        assert db.query(EmployeeEvaluationRecord).filter_by(kind='run').count() == 2


@pytest.mark.parametrize('status', ['failed', 'interrupted', 'running'])
def test_chat_rejects_unready_source_without_creating_fake_case(manager, status):
    source, _, _ = ready(manager)
    with manager.sessions.begin() as db:
        run = db.get(AgentRun, source['id'])
        state = copy.deepcopy(run.state)
        state['nodes']['analyze']['status'] = status
        run.state = state
    with pytest.raises(HTTPException) as error:
        asyncio.run(chat_endpoint(manager)(manager.project_id, source['id'], 'analyze', ChatEvaluationCreate(request_id='bad-source')))
    assert error.value.status_code == (409 if status == 'running' else 422)
    with manager.sessions() as db:
        assert db.query(EmployeeEvaluationRecord).count() == 0


@pytest.mark.parametrize('scope', ['another-team', 'unknown-node', 'missing-identity', 'inactive-employee'])
def test_chat_validates_team_node_and_frozen_employee_identity(manager, scope):
    source, employee, _ = ready(manager)
    with manager.sessions.begin() as db:
        if scope == 'missing-identity':
            run = db.get(AgentRun, source['id'])
            snapshot = copy.deepcopy(run.snapshot)
            snapshot['definition']['employees']['analyst'].pop('id')
            run.snapshot = snapshot
        if scope == 'inactive-employee':
            db.get(Employee, employee).active = False
    with pytest.raises(HTTPException) as error:
        asyncio.run(chat_endpoint(manager)(
            'another-team' if scope == 'another-team' else manager.project_id,
            source['id'], 'unknown' if scope == 'unknown-node' else 'analyze',
            ChatEvaluationCreate(request_id='invalid-scope')))
    assert error.value.status_code == (422 if scope == 'missing-identity' else 404)
    assert not manager.app.state.employee_evaluations.tasks


def test_chat_request_id_cannot_be_reused_for_another_conversation(manager):
    source, _, _ = ready(manager)
    other = create(manager, 'node', 'other-conversation')
    service = manager.app.state.employee_evaluations
    fake_execution(service)

    async def run():
        start = chat_endpoint(manager)
        result = await start(manager.project_id, source['id'], 'analyze', ChatEvaluationCreate(request_id='same-request'))
        await service.tasks[result['run_id']]
        with pytest.raises(HTTPException) as error:
            await start(manager.project_id, other['id'], 'analyze', ChatEvaluationCreate(request_id='same-request'))
        assert error.value.status_code == 409

    asyncio.run(run())
