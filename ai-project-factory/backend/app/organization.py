"""Copy-on-create organization files; the database owns each independent version."""
from pathlib import Path
from fastapi import HTTPException
from sqlalchemy import update
from .models import ProjectInstructions

TEMPLATES = Path(__file__).parent / 'instructions'


def default_files(kind):
    skill = 'project-workflow' if kind == 'project' else 'employee-work'
    return {'AGENTS.md': (TEMPLATES / f'{kind}-AGENTS.md').read_text(encoding='utf-8'),
            f'.agents/skills/{skill}/SKILL.md': (TEMPLATES / f'{skill}-SKILL.md').read_text(encoding='utf-8')}


def ensure_project_instructions(db, project):
    row = db.get(ProjectInstructions, project)
    if row is None:
        row = ProjectInstructions(design_id=project, files=default_files('project'), version=1)
        db.add(row)
        db.flush()
    return row


def edit_project_file(db, project, path, text, expected):
    from .service import validate_files
    row = ensure_project_instructions(db, project)
    if path not in ('AGENTS.md', 'AGENTS.override.md') and not path.startswith('.agents/skills/'):
        raise HTTPException(422, '只能修改AI 团队规则和技能')
    files = {**row.files, path: text}
    validate_files(files)
    changed = db.execute(update(ProjectInstructions).where(
        ProjectInstructions.design_id == project, ProjectInstructions.version == expected
    ).values(files=files, version=expected + 1))
    if changed.rowcount != 1:
        raise HTTPException(409, '规则已更新，请重新打开文件后修改')
    db.flush()
    return expected + 1
