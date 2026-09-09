"""Small adapter for the independently managed code-server service."""
import json
import os
from urllib.parse import urlencode, urlsplit, quote
from urllib.request import urlopen
from fastapi import HTTPException
from pydantic import BaseModel

class EditorRequest(BaseModel):
    step_id: str
    filename: str | None = None
    relative_path: str | None = None


def editor_url(manifest, request: EditorRequest):
    matches = [f for f in manifest['files'] if f['step_id'] == request.step_id]
    if request.relative_path is not None:
        folders = {f['folder'] for f in matches}
        matches = [f for f in manifest.get('directory_files', []) if f['folder'] in folders and f['relative_path'] == request.relative_path]
    elif request.filename is not None:
        matches = [f for f in matches if f['name'] == request.filename]
    if not matches:
        raise HTTPException(404, '该环节未保存可编辑文件')
    base = os.environ.get('FACTORY_WEB_EDITOR_URL', 'http://127.0.0.1:8787').rstrip('/')
    parsed = urlsplit(base)
    if parsed.scheme not in ('http', 'https') or not parsed.netloc or parsed.query or parsed.fragment:
        raise HTTPException(503, '网页版 VS Code 地址配置无效')
    health = os.environ.get('FACTORY_WEB_EDITOR_HEALTH_URL', base + '/healthz')
    try:
        with urlopen(health, timeout=2) as response:
            if response.status != 200:
                raise ValueError('unhealthy')
    except Exception:
        raise HTTPException(503, '网页版 VS Code 未启动，请运行 python3 scripts/editor.py')
    query = {'folder': matches[0]['folder']}
    if request.filename is not None or request.relative_path is not None:
        query['payload'] = json.dumps([['openFile', 'vscode-remote://' + parsed.netloc + quote(matches[0]['path'], safe='/')]])
    return {'url': base + '/?' + urlencode(query)}
