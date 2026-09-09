"""Materialize editable output copies for desktop VS Code, without changing run evidence."""
import hashlib
import json
from pathlib import Path, PurePosixPath
from urllib.parse import quote
from .process_archive import archive_process, employee_key


def prepare_outputs(root: Path, run):
    destination = archive_process(root, run)
    manifest = []
    def emit(step, name, content):
        if content is None:
            return
        # Keep model-provided paths as labels; they never control filesystem traversal.
        safe_name = Path(name).name.replace('\\', '_') or 'output.txt'
        if safe_name in ('.', '..'):
            safe_name = 'output.txt'
        if name == '需求与架构方案':
            safe_name += '.json'
        elif name == '开发说明':
            safe_name += '.txt'
        token = hashlib.sha256(f'{step}/{name}'.encode()).hexdigest()[:16]
        relative = PurePosixPath(name)
        if relative.is_absolute() or '..' in relative.parts or '\\' in name or name in ('需求与架构方案', '开发说明'):
            relative = PurePosixPath(safe_name)
        employee = destination / 'employees' / employee_key(step)
        target = employee / 'workspace' / step / relative
        if not target.resolve().is_relative_to(destination.resolve()):
            raise ValueError('产物目录路径无效')
        legacy = destination / step / 'files' / relative
        if not legacy.is_file():
            legacy = destination / step / token / safe_name
        target.parent.mkdir(parents=True, exist_ok=True)
        # Opening again must preserve human edits; immutable evidence stays in the database.
        try:
            with target.open('x', encoding='utf-8') as out:
                out.write(legacy.read_text(encoding='utf-8') if legacy.is_file() else content)
        except FileExistsError:
            pass
        manifest.append({'step_id': f'{run.id}-{step}', 'name': name,
                         'original_sha256': hashlib.sha256(content.encode()).hexdigest(),
                         'path': str(target), 'folder': str(employee),
                         'uri': 'vscode://file' + quote(str(target), safe='/')})
    result, inputs = run.result or {}, run.inputs or {}
    if result.get('plan') and (not inputs.get('previous_plan') or result.get('planning_usage')):
        emit('analysis', '需求与架构方案', json.dumps(result['plan'], ensure_ascii=False, indent=2))
    changes = [a for a in result.get('attempts', []) if a.get('attempt', 0) > 0]
    for index, attempt in enumerate(changes):
        step = f'develop-{attempt["attempt"]}'
        emit(step, '开发说明', attempt.get('summary') or attempt.get('error') or '历史未保存开发说明')
        files = attempt.get('artifacts')
        if files is None and index == len(changes)-1 and not attempt.get('error') and run.status == 'completed':
            files = result.get('artifacts', [])
        for file in files or []:
            emit(step, file['path'], file.get('content'))
    if not changes:
        for file in result.get('artifacts', []):
            emit('pending-code', file['path'], file.get('content'))
    directory_files = []
    managed = set(json.loads((destination / "shared/archive-index.json").read_text()))
    originals = {f["path"]:f["original_sha256"] for f in manifest}
    for folder in sorted((destination / 'employees').iterdir()):
        if not folder.is_dir() or folder.is_symlink(): continue
        for path in sorted(folder.rglob('*')):
            if not path.is_file() or path.is_symlink() or not path.resolve().is_relative_to(folder.resolve()) or path.name.endswith('.tmp'): continue
            relative = path.relative_to(folder).as_posix()
            directory_files.append({'employee_key':folder.name, 'relative_path':relative, 'path':str(path), 'folder':str(folder), 'size':path.stat().st_size, 'sha256':hashlib.sha256(path.read_bytes()).hexdigest(), 'kind':'editable_copy' if str(path) in originals else 'run_archive' if path.relative_to(destination).as_posix() in managed else 'workspace_file', 'modified':str(path) in originals and hashlib.sha256(path.read_bytes()).hexdigest()!=originals[str(path)]})
    return {'directory_files': directory_files, 'folder_uri': 'vscode://file' + quote(str(destination), safe='/'), 'files': manifest}
