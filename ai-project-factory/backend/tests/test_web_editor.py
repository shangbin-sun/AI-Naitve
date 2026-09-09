import json
from urllib.parse import urlsplit, parse_qs
import pytest
from fastapi import HTTPException
from app.web_editor import editor_url, EditorRequest

class Healthy:
    status = 200
    def __enter__(self): return self
    def __exit__(self, *args): pass


def test_editor_scopes_file_and_encodes_unicode(monkeypatch):
    monkeypatch.setenv('FACTORY_WEB_EDITOR_URL', 'http://127.0.0.1:8787')
    monkeypatch.setattr('app.web_editor.urlopen', lambda *a, **kw: Healthy())
    data = {'files':[{'step_id':'run-analysis', 'name':'文档', 'folder':'/workspace/中文 空格', 'path':'/workspace/中文 空格/a.json'}]}
    response = editor_url(data, EditorRequest(step_id='run-analysis', filename='文档'))
    query = parse_qs(urlsplit(response['url']).query)
    assert query['folder'] == ['/workspace/中文 空格']
    assert json.loads(query['payload'][0])[0][0] == 'openFile'
    with pytest.raises(HTTPException) as error:
        editor_url(data, EditorRequest(step_id='other'))
    assert error.value.status_code == 404


def test_editor_down_is_actionable(monkeypatch):
    def down(*args, **kwargs): raise OSError('offline')
    monkeypatch.setattr('app.web_editor.urlopen', down)
    with pytest.raises(HTTPException) as error:
        editor_url({'files':[{'step_id':'s', 'name':'a'}]}, EditorRequest(step_id='s'))
    assert error.value.status_code == 503
    assert 'scripts/editor.py' in error.value.detail


def test_open_exact_directory_file_cannot_escape_employee(monkeypatch):
    monkeypatch.setattr('app.web_editor.urlopen', lambda *a, **k: Healthy())
    manifest={'files':[{'step_id':'analysis','folder':'/employee/a'}], 'directory_files':[
        {'folder':'/employee/a','relative_path':'outputs/plan.json','path':'/employee/a/outputs/plan.json'},
        {'folder':'/employee/b','relative_path':'secret.txt','path':'/employee/b/secret.txt'}]}
    assert 'payload=' in editor_url(manifest,EditorRequest(step_id='analysis',relative_path='outputs/plan.json'))['url']
    with pytest.raises(HTTPException):
        editor_url(manifest,EditorRequest(step_id='analysis',relative_path='secret.txt'))
