import json

from test_factory import workspace, new


def test_employee_page_workflow_save_and_conflict(workspace):
    client, _ = workspace
    new(client, ready=True)
    employee = client.get('/api/employees').json()[0]
    url = f'/api/employees/{employee["id"]}'
    workflow = {'title': '检查流程', 'goal': '检查', 'approach': '统一检查依赖', 'inputs': [], 'outputs': [
        {'id':'O01','name':'报告','description':'检查记录','format':'Markdown','required':True,'validation':'有来源'}], 'steps': [
        {'id': 'S01', 'name': '检查', 'goal': '核实', 'acceptance': '通过',
         'input': '', 'output': '', 'actions': ['验证证据'], 'requirements': []}]}
    body = {'expected_version': employee['version'], 'profile': employee['profile'],
            'files': {**employee['files'], 'workflow.json': json.dumps(workflow)}}
    first = client.put(url, json=body)
    assert first.status_code == 200, first.text
    saved = first.json()
    assert json.loads(saved['files']['workflow.json'])['version'] == 1
    assert '统一检查依赖' in saved['files']['AGENTS.md']
    assert 'O01 报告' in saved['files']['AGENTS.md']
    assert '验证证据' in saved['files']['.agents/skills/employee-workflow/SKILL.md']
    assert client.put(url, json=body).status_code == 409
    workflow['steps'][0]['actions'] = ['重新验证']
    body.update(expected_version=saved['version'], files={**saved['files'], 'workflow.json': json.dumps(workflow)})
    second = client.put(url, json=body)
    assert second.status_code == 200, second.text
    assert json.loads(second.json()['files']['workflow.json'])['version'] == 2
    assert '重新验证' in second.json()['files']['.agents/skills/employee-workflow/SKILL.md']
    body.update(expected_version=second.json()['version'], files={**second.json()['files'], 'workflow.json': '{'})
    assert client.put(url, json=body).status_code == 422
    assert client.get(url).json()['version'] == second.json()['version']
