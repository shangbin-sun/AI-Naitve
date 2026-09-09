"""Read-only integration checks for a generated software delivery team.

Usage: backend/.venv/bin/python scripts/check_design.py DESIGN_ID
Only validates design artifacts, never claims business execution succeeded.
"""
import argparse
import io
import json
import zipfile

import httpx


def inspect(client, identity):
    response = client.get(f'/designs/{identity}')
    response.raise_for_status()
    design = response.json()
    draft = design['draft']
    checks = []

    def check(name, passed, detail=''):
        checks.append({'check': name, 'passed': bool(passed), 'detail': detail})

    check('真实生成完成', design['jobs'][0]['status'] == 'completed', design['jobs'][0]['status'])
    check('团队方案已就绪', draft.get('ready'))
    members = {m['key']: m for m in draft.get('members', [])}
    workflow = draft.get('workflow', [])
    phases = {}
    for label, words in [('需求分析', ['需求']), ('架构设计', ['架构']), ('开发', ['开发', '实现']), ('测试', ['测试']), ('部署', ['部署'])]:
        phases[label] = [s for s in workflow if any(word in s['name'] for word in words)]
        check(label+'阶段存在', phases[label], ', '.join(s['name'] for s in phases[label]))
    check('所有步骤均有输入、输出、验收', workflow and all(all(s.get(k, '').strip() for k in ['input', 'output', 'acceptance']) for s in workflow))
    check('人工审批有正确归属', any(s['kind'] == 'approval' for s in workflow) and all(members[s['owner']]['kind'] == 'human' for s in workflow if s['kind'] == 'approval'))
    development = {s['owner'] for s in phases['开发'] if s['kind'] == 'work'}
    testing = {s['owner'] for s in phases['测试'] if members[s['owner']]['kind'] == 'ai' and s['kind'] != 'approval'}
    check('开发与测试人员独立', development and testing and development.isdisjoint(testing))
    employees = {e['key']: e for e in design['employees']}
    check('AI 岗位均有员工工程', set(employees) == {k for k, m in members.items() if m['kind'] == 'ai'})
    for key, employee in employees.items():
        export = client.get(f"/employees/{employee['id']}/export")
        export.raise_for_status()
        with zipfile.ZipFile(io.BytesIO(export.content)) as archive:
            manifest = json.loads(archive.read('employee.json'))
            check(key+'工程可导出且岗位一致', manifest['profile'] == members[key] and archive.read('instructions/role.md').decode() == members[key]['instructions'])
    return {'design_id': identity, 'scope': '团队设计与工程产物；不代表已执行需求、开发、测试或部署', 'passed': all(c['passed'] for c in checks), 'checks': checks}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('design_id')
    parser.add_argument('--base-url', default='http://127.0.0.1:8000/api')
    args = parser.parse_args()
    with httpx.Client(base_url=args.base_url, timeout=20) as client:
        report = inspect(client, args.design_id)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    raise SystemExit(0 if report['passed'] else 1)
