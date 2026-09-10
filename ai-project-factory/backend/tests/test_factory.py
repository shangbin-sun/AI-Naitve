import asyncio
import copy
import io
import threading
import time
import zipfile

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.schemas import DesignResponse

DRAFT = {
    'name': '销售分析团队', 'goal': '交付可复核的月度销售分析',
    'members': [dict(key='analyst', name='分析员', role='分析销售数据', kind='ai', responsibilities=['数据分析'], instructions='先检查数据质量，再分析并标注依据。', skills=['Python'], inputs=['销售数据'], outputs=['分析报告']),
                dict(key='owner', name='负责人', role='验收报告', kind='human', responsibilities=['确认结论'], instructions='', skills=[], inputs=['分析报告'], outputs=['验收意见'])],
    'workflow': [dict(key='analyze', name='分析', owner='analyst', kind='work', depends_on=[], input='销售数据', output='分析报告', acceptance='结论有数据依据'),
                 dict(key='approve', name='验收', owner='owner', kind='approval', depends_on=['analyze'], input='分析报告', output='验收意见', acceptance='人类确认')],
    'requirements': [], 'assumptions': [], 'questions': [], 'ready': True,
}


class ControlledRuntime:
    def __init__(self):
        self.release = threading.Event()

    async def status(self):
        return {'available': True, 'logged_in': True, 'version': 'test'}

    async def generate(self, context, on_event):
        await on_event('开始设计')
        while not self.release.is_set():
            await asyncio.sleep(.01)
        return DesignResponse(reply='团队已创建', draft=DRAFT), {'output_tokens': 10}


@pytest.fixture
def workspace(tmp_path):
    settings = Settings(tmp_path, f'sqlite:///{tmp_path}/test.db', 'codex', '', 5)
    runtime = ControlledRuntime()
    app = create_app(settings, runtime)
    with TestClient(app) as client:
        yield client, runtime


def new(client, ready=False):
    d = client.post('/api/designs', json={'title': '测试团队'}).json()
    if ready:
        assert client.put(f"/api/designs/{d['id']}/draft", json={'expected_version': 0, 'draft': DRAFT}).status_code == 200
    return d['id']


def wait_job(client, identity, status):
    until = time.monotonic()+4
    while time.monotonic() < until:
        d = client.get(f'/api/designs/{identity}').json()
        if d['jobs'][0]['status'] == status:
            return d
        time.sleep(.02)
    pytest.fail(f"job did not reach {status}: {d['jobs']}")


def test_real_generation_contract_and_idempotency(workspace):
    client, runtime = workspace
    identity = new(client)
    url = f'/api/designs/{identity}/messages'
    body = {'content': '建立销售团队', 'request_id': 'same-request', 'expected_version': 0}
    first = client.post(url, json=body)
    assert first.status_code == 202
    assert client.post(url, json=body).json()['id'] == first.json()['id']
    assert client.post(url, json={**body, 'request_id': 'another'}).status_code == 409
    runtime.release.set()
    d = wait_job(client, identity, 'completed')
    assert d['version'] == 1 and len(d['employees']) == 1 and len(d['messages']) == 2
    assert 'instructions/role.md' in d['employees'][0]['files']


def test_manual_change_wins_against_late_generation(workspace):
    client, runtime = workspace
    identity = new(client, True)
    client.post(f'/api/designs/{identity}/messages', json={'content': '重新设计', 'request_id': 'new', 'expected_version': 1})
    employee = client.get(f'/api/designs/{identity}').json()['employees'][0]
    profile = {**employee['profile'], 'instructions': '人工修订：必须注明样本范围。'}
    assert client.put(f"/api/employees/{employee['id']}", json={'expected_version': employee['version'], 'profile': profile, 'files': employee['files']}).status_code == 200
    runtime.release.set()
    d = wait_job(client, identity, 'conflict')
    assert d['draft']['members'][0]['instructions'] == profile['instructions']
    assert d['jobs'][0]['proposal'] is not None
    assert d['version'] == 2


