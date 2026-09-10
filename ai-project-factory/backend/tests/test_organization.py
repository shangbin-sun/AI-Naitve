from pathlib import Path
from fastapi.testclient import TestClient
from app.models import Employee
from app.organization import default_files
from test_agent_runs import manager, create, active, control


def test_project_creation_and_independent_edits(manager, monkeypatch):
    with TestClient(manager.app) as client:
        ids = [client.post('/api/workspaces', json={'title': title}).json()['id'] for title in ('A', 'B')]
        roots = [manager.workspaces.project(pid) for pid in ids]
        for root in roots:
            assert (root / 'AGENTS.md').is_file()
            assert (root / '.agents/skills/project-workflow/SKILL.md').is_file()
        base = f'/api/workspaces/{ids[0]}'
        listing = client.get(base + '/files').json()
        assert '.agents' in {e['name'] for e in listing['entries']}
        original = client.get(base + '/file', params={'path':'AGENTS.md'}).json()
        saved = client.put(base + '/file', json={'path':'AGENTS.md', 'text':'Only project A', 'expected_version':original['version']})
        assert saved.status_code == 200
        assert client.put(base + '/file', json={'path':'AGENTS.md','text':'stale','expected_version':original['version']}).status_code == 409
        assert (roots[0] / 'AGENTS.md').read_text() == 'Only project A'
        assert (roots[1] / 'AGENTS.md').read_text() != 'Only project A'
        monkeypatch.setattr('app.organization.default_files', lambda kind: {'AGENTS.md':'new default'})
        manager.workspaces.snapshot(ids[0])
        assert (roots[0] / 'AGENTS.md').read_text() == 'Only project A'
        assert client.put(base + '/file', json={'path':'../AGENTS.md', 'text':'bad', 'expected_version':2}).status_code == 403


def test_employee_edits_and_project_rules_are_frozen(manager):
    with TestClient(manager.app) as client:
        run = create(manager); active(manager, run)
        base = f'/api/workspaces/{manager.project_id}'
        for path in ('AGENTS.md', 'employees/analyst/AGENTS.md', 'employees/analyst/.agents/skills/employee-work/SKILL.md'):
            old = client.get(base + '/file', params={'path':path}).json()
            assert old['editable']
            response = client.put(base + '/file', json={'path':path,'text':old['text']+'\nCustom rule','expected_version':old['version']})
            assert response.status_code == 200, response.text
        begun = control(manager, run, 'begin', node='analyze')
        bundle = begun['instruction_bundle']
        for key in ('project_rules_path', 'employee_rules_path'):
            assert 'Custom rule' not in Path(bundle[key]).read_text()
        assert bundle['project_skill_paths']
        newer = create(manager, request='second')
        assert newer['snapshot']['digest'] != run['snapshot']['digest']
        assert 'Custom rule' in Path(newer['snapshot']['path'], 'project/AGENTS.md').read_text()
        frozen = 'definition/versions/' + run['snapshot']['digest'] + '/project/AGENTS.md'
        assert client.put(base + '/file', json={'path':frozen,'text':'bad','expected_version':1}).status_code == 403


def test_backfill_preserves_existing_employee_rules(manager):
    with manager.sessions.begin() as db:
        employee = db.query(Employee).filter_by(key='analyst').one()
        employee.files = {'AGENTS.md':'Existing employee rules'}
    manager.workspaces.snapshot(manager.project_id)
    with manager.sessions() as db:
        employee = db.query(Employee).filter_by(key='analyst').one()
        assert employee.files['AGENTS.md'] == 'Existing employee rules'
        assert '.agents/skills/employee-work/SKILL.md' in employee.files
        version = employee.version
    manager.workspaces.snapshot(manager.project_id)
    with manager.sessions() as db:
        assert db.query(Employee).filter_by(key='analyst').one().version == version
