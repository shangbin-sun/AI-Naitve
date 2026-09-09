"""Export recorded task evidence by employee role; never invent missing personal logs."""
import json
import os
from pathlib import Path
from uuid import uuid4


def employee_key(step):
    if step == 'analysis': return 'it_analysis'
    if step.startswith('develop-') or step == 'pending-code': return 'it_development'
    return 'platform_validation'


def archive_process(root: Path, run):
    destination = root / run.id
    inputs, result = run.inputs or {}, run.result or {}
    managed = []
    def write(relative, value, plain=False):
        managed.append(relative)
        target = destination / relative
        if not target.resolve().is_relative_to(destination.resolve()):
            raise ValueError('归档路径超出运行目录')
        target.parent.mkdir(parents=True, exist_ok=True)
        content = value if plain else json.dumps(value, ensure_ascii=False, indent=2)
        if target.exists() and target.read_text(encoding='utf-8') == content: return
        temp = target.with_name(target.name + '.' + uuid4().hex + '.tmp')
        try:
            temp.write_text(content, encoding='utf-8')
            os.replace(temp, target)
        finally:
            temp.unlink(missing_ok=True)
    write('shared/run.json', {'id':run.id, 'status':run.status, 'error':getattr(run,'error',''),
          'project_id':getattr(run,'design_id',None), 'task_id':inputs.get('task_id'),
          'resume_run_id':inputs.get('resume_run_id'), 'stage':result.get('stage')})
    write('shared/inputs.json', inputs)
    write('shared/result.json', result)
    write('shared/events.log', '\n'.join(result.get('events',[])), plain=True)
    attempts = result.get('attempts', [])
    roles = ['it_analysis', 'it_development', 'platform_validation']
    for role in roles:
        prefix = f'employees/{role}'
        captured = next((e for e in inputs.get('employees', []) if e.get('key') == role), None)
        records = [r for r in result.get('employee_records', []) if r.get('employee_key') == role]
        write(f'{prefix}/employee.json', {'role':role, 'employee':captured,
              'attribution':'platform_executor' if role == 'platform_validation' else 'captured_employee' if captured else 'historical_unbound_role'})
        write(f'{prefix}/inputs/run-context.json', inputs)
        write(f'{prefix}/process/calls.json', records)
        write(f'{prefix}/process/shared-workflow.log', '\n'.join(result.get('events',[])), plain=True)
        write(f'{prefix}/process/coverage.json', {'personal_calls_recorded':bool(records),
              'note':'仅归档平台已捕获的数据；历史未保存的调用输入和员工日志无法补造。公共执行日志见 shared/events.log。'})
        write(f'{prefix}/README.md', '# 员工数据目录\n\ninputs：运行输入。outputs：原始输出记录。process：调用、日志与状态。evaluations：实际测试反馈。workspace：可编辑工作副本。\n\n除 workspace 外均为从运行证据生成的归档，更新时会同步；人工修改请保存于 workspace。任务公共资料、全流程日志在 ../../shared。\n', plain=True)
        if role == 'it_analysis':
            write(f'{prefix}/outputs/plan.json', {'plan':result.get('plan'), 'inherited':bool(inputs.get('previous_plan') and not result.get('planning_usage')), 'usage':result.get('planning_usage')})
            write(f'{prefix}/evaluations/baseline.json', next((a for a in attempts if a.get('attempt') == 0), None))
        else:
            selected = attempts if role == 'platform_validation' else [a for a in attempts if a.get('attempt',0)>0]
            write(f'{prefix}/evaluations/attempts.json', selected)
            if role == 'it_development':
                write(f'{prefix}/outputs/patches.json', {'attempts':selected, 'latest_artifacts':result.get('artifacts',[])})
            else:
                for attempt in selected:
                    write(f'{prefix}/process/attempt-{attempt["attempt"]}.log', attempt.get('output') or attempt.get('error') or '', plain=True)
                    workspace = Path(attempt.get('workspace', ''))
                    if not workspace.is_absolute() or not workspace.resolve().is_relative_to(root.parent.resolve()):
                        continue
                    reports = {c.get('report') for c in attempt.get('tests',{}).get('cases',[]) if c.get('report')}
                    for relative in ['baseline.log', *sorted(reports)]:
                        source = workspace / relative
                        if not source.resolve().is_relative_to(workspace.resolve()) or not source.is_file():
                            continue
                        write(f'{prefix}/evaluations/attempt-{attempt["attempt"]}/raw/{relative}', source.read_text(encoding='utf-8', errors='replace'), plain=True)

    write('shared/archive-index.json', list(managed))
    return destination
