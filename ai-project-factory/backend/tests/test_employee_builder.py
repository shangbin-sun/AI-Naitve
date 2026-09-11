import asyncio
import json
import sys
from pathlib import Path

import pytest
from app.employee_builder import execute, verify_files, validate_blueprint
from app.service import validate_files
from fastapi import HTTPException


def test_skill_paths_allowed_but_hidden_and_traversal_rejected():
    validate_files({'.agents/skills/process/SKILL.md':'rules','employee.py':'print(1)'})
    for path in ['.git/config','.agents/config.toml','.agents/skills/../../escape','../escape','/tmp/escape']:
        with pytest.raises(HTTPException):validate_files({path:'bad'})


def test_blueprint_needs_sources_and_both_sample_splits():
    cases=[{'id':str(i),'split':'development' if i<2 else 'validation','source_ids':['s'],'input_json':'{}','expected_json':'{}'} for i in range(3)]
    validate_blueprint({'samples':cases},{'s'})
    cases[2]['source_ids']=['unknown']
    with pytest.raises(ValueError):validate_blueprint({'samples':cases},{'s'})


@pytest.mark.skipif(sys.platform!='darwin',reason='macOS worker sandbox')
def test_real_worker_sandbox_blocks_host_file_and_network(tmp_path):
    work=tmp_path/'work';work.mkdir()
    # Use a unique host-side fixture, never real credentials.
    import tempfile
    with tempfile.NamedTemporaryFile(dir=Path.home(),prefix='.factory-test-') as f:
        Path(f.name).write_text('not readable')
        (work/'employee.py').write_text('import pathlib,socket,json\nr={}\ntry:\n pathlib.Path('+repr(f.name)+').read_text();r["host"]=True\nexcept PermissionError:r["host"]=False\ntry:\n s=socket.socket();s.connect(("127.0.0.1",9));r["network"]=True\nexcept OSError:r["network"]=False\nprint(json.dumps(r))')
        result=asyncio.run(execute(work,['employee.py']))
        assert result['exit_code']==0,result
        assert json.loads(result['stdout'])=={'host':False,'network':False}


@pytest.mark.skipif(sys.platform!='darwin',reason='macOS worker sandbox')
def test_actual_sample_output_is_compared_not_employee_claim(tmp_path):
    cases=[{'id':'a','split':'validation','input_json':'{"value":2}','expected_json':'{"value":4}'}]
    files={'employee.py':'import json,sys\na=json.load(sys.stdin);print(json.dumps({"value":a["value"]*2}))'}
    good=asyncio.run(verify_files(tmp_path/'good',files,cases,'validation'))
    assert good[0]['passed']
    files['employee.py']='print("{\\"passed\\":true}")'
    bad=asyncio.run(verify_files(tmp_path/'bad',files,cases,'validation'))
    assert not bad[0]['passed']


