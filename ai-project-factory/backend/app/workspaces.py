"""Filesystem projections; SQLite remains the authority for definitions and state."""
import hashlib
import json
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from sqlalchemy import select
from .models import Employee, Source
from .service import get_design
from .chat_attachments import ChatAttachment
from .organization import ensure_project_instructions, default_files


def identity(label):
    slug = re.sub(r'[^\w-]+', '-', label, flags=re.UNICODE).strip('-')[:24] or 'task'
    return datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ') + '-' + slug + '-' + uuid4().hex[:12]


def safe_path(root, relative):
    root = Path(root).resolve()
    path = Path(relative)
    if path.is_absolute() or not path.parts or any(p in ('.', '..') for p in path.parts):
        raise ValueError('无效的相对路径')
    result = root / path
    if not result.resolve().is_relative_to(root):
        raise ValueError('路径不能离开工作目录')
    current = result
    while current != root:
        if current.is_symlink():
            raise ValueError('工作文件不能使用符号链接')
        current = current.parent
    return result


def write_json(path, data):
    path = Path(path)
    for parent in (path, *path.parents):
        if parent.is_symlink():
            raise ValueError('拒绝向符号链接写入运行记录')
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(dir=path.parent, prefix='.write-')
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(data, stream, ensure_ascii=False, indent=2)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


class Workspaces:
    def __init__(self, settings, sessions):
        self.root = settings.data_dir.resolve() / 'projects'
        self.sessions = sessions

    def project(self, project):
        return safe_path(self.root, project)

    def snapshot(self, project):
        with self.sessions.begin() as db:
            design = get_design(db, project)
            for name in ('node-tasks', 'workflow-tasks', 'management'):
                (self.project(project) / name).mkdir(parents=True, exist_ok=True)
            employees = list(db.scalars(select(Employee).where(Employee.design_id == project, Employee.active.is_(True)).order_by(Employee.key)))
            rules = ensure_project_instructions(db, project)
            for employee in employees:
                defaults = default_files('employee')
                if any(name not in employee.files for name in defaults):
                    employee.files = {**defaults, **employee.files}
                    employee.version += 1
            sources = list(db.scalars(select(Source).where(Source.design_id == project).order_by(Source.id)))
            attachments = list(db.scalars(select(ChatAttachment).where(ChatAttachment.design_id == project, ChatAttachment.message_id.is_not(None)).order_by(ChatAttachment.id)))
            value = {'organization_instructions': (Path(__file__).parent / 'instructions/organization.md').read_text(encoding='utf-8'),
                     'project_files': dict(rules.files), 'instructions_version': rules.version,
                     'project_id': project, 'version': design.version, 'title': design.title, 'draft': design.draft,
                     'employees': {e.key: {'id': e.id, 'version': e.version, 'profile': e.profile, 'files': e.files} for e in employees},
                     'sources': [{'id': s.id, 'title': s.title, 'content': s.content, 'coverage': s.coverage} for s in sources],
                     'attachments': [{'id': a.id, 'name': a.name, 'content_type': a.content_type, 'sha256': hashlib.sha256(a.data).hexdigest()} for a in attachments]}
            digest = hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
            target = self.project(project) / 'definition' / 'versions' / digest
            if not target.exists():
                target.parent.mkdir(parents=True, exist_ok=True)
                with tempfile.TemporaryDirectory(dir=target.parent, prefix='.snapshot-') as temp:
                    directory = Path(temp) / 'content'
                    directory.mkdir()
                    write_json(directory / 'definition.json', value)
                    (directory / 'AGENTS.md').write_text(value['organization_instructions'], encoding='utf-8')
                    for name, content in rules.files.items():
                        path = safe_path(directory / 'project', name)
                        path.parent.mkdir(parents=True, exist_ok=True)
                        path.write_text(content, encoding='utf-8')
                    for key, employee in value['employees'].items():
                        base = safe_path(directory / 'employees', key)
                        for name, content in employee['files'].items():
                            path = safe_path(base, name)
                            path.parent.mkdir(parents=True, exist_ok=True)
                            path.write_text(content, encoding='utf-8')
                        (base / 'instructions.md').parent.mkdir(parents=True, exist_ok=True)
                        (base / 'instructions.md').write_text(employee['profile']['instructions'], encoding='utf-8')
                    for source in sources:
                        path = directory / 'references' / (source.id + '.txt')
                        path.parent.mkdir(parents=True, exist_ok=True)
                        path.write_text(source.content, encoding='utf-8')
                    for attachment in attachments:
                        path = directory / 'attachments' / attachment.id / Path(attachment.name).name
                        path.parent.mkdir(parents=True, exist_ok=True)
                        path.write_bytes(attachment.data)
                    try:
                        directory.rename(target)
                    except OSError:
                        if not target.exists():
                            raise
            # Current files are a database projection; immutable runs use target above.
            projected = dict(rules.files)
            for key, employee in value['employees'].items():
                projected.update({f'employees/{key}/{name}': content for name, content in employee['files'].items()})
                projected[f'employees/{key}/instructions.md'] = employee['profile']['instructions']
            index = self.project(project) / 'management/projected-files.json'
            previous = json.loads(index.read_text()) if index.exists() else []
            for name in set(previous) - set(projected):
                path = safe_path(self.project(project), name)
                if path.is_file():
                    path.unlink()
            for name, content in projected.items():
                path = safe_path(self.project(project), name)
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content, encoding='utf-8')
            write_json(index, list(projected))
            management = self.project(project) / 'management'
            management.mkdir(parents=True, exist_ok=True)
            write_json(management / 'definition-ref.json', {'version': design.version, 'digest': digest, 'path': str(target)})
            return {'version': design.version, 'digest': digest, 'path': str(target), 'definition': value}

    def run(self, project, scope, task_id, run_id):
        if scope not in ('node', 'workflow'):
            raise ValueError('未知任务类型')
        return safe_path(self.project(project) / f'{scope}-tasks', task_id + '/runs/' + run_id)
