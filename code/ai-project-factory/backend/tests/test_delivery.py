import asyncio
import json
import shutil
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from app.config import Settings
from app.main import create_app
from app.delivery import DeliveryPlan, apply_patch_files, test_manifest as manifest, test_results as results
from app.employee_builder import Package


def test_reference_files_protected_and_reports_distinguish_skips(tmp_path):
    src=tmp_path/'m/src/test/java/T.java';src.parent.mkdir(parents=True);src.write_text('original assert')
    frozen=manifest(tmp_path)
    with pytest.raises(ValueError):apply_patch_files(tmp_path,{'m/src/test/java/T.java':'pass'},frozen)
    assert src.read_text()=='original assert'
    report=tmp_path/'m/build/test-results/test/TEST-x.xml';report.parent.mkdir(parents=True)
    report.write_text('<testsuite><testcase name="good"/><testcase name="bad"><failure/></testcase><testcase name="skip"><skipped/></testcase></testsuite>')
    result=results(tmp_path)
    assert (result['executed'],result['passed'],result['failed'],result['skipped'])==(2,1,1,1)


def test_platform_delivery_uses_actual_feedback_and_keeps_original_tests(tmp_path):
    class Runtime:
        calls=[]
        async def structured(self,context,model,system,on_event):
            self.calls.append(context)
            if model is DeliveryPlan:return DeliveryPlan(summary='repair',requirements=['keep tests'],architecture=['lazy credentials'],employee_instructions='修复配置并回归',open_questions=[]),{}
            assert context['failure']=='credentials missing'
            return Package(summary='lazy credentials',files=[{'path':'build.gradle.kts','content':'fixed'}]),{}
    runtime=Runtime();app=create_app(Settings(tmp_path,f'sqlite:///{tmp_path}/db','codex','',5),runtime)
    with TestClient(app) as client:
        manager=app.state.evidence
        root=tmp_path/'original';root.mkdir();(root/'build.gradle.kts').write_text('broken')
        test=root/'m/src/test/java/T.java';test.parent.mkdir(parents=True);test.write_text('frozen assert')
        manager.allowed=root
        pid=client.post('/api/designs',json={'title':'sample'}).json()['id']
        source=client.post(f'/api/workspaces/{pid}/sources/import-code',json={'path':str(root)}).json()
        async def baseline(identity,inputs,prepared=None):
            dest=prepared or tmp_path/'checks'/identity
            if prepared is None:shutil.copytree(manager.root/inputs['code_source_id'],dest)
            good=(dest/'build.gradle.kts').read_text()=='fixed'
            if good:
                report=dest/'m/build/test-results/test/TEST-x.xml';report.parent.mkdir(parents=True)
                report.write_text('<testsuite><testcase name="reference"/></testsuite>')
            return {'workspace':str(dest),'exit_code':0 if good else 1,'output':'ok' if good else 'credentials missing'}
        manager.baseline=baseline
        start=client.post(f'/api/workspaces/{pid}/delivery-runs',json={'goal':'修复原有样例并保留原始测试断言','max_attempts':2})
        assert start.status_code==202,start.text
        for _ in range(200):
            run=client.get(f'/api/workspaces/{pid}/evaluations').json()[0]
            if run['status'] not in ['queued','running']:break
            time.sleep(.01)
        assert run['status']=='completed',run
        assert len(run['result']['attempts'])==2
        assert run['result']['attempts'][1]['tests']['passed']==1
        assert run['result']['attempts'][1]['reference_intact']
        records=run['result']['employee_records']
        assert [r['employee_key'] for r in records]==['it_analysis','it_development']
        assert all(r['status']=='completed' and r['input'] and r['output'] and r['instructions'] for r in records)
        archive=manager.settings.data_dir/'output-workspaces'/run['id']/'employees'/'it_development'
        assert (archive/'process/calls.json').is_file()
        assert (archive/'inputs/run-context.json').is_file()
        assert run['result']['attempts'][1]['artifacts'][0]['content']=='fixed'
        assert run['result']['attempts'][1]['artifacts'][0]['path']=='build.gradle.kts'
        assert (root/'build.gradle.kts').read_text()=='broken'
        assert test.read_text()=='frozen assert'
        for _ in range(100):
            run=client.get(f'/api/workspaces/{pid}/evaluations').json()[0]
            if run['result'].get('worker_ids'):break
            time.sleep(.01)
        assert len(run['result']['worker_ids'])==3
        resource=root/'m/src/main/resources/config.yaml';resource.parent.mkdir(parents=True);resource.write_text('sample: true')
        assert client.post(f'/api/workspaces/{pid}/sources/import-code',json={'path':str(root)}).status_code==201
        next_run=client.post(f'/api/workspaces/{pid}/delivery-runs',json={'goal':'从已修复版本补齐资源并继续验证','resume_run_id':run['id']})
        assert next_run.status_code==202,next_run.text
        for _ in range(200):
            resumed=client.get(f'/api/workspaces/{pid}/evaluations').json()[0]
            if resumed['status']=='completed' and resumed['result'].get('worker_ids'):break
            time.sleep(.01)
        assert resumed['status']=='completed',resumed
        assert len(runtime.calls)==2, 'passing resume should not rebuild code'
        assert len(resumed['inputs']['employees'])==3
        assert (Path(resumed['result']['workspace'])/'m/src/main/resources/config.yaml').read_text()=='sample: true'
        employee=client.get('/api/employees/'+resumed['result']['worker_ids'][0]).json()
        assert employee['version']==2


def test_source_import_includes_runtime_and_test_resources(tmp_path):
    root=tmp_path/'source';root.mkdir()
    for name in ['config/src/main/resources/config.yaml','m/src/test/resources/sample.json','gradle.properties']:
        path=root/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_text('sample')
    (root/'.env').write_text('private')
    app=create_app(Settings(tmp_path/'data',f'sqlite:///{tmp_path}/db','codex','',5),object())
    with TestClient(app) as client:
        app.state.evidence.allowed=root
        pid=client.post('/api/designs',json={'title':'resources'}).json()['id']
        row=client.post(f'/api/workspaces/{pid}/sources/import-code',json={'path':str(root)}).json()
        names={f['path'] for f in json.loads(row['content'])['files']}
        assert names=={'config/src/main/resources/config.yaml','m/src/test/resources/sample.json','gradle.properties'}


def test_missing_reference_class_cannot_disappear_from_report(tmp_path):
    source=tmp_path/'m/src/test/java/MissingTest.java';source.parent.mkdir(parents=True);source.write_text('package x; class MissingTest { @Test void check() {} }')
    report=tmp_path/'m/build/test-results/test/TEST-x.xml';report.parent.mkdir(parents=True);report.write_text('<testsuite><testcase classname="x.OtherTest" name="passed"/></testsuite>')
    assert results(tmp_path)['missing_reference_classes']==['x.MissingTest']