def test_snapshot_export_and_stale_edits(workspace):
    client, _ = workspace
    identity = new(client, True)
    employee = client.get(f'/api/designs/{identity}').json()['employees'][0]
    url = f'/api/designs/{identity}/projects'
    project = client.post(url, json={'expected_version': 1}).json()
    assert client.post(url, json={'expected_version': 1}).json()['id'] == project['id']
    body = {'expected_version': 1, 'profile': {**employee['profile'], 'name': '资深分析员'}, 'files': {**employee['files'], 'src/analyze.py': 'print(42)\n'}}
    updated = client.put(f"/api/employees/{employee['id']}", json=body)
    assert updated.status_code == 200
    assert client.put(f"/api/employees/{employee['id']}", json=body).status_code == 409
    assert client.post(url, json={'expected_version': 1}).status_code == 409
    saved = client.get('/api/projects').json()[0]
    assert saved['snapshot']['employees'][0]['profile']['name'] == '分析员'
    archive = client.get(f"/api/employees/{employee['id']}/export")
    with zipfile.ZipFile(io.BytesIO(archive.content)) as z:
        assert z.read('src/analyze.py') == b'print(42)\n'
        assert 'employee.json' in z.namelist()
    assert len(client.get(f'/api/designs/{identity}/revisions').json()) == 2


@pytest.mark.parametrize('path', ['../outside.py', '/tmp/file', 'a/../b', '.env', 'employee.json', 'a\\b'])
def test_invalid_engineering_paths_rejected(workspace, path):
    client, _ = workspace
    identity = new(client, True)
    employee = client.get(f'/api/designs/{identity}').json()['employees'][0]
    response = client.put(f"/api/employees/{employee['id']}", json={'expected_version': 1, 'profile': employee['profile'], 'files': {path: 'secret'}})
    assert response.status_code == 422
    assert client.get(f'/api/designs/{identity}').json()['version'] == 1


def test_invalid_graph_rejected(workspace):
    client, _ = workspace
    identity = new(client)
    draft = copy.deepcopy(DRAFT)
    draft['workflow'][0]['depends_on'] = ['approve']
    assert client.put(f'/api/designs/{identity}/draft', json={'expected_version': 0, 'draft': draft}).status_code == 422
    draft['workflow'][0]['depends_on'] = []
    draft['workflow'][0]['owner'] = 'missing'
    assert client.put(f'/api/designs/{identity}/draft', json={'expected_version': 0, 'draft': draft}).status_code == 422


def test_cancel_preserves_draft(workspace):
    client, _ = workspace
    identity = new(client, True)
    job = client.post(f'/api/designs/{identity}/messages', json={'content': '修改', 'request_id': 'cancel', 'expected_version': 1}).json()
    response = client.post(f"/api/jobs/{job['id']}/cancel")
    assert response.json()['status'] == 'cancelled'
    assert client.get(f'/api/designs/{identity}').json()['version'] == 1


def test_cross_origin_rejected(workspace):
    client, _ = workspace
    assert client.post('/api/designs', json={}, headers={'Origin': 'https://unrelated.example'}).status_code == 403


def test_removing_employee_from_incomplete_draft_deactivates_engineering(workspace):
    client, _ = workspace
    identity = new(client, True)
    draft = {**DRAFT, 'ready': False, 'members': [], 'workflow': []}
    assert client.put(f'/api/designs/{identity}/draft', json={'expected_version': 1, 'draft': draft}).status_code == 200
    assert client.get('/api/employees').json() == []


def test_ai_cannot_own_human_approval(workspace):
    client, _ = workspace
    identity = new(client)
    draft = copy.deepcopy(DRAFT)
    draft['workflow'][1]['owner'] = 'analyst'
    assert client.put(f'/api/designs/{identity}/draft', json={'expected_version': 0, 'draft': draft}).status_code == 422


def test_restart_marks_persisted_job_interrupted(tmp_path):
    from app.models import Design, Job
    settings = Settings(tmp_path, f'sqlite:///{tmp_path}/restart.db', 'codex', '', 5)
    app = create_app(settings, ControlledRuntime())
    with app.state.sessions.begin() as db:
        d = Design(title='重启测试')
        db.add(d)
        db.flush()
        identity = d.id
        db.add(Job(design_id=identity, request_id='pending', base_version=0, status='running'))
    with TestClient(app) as client:
        assert client.get(f'/api/designs/{identity}').json()['jobs'][0]['status'] == 'interrupted'


