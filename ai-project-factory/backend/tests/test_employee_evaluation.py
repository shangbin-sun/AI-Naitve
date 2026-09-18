import asyncio
import copy
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from app.agent_models import AgentRun
from app.employee_evaluation import CaseCreate, Check, RunCreate, Adopt, EmployeeEvaluationRecord, compare_output
from app.models import Employee, Design
from app.schemas import Draft
from app.service import apply_draft
from test_agent_runs import manager, create, active, control, child
from test_factory import DRAFT
from test_employee_ability import WORKFLOW


def endpoint(manager, suffix='', method='GET'):
    path = '/api/employees/{employee_id}/evaluation' + suffix
    return next(r.endpoint for r in manager.app.routes if getattr(r, 'path', None) == path and method in r.methods)


def setup(manager):
    source = create(manager, 'node')
    with manager.sessions.begin() as db:
        employee = db.query(Employee).one()
        employee.files = {**employee.files, 'workflow.json': json.dumps(WORKFLOW)}
        identity, version = employee.id, employee.version
    return source, identity, version


def make_case(manager, employee, source, **changes):
    body = dict(run_id=source['id'], node_key='analyze', title='任务案例', input_text='计算 2+2，只返回数字',
                reference='PRIVATE_REFERENCE', reference_status='confirmed', acknowledge_source_access=True,
                checks=[Check(name='结果', kind='number', expected='4', tolerance=0)])
    return endpoint(manager, '/cases', 'POST')(employee, CaseCreate(**{**body, **changes}))


def complete_node(manager, run):
    active(manager, run)
    begun = control(manager, run, 'begin', node='analyze')
    child(manager, run)
    (Path(begun['attempt_path']) / 'outputs' / 'result.md').write_text('真实任务输出')
    control(manager, run, 'finish', node='analyze', thread_id='child', artifacts=['result.md'])


def test_full_eval_optimize_compare_adopt_and_frozen_source(manager):
    source, employee, version = setup(manager)
    case = make_case(manager, employee, source)
    service = manager.app.state.employee_evaluations
    calls, temporary_paths = [], []
    async def model(bundle, text, directory, config, schema=None):
        temporary_paths.append(Path(directory)); calls.append((bundle,text,schema))
        if schema:
            workflow = {**copy.deepcopy(WORKFLOW), 'approach':'核对数值', 'inputs':[], 'outputs':[],
                        'summary':'改进检查', 'open_questions':[]}
            workflow['steps'][0].update(description='先计算再检查', evidence=[])
            return schema.model_validate(workflow), {}, []
        assert 'PRIVATE_REFERENCE' not in bundle + text
        assert 'checks' not in json.loads((Path(directory)/'input.json').read_text())
        return SimpleNamespace(reply='3' if len(calls) == 1 else '4'), {'output_tokens':1}, []
    service.call = model
    with manager.sessions() as db:
        source_state = copy.deepcopy(db.get(AgentRun, source['id']).state)
    async def run():
        baseline = await endpoint(manager, '/runs', 'POST')(employee, RunCreate(case_ids=[case['id']], expected_version=version))
        await service.tasks[baseline['id']]
        with service.sessions() as db:
            stored = db.get(EmployeeEvaluationRecord, baseline['id'])
            assert stored.status == 'completed', stored.data.get('error')
        candidate = await endpoint(manager, '/runs/{run_id}/optimize', 'POST')(employee, baseline['id'])
        await service.tasks[candidate['id']]
        evaluation = await endpoint(manager, '/runs', 'POST')(employee, RunCreate(case_ids=[case['id']], expected_version=version, baseline_id=baseline['id'], candidate_id=candidate['id']))
        await service.tasks[evaluation['id']]
        with manager.sessions() as db:
            result = db.get(EmployeeEvaluationRecord, evaluation['id'])
            assert result.status == 'completed'
            assert result.data['comparison'][0]['change'] == 'improved'
            assert result.data['results'][0]['report']['status'] == 'passed'
            assert db.get(Employee, employee).version == version
        with manager.sessions.begin() as db:
            result = db.get(EmployeeEvaluationRecord, evaluation['id'])
            original_digest = result.data['live_bundle_digest']
            result.data = {**result.data, 'live_bundle_digest': 'outdated-rules'}
        with pytest.raises(HTTPException) as conflict:
            endpoint(manager, '/candidates/{candidate_id}/adopt', 'POST')(employee, candidate['id'], Adopt(expected_version=version, evaluation_id=evaluation['id']))
        assert conflict.value.status_code == 409
        with manager.sessions.begin() as db:
            result = db.get(EmployeeEvaluationRecord, evaluation['id'])
            result.data = {**result.data, 'live_bundle_digest': original_digest}
        adopted = endpoint(manager, '/candidates/{candidate_id}/adopt', 'POST')(employee, candidate['id'], Adopt(expected_version=version, evaluation_id=evaluation['id']))
        assert adopted['version'] == version + 1
        with pytest.raises(HTTPException):
            endpoint(manager, '/candidates/{candidate_id}/adopt', 'POST')(employee, candidate['id'], Adopt(expected_version=version, evaluation_id=evaluation['id']))
    asyncio.run(run())
    assert all(not path.exists() for path in temporary_paths)
    with manager.sessions() as db:
        assert db.get(AgentRun, source['id']).state == source_state
        saved = db.get(Employee, employee)
        assert '核对数值' in saved.files['AGENTS.md']
    assert list((manager.settings.data_dir/'employees'/employee/'evaluations').glob('*/record.json'))


