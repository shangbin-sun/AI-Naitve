"""Read task evidence without synthesizing missing inputs, outputs or workflows."""
import base64
import hashlib
import json

from fastapi import HTTPException
from .employee_ability import validate_workflow
from .workspaces import safe_path
from .evaluation_files import describe_file


def extract_source(manager, task, run, node_key):
    node = run.state['nodes'][node_key]
    if node.get('status') != 'completed':
        raise HTTPException(422, '该员工节点尚未完成，不能读取完整的历史输出')
    frozen = run.snapshot['definition']['employees'][node['step']['owner']]
    raw = frozen.get('files', {}).get('workflow.json')
    workflow = None
    try:
        if raw:
            workflow = validate_workflow(json.loads(raw))
    except (ValueError, TypeError, HTTPException) as exc:
        raise HTTPException(422, '当次运行的 Workflow 快照无效') from exc
    root = manager.directory(task, run)
    evidence = []
    remaining = 300000

    def read(relative, expected=None):
        nonlocal remaining
        try:
            path = safe_path(root, relative)
            if path.stat().st_size > remaining:
                raise ValueError('文件超过文本评测读取上限')
            data = path.read_bytes()
            remaining -= len(data)
            sha = hashlib.sha256(data).hexdigest()
            if expected and sha != expected:
                raise ValueError('内容与运行快照哈希不一致')
            text = data.decode('utf-8')
            if '\x00' in text:
                raise ValueError('不是支持的 UTF-8 文本文件')
            evidence.append({'path': relative, 'sha256': sha, 'size': len(data)})
            return text
        except (OSError, ValueError, UnicodeError) as exc:
            raise HTTPException(422, f'无法读取任务文件 {relative}：{exc}') from exc

    attempt = node.get('attempt')
    if not attempt:
        raise HTTPException(422, '缺少当次执行记录，无法读取实际输入')
    try:
        context = json.loads(read(f'nodes/{node_key}/attempts/{attempt}/inputs/context.json'))
        task_input = context['task']
        upstream = context['upstream']
        if not isinstance(task_input, dict) or not isinstance(upstream, dict):
            raise ValueError()
        if not any(str(task_input.get(k, '')).strip() for k in ('description', 'input_text')) and not task_input.get('attachments') and not upstream:
            raise ValueError()
    except (ValueError, KeyError, TypeError) as exc:
        raise HTTPException(422, '当次执行的输入快照不完整或无效') from exc
    # Attachment content must agree with the frozen run, never the editable task.
    original = run.state.get('task_inputs')
    if original is None:
        raise HTTPException(422, '缺少冻结任务输入，不能使用当前任务内容代替')
    attachments = []
    input_files = []
    def file_record(relative, name, expected=None):
        try:
            record = describe_file(root, relative, name)
            if expected and record['sha256'] != expected:
                raise ValueError('内容与运行快照哈希不一致')
            return record
        except (ValueError, OSError) as exc:
            raise HTTPException(422, str(exc)) from exc
    frozen_attachments = {a['name']: a for a in original.get('attachments', [])}
    if {a['name'] for a in task_input.get('attachments', [])} != set(frozen_attachments):
        raise HTTPException(422, '执行输入快照的附件清单不完整')
    for attachment in task_input.get('attachments', []):
        name = attachment['name']
        try:
            sha = hashlib.sha256(base64.b64decode(frozen_attachments[name]['data'], validate=True)).hexdigest()
        except (KeyError, ValueError) as exc:
            raise HTTPException(422, f'附件 {name} 缺少有效的冻结内容') from exc
        record = file_record(attachment['path'], 'files/' + name, sha)
        input_files.append(record)
        attachments.append({'name':name, 'file':'inputs/' + record['name']})
    upstream_content = {}
    for key, artifacts in upstream.items():
        if not artifacts:
            raise HTTPException(422, f'上游节点 {key} 缺少交付物，不能还原输入')
        upstream_content[key] = []
        for i, a in enumerate(artifacts):
            record = file_record(a['path'], f'upstream/{key}/{i}/' + a['path'].split('/')[-1], a['sha256'])
            input_files.append(record)
            upstream_content[key].append({'file':'inputs/' + record['name']})
    try:
        output_root = safe_path(root, f'nodes/{node_key}/attempts/{attempt}/outputs')
        if not output_root.is_dir():
            raise ValueError('输出目录不存在')
        output = [file_record(p.relative_to(root).as_posix(), p.relative_to(output_root).as_posix())
                  for p in sorted(output_root.rglob('*')) if p.is_file() or p.is_symlink()]
    except (ValueError, OSError) as exc:
        raise HTTPException(422, str(exc)) from exc
    if not output:
        raise HTTPException(422, '该员工节点没有实际输出文件，不能用完成摘要代替')
    requirements = [task_input.get('acceptance', ''), node['step'].get('acceptance', '')]
    for item in (workflow or {}).get('outputs', []):
        requirements.append(json.dumps(item, ensure_ascii=False))
    requirements = list(dict.fromkeys(str(r).strip() for r in requirements if r))
    # Natural-language acceptance is preserved, not converted to invented scores.
    checks = [{'name': f'验收要求 {i+1}', 'kind': 'manual', 'expected': r, 'tolerance': 0}
              for i, r in enumerate(requirements)]
    input_value = {'task': {k: v for k, v in task_input.items() if k != 'attachments'},
                   'node': node['step'], 'attachments': attachments, 'upstream': upstream_content}
    return {'title': f"{task.title} · {node['step']['name']}",
            'input_text': json.dumps(input_value, ensure_ascii=False, indent=2),
            'reference': json.dumps(output, ensure_ascii=False, indent=2),
            'file_mode': True, 'input_files':input_files, 'output_files':output,
            'reference_status': 'historical', 'checks': checks,
            'source_workflow': workflow, 'source_employee_version': frozen.get('version'),
            'source_snapshot_digest': run.snapshot.get('digest'), 'source_attempt': attempt,
            'source_files': evidence, 'source_team_id': task.project_id, 'source_task_id': task.id,
            'source_node': node['step'], 'version': 1,
            'note': '输入与输出按原文件保存快照。仅文本输出参与对比，非文本文件保留但不参与评测；历史输出不是标准答案。'}