@pytest.mark.parametrize('missing', ['instructions', 'inputs', 'outputs'])
def test_ready_team_requires_employee_work_contract(workspace, missing):
    client, _ = workspace
    identity = new(client)
    draft = copy.deepcopy(DRAFT)
    draft['members'][0][missing] = '' if missing == 'instructions' else []
    assert client.put(f'/api/designs/{identity}/draft', json={'expected_version': 0, 'draft': draft}).status_code == 422


@pytest.mark.parametrize('missing', ['input', 'output', 'acceptance'])
def test_ready_workflow_requires_handoff_and_acceptance(workspace, missing):
    client, _ = workspace
    identity = new(client)
    draft = copy.deepcopy(DRAFT)
    draft['workflow'][0][missing] = '  '
    assert client.put(f'/api/designs/{identity}/draft', json={'expected_version': 0, 'draft': draft}).status_code == 422


def test_project_employee_export_uses_saved_version(workspace):
    import json
    client, _ = workspace
    identity = new(client, True)
    employee = client.get(f'/api/designs/{identity}').json()['employees'][0]
    project = client.post(f'/api/designs/{identity}/projects', json={'expected_version': 1}).json()
    changed = {**employee['profile'], 'instructions': '这是后续修改的指令'}
    assert client.put(f"/api/employees/{employee['id']}", json={'expected_version': 1, 'profile': changed, 'files': employee['files']}).status_code == 200
    response = client.get(f"/api/projects/{project['id']}/employees/{employee['id']}/export")
    assert response.status_code == 200
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        assert archive.read('instructions/role.md').decode() == employee['profile']['instructions']
        assert json.loads(archive.read('employee.json'))['draft_version'] == 1
    assert client.get(f"/api/projects/{project['id']}/employees/not-in-project/export").status_code == 404


def test_workspace_exists_before_generation_and_preserves_goal(workspace):
    client, _ = workspace
    result = client.post('/api/workspaces', json={'title': '训练实验AI 团队', 'goal': '准备数据、训练并独立评估'})
    assert result.status_code == 201
    identity = result.json()['id']
    saved = client.get(f'/api/workspaces/{identity}').json()
    assert saved['draft']['goal'] == '准备数据、训练并独立评估'
    assert saved['messages'] == []
    assert [p['id'] for p in client.get('/api/workspaces').json()] == [identity]
    assert client.get('/api/snapshots').json() == []


def test_workspace_identity_survives_employee_edits_and_snapshots(workspace):
    client, _ = workspace
    identity = new(client, ready=True)
    other = new(client, ready=True)
    snapshot = client.post(f'/api/workspaces/{identity}/snapshots', json={'expected_version': 1}).json()
    employee = client.get(f'/api/workspaces/{identity}').json()['employees'][0]
    profile = {**employee['profile'], 'name': '本AI 团队专用分析师'}
    assert client.put(f"/api/employees/{employee['id']}", json={'expected_version': employee['version'], 'profile': profile, 'files': employee['files']}).status_code == 200
    current = client.get(f'/api/workspaces/{identity}').json()
    assert current['draft']['members'][0]['name'] == '本AI 团队专用分析师'
    assert current['version'] == 2
    assert len(client.get('/api/workspaces').json()) == 2
    assert client.get(f'/api/workspaces/{other}').json()['draft']['members'][0]['name'] == '分析员'
    assert client.get('/api/snapshots').json()[0]['snapshot'] == snapshot['snapshot']
    assert len(client.get(f'/api/workspaces/{identity}/revisions').json()) == 2


def test_unfinished_plan_members_are_editable(workspace):
    client, _ = workspace
    identity = new(client)
    draft = copy.deepcopy(DRAFT)
    draft['ready'] = False
    draft['members'][0]['instructions'] = ''
    assert client.put(f'/api/workspaces/{identity}/draft', json={'expected_version': 0, 'draft': draft}).status_code == 200
    employee = client.get(f'/api/workspaces/{identity}').json()['employees'][0]
    profile = {**employee['profile'], 'instructions': '先校验数据，再执行分析'}
    assert client.put(f"/api/employees/{employee['id']}", json={'expected_version': 1, 'profile': profile, 'files': employee['files']}).status_code == 200
    assert client.get(f'/api/workspaces/{identity}').json()['draft']['members'][0]['instructions'] == profile['instructions']


