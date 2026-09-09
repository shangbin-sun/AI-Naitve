from types import SimpleNamespace
from urllib.parse import unquote
from pathlib import Path
from app.output_workspace import prepare_outputs


def test_output_copy_exact_files_and_preserves_edits(tmp_path):
    run = SimpleNamespace(id='run1', status='completed', inputs={}, result={
        'plan': {'summary': '实际方案'}, 'attempts': [
            {'attempt': 1, 'summary': '开发完成', 'artifacts': [{'path': '../../outside.py', 'content': 'original'}]},
            {'attempt': 2, 'artifacts': [{'path': 'code.py', 'content': 'second'}]},
        ]})
    result = prepare_outputs(tmp_path, run)
    files = result['files']
    assert len(files) == 5
    entry = next(f for f in files if f['name'] == '../../outside.py')
    target = Path(unquote(entry['uri'].removeprefix('vscode://file')))
    assert target.is_relative_to(tmp_path)
    assert target.read_text() == 'original'
    target.write_text('human edit')
    prepare_outputs(tmp_path, run)
    assert target.read_text() == 'human edit'
    assert run.result['attempts'][0]['artifacts'][0]['content'] == 'original'


def test_employee_archive_preserves_edits_and_separates_global_logs(tmp_path):
    import json
    run = SimpleNamespace(id='archive',status='running',inputs={'task_id':'task','employees':[]},result={
        'events':['全流程日志'], 'plan':{'summary':'输出'},
        'employee_records':[{'employee_key':'it_analysis','input':{'goal':'输入'},'events':['个人日志']}],
        'attempts':[]})
    manifest=prepare_outputs(tmp_path,run)
    folder=Path(manifest['files'][0]['folder'])
    assert folder.name=='it_analysis'
    assert json.loads((folder/'process/calls.json').read_text())[0]['events']==['个人日志']
    assert (tmp_path/'archive/shared/events.log').read_text()=='全流程日志'
    assert json.loads((folder/'employee.json').read_text())['attribution']=='historical_unbound_role'
    target=Path(manifest['files'][0]['path']);target.write_text('人工修改')
    run.status='completed'
    prepare_outputs(tmp_path,run)
    assert target.read_text()=='人工修改'
    assert json.loads((tmp_path/'archive/shared/run.json').read_text())['status']=='completed'


def test_directory_manifest_matches_disk_and_identifies_provenance(tmp_path):
    run=SimpleNamespace(id='listing',status='completed',inputs={},result={'plan':{'summary':'真实输出'},'attempts':[]})
    first=prepare_outputs(tmp_path,run)
    entry=first['files'][0];folder=Path(entry['folder']);working=Path(entry['path'])
    working.write_text('人工修改')
    (folder/'manual.txt').write_text('新增文件')
    second=prepare_outputs(tmp_path,run)
    files=[f for f in second['directory_files'] if f['folder']==str(folder)]
    assert {f['relative_path'] for f in files}=={p.relative_to(folder).as_posix() for p in folder.rglob('*') if p.is_file()}
    assert next(f for f in files if f['path']==str(working))['modified']
    assert next(f for f in files if f['relative_path']=='manual.txt')['kind']=='workspace_file'
    assert next(f for f in files if f['relative_path']=='outputs/plan.json')['kind']=='run_archive'
