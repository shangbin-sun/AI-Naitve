"""One explicit employee capability bundle shared by every model entry point.

Database snapshots own content. Paths are references, never proof of loading.
"""
import hashlib
from pathlib import Path
import yaml


def employee_context(snapshot, key):
    definition = snapshot['definition']
    employee = definition.get('employees', {}).get(key)
    if not employee:
        raise ValueError(f'员工不存在：{key}')
    root = Path(snapshot.get('path', '.'))
    entries = []

    def add(name, content, kind):
        if not isinstance(content, str) or not content.strip():
            raise ValueError(f'必需规则缺失：{name}')
        entries.append({'path': str(root / name), 'kind': kind, 'content': content,
                        'sha256': hashlib.sha256(content.encode()).hexdigest()})

    def rules(prefix, files):
        rule = 'AGENTS.override.md' if files.get('AGENTS.override.md', '').strip() else 'AGENTS.md'
        add(prefix + rule, files.get(rule), 'rules')
        for name in sorted(files):
            if name.startswith('.agents/skills/') and name.endswith('/SKILL.md'):
                content = files[name]
                parts = content.split('---', 2)
                meta = yaml.safe_load(parts[1]) if len(parts) == 3 and not parts[0].strip() else None
                if not isinstance(meta, dict) or not all(isinstance(meta.get(k), str) and meta[k].strip() for k in ('name', 'description')):
                    raise ValueError(f'Skill 元数据无效：{prefix}{name}')
                add(prefix + name, content, 'skill')

    add('AGENTS.md', definition.get('organization_instructions'), 'organization')
    rules('project/', definition.get('project_files', {}))
    add(f'employees/{key}/instructions.md', employee['profile'].get('instructions'), 'role')
    rules(f'employees/{key}/', employee.get('files', {}))
    content = '\n\n'.join(f"【{e['kind']} · {e['path']}】\n{e['content']}" for e in entries)
    return {'employee_key': key, 'employee_version': employee['version'],
            'snapshot_digest': snapshot.get('digest'), 'entries': entries, 'content': content,
            'resources': [{'path': str(root / prefix / name), 'sha256': hashlib.sha256(text.encode()).hexdigest()}
                          for prefix, files in [('project', definition.get('project_files', {})), (f'employees/{key}', employee.get('files', {}))]
                          for name, text in sorted(files.items())]}


def employee_context_from_db(db, employee):
    """Freeze legacy entry points at creation time too, using the same loader."""
    from .organization import ensure_project_instructions
    definition = {'organization_instructions': (Path(__file__).parent / 'instructions/organization.md').read_text(),
                  'project_files': dict(ensure_project_instructions(db, employee.design_id).files),
                  'employees': {employee.key: {'version': employee.version, 'profile': employee.profile, 'files': employee.files}}}
    import json
    digest = hashlib.sha256(json.dumps(definition, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    return employee_context({'definition': definition, 'digest': digest}, employee.key)