def test_evidence_keeps_source_versions_and_source_scope(workspace):
    client, _ = workspace
    identity = new(client, ready=True)
    payload = {'title':'感知基线','location':'https://example.test/reference','kind':'contracts','coverage':'excerpt','content':'speed: number, 0~300; drive_mode 待确认'}
    source = client.post(f'/api/workspaces/{identity}/sources',json=payload)
    assert source.status_code == 201
    assert len(source.json()['digest']) == 64
    payload['content'] += '\n补充版本'
    second = client.post(f'/api/workspaces/{identity}/sources',json=payload).json()
    records = client.get(f'/api/workspaces/{identity}/sources').json()
    assert len(records)==2 and records[0]['digest']!=second['digest']
    other = new(client)
    assert client.get(f'/api/workspaces/{other}/sources').json()==[]
    assert client.post(f'/api/workspaces/{identity}/evaluations?kind=baseline').status_code == 422


def test_source_import_rejects_outside_root_and_excludes_secrets(workspace, tmp_path):
    client,_ = workspace
    identity = new(client,ready=True)
    root=tmp_path/'source'; root.mkdir()
    (root/'App.java').write_text('class App {}')
    (root/'local.properties').write_text('password=do-not-import')
    (root/'secret.java').symlink_to(tmp_path/'outside.java')
    (tmp_path/'outside.java').write_text('outside')
    client.app.state.evidence.allowed = root
    assert client.post(f'/api/workspaces/{identity}/sources/import-code',json={'path':str(tmp_path)}).status_code==422
    result = client.post(f'/api/workspaces/{identity}/sources/import-code',json={'path':str(root)})
    assert result.status_code == 201
    assert 'App.java' in result.json()['content']
    assert 'local.properties' not in result.json()['content']
    assert 'secret.java' not in result.json()['content']
    assert 'do-not-import' not in result.json()['content']


def test_review_cannot_claim_functional_or_full_source_pass(workspace):
    from app.evidence import Review
    client,runtime = workspace
    identity = new(client,ready=True)
    client.post(f'/api/workspaces/{identity}/sources',json={'title':'PRD节选','location':'source','kind':'requirements','coverage':'excerpt','content':'部分需求'})
    async def structured(context, response_model, system, on_event):
        return Review(summary='设计评估', checks=[{'id':key,'status':'pass','evidence':['fake'],'reason':'claim','improvement':'more'} for key in ['source_coverage','functional_validation']], employee_improvements=[],next_iteration='补全资料'),{}
    runtime.structured = structured
    start = client.post(f'/api/workspaces/{identity}/evaluations')
    assert start.status_code==202
    for _ in range(100):
        row=client.get(f'/api/workspaces/{identity}/evaluations').json()[0]
        if row['status']=='completed':break
        time.sleep(.01)
    assert row['status']=='completed'
    checks={c['id']:c for c in row['result']['checks']}
    assert checks['source_coverage']['status']=='blocked'
    assert checks['functional_validation']['status']=='not_assessed'
    assert len(checks)==12
    assert row['inputs']['sources'][0]['coverage']=='excerpt'


def test_baseline_normalizes_copy_and_preserves_source(workspace, tmp_path):
    client, _ = workspace
    identity = new(client, ready=True)
    root = tmp_path / 'gradle-source'
    root.mkdir()
    original = b'#!/bin/sh\r\necho "baseline fixture"\r\nexit 0\r\n'
    (root / 'gradlew').write_bytes(original)
    client.app.state.evidence.allowed = root
    imported = client.post(f'/api/workspaces/{identity}/sources/import-code', json={'path':str(root)}).json()
    assert client.post(f'/api/workspaces/{identity}/evaluations?kind=baseline').status_code == 202
    for _ in range(100):
        row = client.get(f'/api/workspaces/{identity}/evaluations').json()[0]
        if row['status'] not in ['running','queued']: break
        time.sleep(.01)
    assert row['status'] == 'completed'
    assert row['result']['exit_code'] == 0
    assert row['result']['preparation']['gradlew_crlf_normalized'] is True
    assert (root / 'gradlew').read_bytes() == original
    assert (client.app.state.evidence.root / imported['id'] / 'gradlew').read_bytes() == original
    assert row['result']['preparation']['original_sha256'] != row['result']['preparation']['execution_sha256']