def test_sources_and_case_creation_require_frozen_employee_identity(manager):
    source, employee, version = setup(manager)
    with manager.sessions.begin() as db:
        other = Design(title='另一个团队'); db.add(other); db.flush()
        apply_draft(db, other.id, 0, Draft.model_validate(DRAFT), 'test')
        other_id = other.id
        another_employee = db.query(Employee).filter_by(design_id=other_id).one().id
    original = manager.project_id; manager.project_id = other_id
    other_run = create(manager, 'node', 'other'); manager.project_id = original
    with pytest.raises(HTTPException) as wrong_employee:
        make_case(manager, employee, other_run)
    assert wrong_employee.value.status_code == 422
    case = make_case(manager, another_employee, other_run)
    assert case['source_team_id'] == other_id
    with manager.sessions.begin() as db:
        row = db.get(AgentRun, source['id'])
        extra = copy.deepcopy(row.state['nodes']['analyze'])
        extra['step']['owner'] = 'someone-else'
        row.state = {**row.state, 'nodes': {**row.state['nodes'], 'unrelated': extra}}
    sources = endpoint(manager, '/sources')(employee)
    assert [(r['run_id'], r['node_key']) for r in sources] == [(source['id'], 'analyze')]
    assert sources[0]['created_at']
    with pytest.raises(HTTPException):
        make_case(manager, employee, source, node_key='unrelated')
    service = manager.app.state.employee_evaluations
    with service.sessions() as db:
        with pytest.raises(HTTPException): service.get(db, employee, case['id'], 'case')
    with pytest.raises(HTTPException):
        make_case(manager, employee, source, acknowledge_source_access=False)
    # A genuine shared identity in a frozen snapshot can be used across teams.
    with manager.sessions.begin() as db:
        row = db.get(AgentRun, other_run['id'])
        snapshot = copy.deepcopy(row.snapshot)
        snapshot['definition']['employees']['analyst']['id'] = employee
        row.snapshot = snapshot
    assert {r['run_id'] for r in endpoint(manager, '/sources')(employee)} == {source['id'], other_run['id']}
    assert make_case(manager, employee, other_run)['source_team_id'] == other_id


def test_completed_task_is_imported_once_and_failed_runs_are_not_cases(manager):
    source, employee, _ = setup(manager)
    complete_node(manager, source)
    first = endpoint(manager)(employee)
    cases = [row for row in first if row['kind'] == 'case']
    assert len(cases) == 1
    assert cases[0]['source_task_id']
    assert cases[0]['run_id'] == source['id']
    assert (manager.settings.data_dir/'employees'/employee/'evaluations'/cases[0]['id']/'reference'/'result.md').read_text() == '真实任务输出'
    second = endpoint(manager)(employee)
    assert len([row for row in second if row['kind'] == 'case']) == 1

    failed = create(manager, 'node', 'failed-run')
    active(manager, failed)
    control(manager, failed, 'begin', node='analyze')
    control(manager, failed, 'fail', node='analyze', note='执行失败')
    after_failed = endpoint(manager)(employee)
    assert len([row for row in after_failed if row['kind'] == 'case']) == 1


