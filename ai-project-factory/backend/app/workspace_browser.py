"""Read-only browser roots resolved by the host, never supplied as absolute paths."""
from pathlib import Path
from fastapi import HTTPException
from fastapi.responses import FileResponse
from .workspaces import safe_path
from .service import get_design, edit_employee
from .organization import ensure_project_instructions, edit_project_file
from .models import Employee
from .schemas import EditEmployee
from sqlalchemy import select
from pydantic import BaseModel, Field


class EditRuleFile(BaseModel):
    path: str
    text: str = Field(max_length=2_000_000)
    expected_version: int = Field(ge=1)


def install_workspace_browser(app, workspaces, runs):
    def context(project, run_id, refresh=False):
        with runs.sessions() as db:
            get_design(db, project)
            if run_id:
                task, run = runs.rows(db, project, run_id)
                root = runs.directory(task, run)
                return root, {'scope': task.scope, 'label': '单节点工作空间' if task.scope == 'node' else '任务工作空间',
                              'thread_id': run.thread_id, 'run_id': run.id}
        if refresh or not workspaces.project(project).exists():
            workspaces.snapshot(project)
        return workspaces.project(project), {'scope':'project', 'label':'AI 团队工作空间', 'run_id':None}

    def resolve(root, path):
        try:
            return safe_path(root, path) if path else root
        except ValueError as error:
            raise HTTPException(403, '只能访问当前工作空间内的文件') from error

    @app.get('/api/workspaces/{project}/files')
    def listing(project: str, run_id: str | None = None, path: str = ''):
        root, details = context(project, run_id, refresh=not path)
        directory = resolve(root, path)
        if not directory.is_dir():
            raise HTTPException(404, '目录不存在')
        entries = []
        for child in sorted(directory.iterdir(), key=lambda p:(not p.is_dir(), p.name)):
            if child.is_symlink() or (child.name.startswith('.') and child.name != '.agents'):
                continue
            entries.append({'name':child.name, 'path':str(child.relative_to(root)), 'directory':child.is_dir(),
                            'size':None if child.is_dir() else child.stat().st_size})
            if len(entries) == 500: break
        return {**details, 'root':str(root), 'path':path, 'entries':entries, 'limit':500}

    def editable(db, project, path):
        if path.startswith('employees/'):
            parts = path.split('/', 2)
            if len(parts) != 3:
                return None
            employee = db.scalar(select(Employee).where(Employee.design_id == project, Employee.key == parts[1], Employee.active.is_(True)))
            relative = parts[2]
            if employee and (relative in ('AGENTS.md', 'AGENTS.override.md') or relative.startswith('.agents/skills/')):
                return employee, relative
        elif path in ('AGENTS.md', 'AGENTS.override.md') or path.startswith('.agents/skills/'):
            return ensure_project_instructions(db, project), path
        return None

    @app.put('/api/workspaces/{project}/file')
    def save_file(project: str, data: EditRuleFile):
        resolve(workspaces.project(project), data.path)
        with runs.sessions.begin() as db:
            get_design(db, project)
            target = editable(db, project, data.path)
            if not target:
                raise HTTPException(403, '只能编辑当前AI 团队或员工的规则和技能，运行快照不可修改')
            owner, relative = target
            if isinstance(owner, Employee):
                result = edit_employee(db, owner.id, EditEmployee(expected_version=data.expected_version,
                    profile=owner.profile, files={**owner.files, relative: data.text}))
                version = result.version
            else:
                version = edit_project_file(db, project, relative, data.text, data.expected_version)
        workspaces.snapshot(project)
        return {'name':Path(data.path).name, 'path':data.path, 'text':data.text, 'editable':True, 'version':version}

    @app.get('/api/workspaces/{project}/file')
    def file(project: str, path: str, run_id: str | None = None, download: bool = False):
        root, _ = context(project, run_id)
        target = resolve(root, path)
        if not target.is_file():
            raise HTTPException(404, '文件不存在')
        if download:
            return FileResponse(target, filename=target.name, media_type='application/octet-stream')
        if target.stat().st_size > 1_000_000:
            return {'name':target.name, 'text':None, 'reason':'文件较大，请下载查看'}
        try:
            text = target.read_bytes().decode('utf-8')
            if '\x00' in text: raise UnicodeError()
        except UnicodeError:
            return {'name':target.name, 'text':None, 'reason':'此文件请下载查看'}
        metadata = {'editable':False}
        if not run_id:
            with runs.sessions.begin() as db:
                value = editable(db, project, path)
                if value:
                    owner, relative = value
                    text = owner.files.get(relative, text)
                    metadata = {'editable':True, 'version':owner.version}
        return {'name':target.name, 'text':text, **metadata}