@pytest.mark.parametrize('invalid_path', [False, True])
def test_analysis_persists_contract_files_and_rejects_traversal(workspace, invalid_path):
    from app.evidence import AnalysisResult
    client, runtime = workspace
    identity = new(client)
    draft = copy.deepcopy(DRAFT)
    old_key = draft['members'][0]['key']
    draft['members'][0]['key'] = 'requirements'
    for step in draft['workflow']:
        if step['owner'] == old_key: step['owner'] = 'requirements'
    assert client.put(f'/api/workspaces/{identity}/draft', json={'expected_version':0,'draft':draft}).status_code == 200
    client.post(f'/api/workspaces/{identity}/sources', json={'title':'excerpt','location':'ref','kind':'contracts','coverage':'excerpt','content':'speed 0-300'})
    names = ['requirements.md','perception-contract.json','execution-contract.json','model-requirements.md','open-questions.md','traceability.csv']
    if invalid_path: names[0] = '../../escape.md'
    async def structured(context, response_model, system, on_event):
        assert context['employees'][0]['key'] == 'requirements'
        return AnalysisResult(summary='partial',status='completed',artifacts=[{'path':name,'content':'{}' if name.endswith('.json') else 'partial'} for name in names],open_questions=[]), {}
    runtime.structured = structured
    assert client.post(f'/api/workspaces/{identity}/evaluations?kind=requirements').status_code == 202
    for _ in range(100):
        row = client.get(f'/api/workspaces/{identity}/evaluations').json()[0]
        if row['status'] not in ['running','queued']: break
        time.sleep(.01)
    assert row['status'] == ('failed' if invalid_path else 'blocked')
    if not invalid_path:
        assert len(row['result']['artifacts']) == 6
        assert all(len(a['sha256']) == 64 for a in row['result']['artifacts'])
        assert row['result']['status'] == 'blocked'
        assert row['result']['manifest']['run_id'] == row['id']
        assert row['result']['manifest']['project_version'] == row['design_version']
        assert row['result']['manifest']['quality_status'] == 'not_assessed'
        first = client.post(f"/api/evaluations/{row['id']}/manifest").json()
        second = client.post(f"/api/evaluations/{row['id']}/manifest").json()
        assert first['result']['manifest'] == second['result']['manifest']
    else:
        assert not (client.app.state.evidence.settings.data_dir/'analyses'/row['id']).exists()


def test_cancel_evaluation_retains_inputs_and_allows_retry(workspace):
    client, runtime = workspace
    identity = new(client, ready=True)
    client.post(f'/api/workspaces/{identity}/sources',json={'title':'PRD','location':'ref','kind':'requirements','coverage':'excerpt','content':'partial'})
    async def structured(*args):
        await asyncio.sleep(60)
    runtime.structured = structured
    run = client.post(f'/api/workspaces/{identity}/evaluations').json()
    assert client.post(f'/api/workspaces/{identity}/evaluations').status_code == 409
    cancelled = client.post(f"/api/evaluations/{run['id']}/cancel")
    assert cancelled.status_code == 200
    assert cancelled.json()['status'] == 'cancelled'
    assert cancelled.json()['inputs']['sources'][0]['content'] == 'partial'
    assert client.post(f'/api/workspaces/{identity}/evaluations').status_code == 202


def test_question_register_is_not_limited_to_chat_question_count(workspace):
    client, _ = workspace
    identity = new(client)
    draft = copy.deepcopy(DRAFT)
    draft['questions'] = [f'Q{i}: 待负责人裁定的需求' for i in range(1,7)]
    assert client.put(f'/api/workspaces/{identity}/draft',json={'expected_version':0,'draft':draft}).status_code == 200
    assert client.get(f'/api/workspaces/{identity}').json()['draft']['questions'] == draft['questions']