def test_comparison_rejects_case_or_rule_changes_and_stale_versions(manager):
    source, employee, version = setup(manager)
    one = make_case(manager, employee, source)
    two = make_case(manager, employee, source, title='不同规则', checks=[])
    service = manager.app.state.employee_evaluations
    async def model(*args, **kwargs): return SimpleNamespace(reply='4'), {}, []
    service.call = model
    async def run():
        baseline = await endpoint(manager, '/runs', 'POST')(employee, RunCreate(case_ids=[one['id']], expected_version=version))
        await service.tasks[baseline['id']]
        with pytest.raises(HTTPException):
            await endpoint(manager, '/runs', 'POST')(employee, RunCreate(case_ids=[two['id']], expected_version=version, baseline_id=baseline['id']))
        with pytest.raises(HTTPException):
            await endpoint(manager, '/runs', 'POST')(employee, RunCreate(case_ids=[one['id']], expected_version=version+1))
    asyncio.run(run())


def test_no_rules_is_unverified_and_numeric_difference_is_real():
    case = {'reference':'different', 'reference_status':'historical', 'checks':[]}
    assert compare_output('answer', case)['status'] == 'unverified'
    case['checks'] = [Check(name='误差', kind='number', expected='10', tolerance=1).model_dump()]
    report = compare_output('12', case)
    assert report['status'] == 'failed'
    assert '2.0' in report['checks'][0]['detail']
    assert compare_output('NaN', case)['status'] == 'failed'
    case['checks'] = [Check(name='人工', kind='manual').model_dump()]
    assert compare_output('answer', case)['status'] == 'unverified'


def test_evaluation_rpc_error_reports_parameter_stage_not_fake_session_retention():
    from app.codex_session import CodexRPCError
    from app.employee_evaluation import evaluation_error
    error = CodexRPCError({'code':-32600,'message':'Invalid request: workspaceWrite.readOnlyAccess is no longer supported; use permissionProfile for restricted reads'})
    error.method = 'turn/start'
    message = evaluation_error(error)
    assert 'turn/start' in message
    assert 'readOnlyAccess' in message
    assert '会话已保留' not in message


def test_restart_marks_pending_evaluation_interrupted(manager):
    _, employee, _ = setup(manager)
    service = manager.app.state.employee_evaluations
    with service.sessions.begin() as db:
        row=EmployeeEvaluationRecord(employee_id=employee, kind='run', status='running', data={'results':[]})
        db.add(row);db.flush();identity=row.id
    service.recover()
    with service.sessions() as db:
        assert db.get(EmployeeEvaluationRecord,identity).status == 'interrupted'


@pytest.mark.parametrize('score,failed,changed,adopted',[(90,False,False,True),(80,False,False,False),(70,False,False,False),(90,True,False,False),(90,False,True,False)])
def test_trial_only_adopts_verified_improvement(manager,score,failed,changed,adopted):
    from app.employee_context import employee_context_from_db
    from app.employee_evaluation import digest
    source,eid,version=setup(manager)
    case=make_case(manager,eid,source)
    service=manager.app.state.employee_evaluations
    def report(value):
        return {'status':'estimated','completion_percent':value,'coverage_percent':100,
            'objectives':[{'name':'完成目标','weight':100,'completion':value}]}
    with manager.sessions.begin() as db:
        employee=db.get(Employee,eid)
        original=copy.deepcopy(employee.files)
        baseline=EmployeeEvaluationRecord(employee_id=eid,kind='run',status='completed',data={
            'employee_version':version,'live_bundle_digest':digest(employee_context_from_db(db,employee)),
            'cases':[{'id':case['id'],**case}],'config':{},'files':original,
            'results':[{'case_id':case['id'],'report':report(80)}]})
        db.add(baseline);db.flush()
        workflow={**copy.deepcopy(WORKFLOW),'title':'调优后的方法'}
        candidate=EmployeeEvaluationRecord(employee_id=eid,kind='candidate',status='ready',data={
            'baseline_id':baseline.id,'employee_version':version,'workflow':workflow,'auto_trial':True})
        db.add(candidate);db.flush();cid=candidate.id
    async def execute(identity):
        with manager.sessions.begin() as db:
            employee=db.get(Employee,eid)
            assert employee.files==original and employee.version==version
            trial=db.get(EmployeeEvaluationRecord,identity)
            assert trial.data['rubrics'][case['id']]==[{'name':'完成目标','weight':100}]
            trial.status='failed' if failed else 'completed'
            trial.data={**trial.data,'results':[] if failed else [{'case_id':case['id'],'report':report(score)}]}
            if changed: employee.version+=1
    service.execute=execute
    asyncio.run(service.trial_and_adopt(cid))
    with manager.sessions() as db:
        employee=db.get(Employee,eid);candidate=db.get(EmployeeEvaluationRecord,cid)
        assert (candidate.status=='adopted') == adopted
        if adopted:
            assert employee.version==version+1
            assert json.loads(employee.files['workflow.json'])['title']=='调优后的方法'
        else:
            assert employee.files==original