@pytest.mark.skipif(sys.platform!='darwin',reason='macOS worker sandbox')
@pytest.mark.parametrize('heldout_fails',[False,True])
def test_platform_repairs_real_failure_and_gates_installation(tmp_path, heldout_fails):
    import copy
    import time
    from fastapi.testclient import TestClient
    from app.main import create_app
    from app.config import Settings
    from app.employee_builder import Blueprint, Package
    from test_factory import DRAFT

    class Runtime:
        calls=[]
        async def structured(self, context, model, system, on_event):
            if model is Blueprint:
                return Blueprint(name='自动研发员工',objective='整数翻倍',interface_rules='输出value乘以2',samples=[
                    dict(id=str(i),split='development' if i<2 else 'validation',source_ids=[context['sources'][0]['id']],input_json=json.dumps({'value':i+1}),expected_json=json.dumps({'value':99 if heldout_fails and i==2 else (i+1)*2}),rationale='测试资料') for i in range(3)]),{}
            self.calls.append(copy.deepcopy(context))
            multiplier=1 if len(self.calls)==1 else 2
            files={'employee.py':f'import json,sys\na=json.load(sys.stdin);print(json.dumps({{"value":a["value"]*{multiplier}}}))',
                   'AGENTS.md':'处理输入并自检', 'README.md':'员工工程', '.agents/skills/process/SKILL.md':'---\nname: process\ndescription: process data\n---',
                   'tests/test_employee.py':'import unittest\nclass Check(unittest.TestCase):\n def test_one(self):self.assertEqual(1+1,2)\n def test_two(self):self.assertEqual(2+2,4)'}
            return Package(summary='测试工程',files=[{'path':k,'content':v} for k,v in files.items()]),{}
    runtime=Runtime();runtime.calls=[]
    app=create_app(Settings(tmp_path,f'sqlite:///{tmp_path}/db','codex','',5),runtime)
    with TestClient(app) as client:
        identity=client.post('/api/designs',json={'title':'研发闭环'}).json()['id']
        assert client.put(f'/api/designs/{identity}/draft',json={'expected_version':0,'draft':DRAFT}).status_code==200
        client.post(f'/api/workspaces/{identity}/sources',json={'title':'参考','location':'fixture','kind':'contracts','coverage':'full','content':'value翻倍'})
        start=client.post(f'/api/workspaces/{identity}/employee-builds',json={'goal':'根据参考自动开发可执行翻倍员工','max_attempts':2})
        assert start.status_code==202,start.text
        for _ in range(200):
            row=client.get(f'/api/workspaces/{identity}/evaluations').json()[0]
            if row['status'] not in ['queued','running'] and (heldout_fails or row['result'].get('employee_id')):break
            time.sleep(.02)
        assert row['status']==('blocked' if heldout_fails else 'completed'),row
        assert len(runtime.calls)==2
        assert all(s['split']=='development' for c in runtime.calls for s in c['blueprint']['samples'])
        assert runtime.calls[1]['feedback'][0]['development'][0]['actual']=={'value':1}
        assert row['result']['attempts'][0]['cases'][0]['passed'] is False
        assert row['result']['attempts'][1]['cases'][-1]['passed'] is not heldout_fails
        project=client.get(f'/api/designs/{identity}').json()
        assert project['draft']['members'][0]==DRAFT['members'][0]
        assert len(project['employees'])==(1 if heldout_fails else 2)
        install=client.post(f"/api/evaluations/{row['id']}/install-employee")
        assert install.status_code==(422 if heldout_fails else 200)
        if not heldout_fails:
            assert install.json()['employee_id']==row['result']['employee_id']
            assert project['version']==2
            started=client.post(f"/api/employees/{row['result']['employee_id']}/runs",json={'input_json':'{"value":7}'})
            assert started.status_code==202
            for _ in range(100):
                trial=client.get(f'/api/workspaces/{identity}/evaluations').json()[0]
                if trial['status'] not in ['queued','running']:break
                time.sleep(.02)
            assert trial['kind']=='employee_run' and trial['status']=='completed',trial
            assert json.loads(trial['result']['output'])=={'value':14}
            assert trial['inputs']['employee_version']==1
            assert client.post(f"/api/employees/{row['result']['employee_id']}/runs",json={'input_json':'invalid'}).status_code==422


@pytest.mark.skipif(sys.platform!='darwin',reason='macOS worker sandbox')
def test_worker_can_write_team_project_but_not_other_directory(tmp_path):
    team=tmp_path/'team';team.mkdir()
    work=tmp_path/'work';work.mkdir()
    outside=tmp_path/'other';outside.mkdir()
    (team/'resource.txt').write_text('team resource')
    (work/'employee.py').write_text('import pathlib,json\nr={}\np=pathlib.Path('+repr(str(team))+')\nr["read"]= (p/"resource.txt").read_text()\n(p/"new.txt").write_text("saved")\nr["write"]=True\ntry:\n pathlib.Path('+repr(str(outside/'blocked.txt'))+').write_text("bad");r["outside"]=True\nexcept PermissionError:r["outside"]=False\nprint(json.dumps(r))')
    result=asyncio.run(execute(work,['employee.py'],read_root=team))
    assert result['exit_code']==0,result
    assert json.loads(result['stdout'])=={'read':'team resource','write':True,'outside':False}
