"""Evidence-derived runtime nodes and explicit, immutable editor input capture."""
import hashlib
import json
from pathlib import Path
from fastapi import HTTPException
from .output_workspace import prepare_outputs


def editor_snapshot(root, runs):
    # Oldest to newest: a later artifact supersedes earlier versions of that path.
    selected = {}
    for run in reversed(runs):
        manifest = prepare_outputs(root, run)
        for item in manifest.get('files', []):
            selected[(item['step_id'].split('-', 1)[-1].split('-')[0], item['name'])] = item
    accepted = {}
    for run in reversed(runs):
        if not run.result.get("attempts"): continue
        for c in (run.inputs.get("editor_snapshot") or {}).get("changes", []):
            accepted[c["path"]] = c.get("sha256")
    changes = []
    for (_, name), item in sorted(selected.items()):
        path = Path(item['path'])
        if path.is_symlink() or not path.resolve().is_relative_to(root.resolve()):
            raise HTTPException(422, '员工工作文件路径无效')
        if not path.is_file():
            changes.append({'name': name, 'deleted': True, 'path': str(path)})
            continue
        raw = path.read_bytes()
        digest = hashlib.sha256(raw).hexdigest()
        if digest != accepted.get(str(path), item['original_sha256']):
            if len(raw) > 2_000_000:
                raise HTTPException(422, '修改文件超过 2MB，请拆分后重新提交')
            try:
                content = raw.decode('utf-8')
            except UnicodeError:
                raise HTTPException(422, '当前运行只接受 UTF-8 文本修改')
            changes.append({'name': name, 'path': str(path), 'sha256': digest, 'content': content,
                            'step_id': item['step_id']})
    digest = hashlib.sha256(json.dumps(changes, sort_keys=True).encode()).hexdigest()
    return {'digest': digest, 'changes': changes}


def nodes(run, snapshot):
    result = run.result or {}
    stage, status = result.get('stage'), run.status
    attempts = result.get('attempts', [])
    records = result.get('employee_records', [])
    active = status in ('queued', 'running')
    baseline = next((a for a in attempts if a.get('attempt') == 0), None)
    def test_pass(entry):
        t = (entry or {}).get('tests', {})
        return entry and entry.get('exit_code') == 0 and t.get('executed', 0) > 0 and not any(t.get(k) for k in ('failed', 'skipped', 'missing_reference_classes'))
    flow = []
    for key, title, role in [('baseline','输入与基线测试','平台测试执行器'), ('analyze','需求与架构','it_analysis'), ('develop','代码开发','it_development'), ('test','参考测试','平台测试执行器')]:
        calls = [r for r in records if r.get('employee_key') == role]
        state = 'pending'
        if key == 'baseline' and baseline: state = 'completed' if test_pass(baseline) else 'needs_repair'
        elif key == 'analyze' and result.get('plan'): state = 'completed' if result.get('planning_usage') or calls else 'reused'
        elif key == 'develop' and result.get('artifacts'): state = 'completed'
        elif key == 'test' and attempts: state = 'completed' if test_pass(attempts[-1]) else 'failed'
        if active and (stage == key or key == 'baseline' and stage in (None, 'environment')): state = 'running' if status == 'running' else 'queued'
        if not active and (stage == key or key == 'baseline' and stage in (None,'environment')) and status in ('failed', 'cancelled', 'interrupted'): state = status
        if key in ('analyze','develop') and state == 'pending' and status == 'completed': state = 'skipped'
        if key=='baseline' and not baseline and status=='blocked': state='blocked'
        if key=='develop' and calls and state=='pending' and not active: state='blocked'
        if key == 'test' and active and stage != 'test': state = 'pending'
        changed = [c['name'] for c in snapshot['changes'] if (key == 'analyze' and 'analysis' in c.get('step_id','')) or (key == 'develop' and 'develop' in c.get('step_id',''))]
        profile = next((e.get('profile', {}) for e in run.inputs.get('team_snapshot', []) if e.get('key') == role), {})
        flow.append({'key':key,'title':title,'worker':profile.get('name', role), 'state':state,'modified_files':changed, 'calls':len(calls)})
    if snapshot['changes']: flow[-1]['stale'] = True
    if flow[1]['modified_files']: flow[2]['stale'] = True
    flow.append({'key':'deploy','title':'部署','worker':'未接入执行器','state':'unavailable','modified_files':[], 'calls':0})
    return flow
