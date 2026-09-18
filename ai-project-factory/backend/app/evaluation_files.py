"""Immutable file evidence; binary files are never coerced into text."""
import hashlib
import mimetypes
import shutil
from pathlib import Path
from .workspaces import safe_path

TEXT = {'.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.tsv', '.yaml', '.yml', '.xml', '.html', '.css', '.js', '.ts', '.py', '.sql', '.log', '.toml', '.ini', '.rst'}


def describe_file(root, relative, name=None):
    path = safe_path(root, relative)
    if not path.is_file():
        raise ValueError(f'文件缺失：{relative}')
    sha = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            sha.update(block)
    text = path.suffix.lower() in TEXT
    if text:
        try:
            with path.open(encoding='utf-8') as stream:
                for block in iter(lambda: stream.read(65536), ''):
                    if '\x00' in block:
                        text = False
                        break
        except UnicodeError:
            text = False
    return {'path':relative, 'name':name or path.name, 'size':path.stat().st_size,
            'sha256':sha.hexdigest(), 'media_type':mimetypes.guess_type(path.name)[0] or 'application/octet-stream',
            'text':text, 'evaluation': 'text' if text else 'excluded'}


def snapshot_files(source, destination, records):
    for record in records:
        target = safe_path(destination, record['name'])
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(safe_path(source, record['path']), target)
        if describe_file(destination, record['name'])['sha256'] != record['sha256']:
            raise ValueError('文件在创建快照时变化，请重新预览')


def verify_snapshot(root, records):
    for record in records:
        if describe_file(root, record['name'])['sha256'] != record['sha256']:
            raise ValueError(f"评测快照文件已变化：{record['name']}")
