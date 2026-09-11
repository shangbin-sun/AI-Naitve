"""Execute repository reference tests and ask platform Codex to repair their failures."""
from typing import Literal
import copy
from .employee_context import employee_context_from_db
import asyncio
import hashlib
import json
import re
import shutil
import xml.etree.ElementTree as ET
from pathlib import Path

from fastapi import HTTPException
from pydantic import Field
from sqlalchemy import select

from .toolchains import ensure_toolchains
from .output_workspace import prepare_outputs
from .tasks import prepare_task_run, TaskRun, record as task_record
from .models import Evaluation, Source, Message, Employee, now
from .schemas import Strict
from .employee_builder import Package
from .service import get_design, validate_files, apply_draft


class DeliveryRequest(Strict):
    goal: str = Field(min_length=10, max_length=6000)
    max_attempts: int = Field(default=2, ge=1, le=4)
    offline: bool = True
    restart_node: Literal["analysis", "develop", "test"] | None = None
    edits_digest: str | None = None
    resume_run_id: str | None = None
    task_id: str | None = None
    task_version: int | None = None
    task_request_id: str | None = Field(default=None, max_length=100)


class DeliveryPlan(Strict):
    summary: str
    requirements: list[str]
    architecture: list[str]
    employee_instructions: str
    open_questions: list[str]


PLAN = '''你是AI 团队工厂内的需求和架构员工。根据任务、源码和原有测试分析执行流程及最小修复方案。
当前运行事实以run_manifest为准，历史资料中的节点数、环境和版本不代表当前状态。原有测试是参考样例，不能声明其业务覆盖完整；不能更改测试、降低断言或虚构依赖。明确输入、操作、输出与验收，给开发员工可执行的工作指令。不要调用工具，平台负责实际执行。'''
REPAIR = '''你是AI 团队工厂内的代码开发员工。平台已经执行原有参考测试，下面是真实失败日志和冻结源码。
根据需求/架构/员工指令修复失败，返回完整内容的变更文件清单（只返回需要改动的文件）与变更解释，平台负责写入源码副本并重跑原测试。
禁止修改/删除测试、跳过测试、排除模块、伪造报告、降低断言或硬编码测试结果。禁止写入凭据或新增外部服务调用。不执行发布部署。缺少真实外部依赖时说明阻塞，不伪造依赖。
配置阶段读取发布凭据的错误应修为仅真正发布需要凭据，保留发布的凭据校验。不删除发布功能。保留原有功能与模块。
不要自行运行工具。输出Package JSON，summary具体说明本轮根因与修复。'''


def test_manifest(root):
    return {p.relative_to(root).as_posix():hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(root.rglob('*')) if p.is_file() and '/src/test/' in '/'+p.relative_to(root).as_posix()}


def test_results(root):
    cases=[]
    for p in sorted(root.glob('**/build/test-results/test/TEST-*.xml')):
        suite=ET.parse(p).getroot()
        for case in suite.iter('testcase'):
            state='failed' if case.find('failure') is not None or case.find('error') is not None else 'skipped' if case.find('skipped') is not None else 'passed'
            problem=case.find('failure')
            if problem is None:problem=case.find('error')
            cases.append({'suite':case.get('classname',''),'name':case.get('name',''),'status':state,'seconds':case.get('time',''),'report':p.relative_to(root).as_posix(),'difference':problem.get('message','')[:2000] if problem is not None else ''})
    expected=set()
    for source in root.glob('**/src/test/**/*.java'):
        content=source.read_text(errors='replace')
        package=re.search(r'package\s+([\w.]+)\s*;',content)
        if package and re.search(r'@(Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate)\b',content):expected.add(package.group(1)+'.'+source.stem)
    missing=sorted(expected-{c['suite'].split('$')[0] for c in cases})
    return {'missing_reference_classes':missing,'cases':cases,'passed':sum(c['status']=='passed' for c in cases),'failed':sum(c['status']=='failed' for c in cases),'skipped':sum(c['status']=='skipped' for c in cases),'executed':sum(c['status']!='skipped' for c in cases)}


def code_context(root):
    files={}; budget=150000
    # Full build definitions and reference tests first; source is selectively included, with scope explicit.
    paths=sorted(root.rglob('*.gradle.kts'))+sorted(root.glob('**/src/test/**/*.java'))+sorted(root.glob('**/src/main/**/*.java'))
    for p in paths:
        name=p.relative_to(root).as_posix()
        if any(part in {'.gradle-home','build','.gradle'} for part in p.relative_to(root).parts):continue
        text=p.read_text(errors='replace')
        if len(text)>budget:continue
        files[name]=text;budget-=len(text)
    return {'files':files,'scope':'按构建配置、测试、源码优先读取，上限150000字符；未包含全部代码'}


def apply_patch_files(root, files, frozen):
    validate_files(files)
    for name in files:
        if name.endswith('settings.gradle.kts'):raise ValueError('本轮禁止改变AI 团队模块清单')
        if name in frozen or '/src/test/' in '/'+name or not name.endswith(('.java','.kt','.gradle.kts')):
            raise ValueError('开发员工只能修改生产源码或Gradle配置，不能修改参考测试：'+name)
        path=root/name
        if not path.resolve().is_relative_to(root.resolve()) or path.is_symlink():raise ValueError('非法补丁路径')
    for name,content in files.items():
        path=root/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_text(content)
    if test_manifest(root)!=frozen:raise ValueError('参考测试发生变化，拒绝验收')


async def delivery(manager, identity, inputs):
    root=manager.settings.data_dir/'deliveries'/identity
    root.mkdir(parents=True)
    source=manager.root/inputs['code_source_id']
    frozen=test_manifest(source)
    result={'stage':'baseline','events':[],'attempts':[], 'reference_tests':frozen,
            'scope':'源码原有JUnit测试驱动的需求、架构、开发、回归流程；未覆盖部署与完整业务验收',
            'benchmark_status':'repository_reference','reference_test_files':len(frozen)}
    def save():
        with manager.sessions.begin() as db:
            row=db.get(Evaluation,identity)
            row.result=copy.deepcopy(result)
        with manager.sessions() as db:
            prepare_outputs(manager.settings.data_dir/'output-workspaces', db.get(Evaluation,identity))
    async def log(text):result['events'].append(text);save()
    async def invoke(role, attempt, payload, schema, instructions):
        capability = next((e.get('instruction_bundle') for e in inputs.get('employees', []) if e['key'] == role), None)
        if capability:
            instructions += '\n' + capability['content']
        record={'loaded_capability':capability,'employee_key':role,'attempt':attempt,'input':copy.deepcopy(payload),'instructions':instructions,'events':[],'status':'running','started_at':now(),'model':manager.settings.codex_model,'reasoning_effort':manager.settings.codex_reasoning_effort,'output_schema':schema.model_json_schema()}
        result.setdefault('employee_records',[]).append(record);save()
        async def employee_log(text):
            record['events'].append(text)
            await log(text)
        try:
            response, usage = await manager.runtime.structured(payload,schema,instructions,employee_log)
            record.update(status='completed',finished_at=now(),output=response.model_dump(),usage=usage);save()
            return response, usage
        except BaseException as error:
            record.update(finished_at=now(),status='interrupted' if isinstance(error, asyncio.CancelledError) else 'failed',error=str(error));save()
            raise
    await log(f'冻结源码快照中的{len(frozen)}个原有测试文件，先执行基线')
    result['stage']='environment'
    try:
        result['toolchains']=await ensure_toolchains(manager.settings.data_dir,source,inputs.get('offline',True),log)
    except Exception as e:
        result.update(stage='blocked',summary='工具链准备失败：'+str(e),workspace=inputs.get('resume_workspace') or str(source))
        await log(result['summary'])
        return result,'blocked'
    inputs={**inputs,'java_homes':[r['home'] for r in result['toolchains']]}
    save()
    prepared=None
    if inputs.get('resume_workspace'):
        prepared=root/'resume-baseline'
        shutil.copytree(inputs['resume_workspace'],prepared,ignore=shutil.ignore_patterns('build','.gradle','baseline.log'))
        # Import newly included resource files without replacing prior employee changes.
        for file in source.rglob('*'):
            target=prepared/file.relative_to(source)
            if file.is_file() and not target.exists():
                target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(file,target)
        if test_manifest(prepared)!=frozen:raise ValueError('续跑版本的参考测试与来源不一致')
        await log('从指定运行的最后代码版本继续，保留原记录')
    edits=(inputs.get('editor_snapshot') or {}).get('changes', [])
    if edits:
        if prepared is None:
            prepared=root/'edited-baseline'
            shutil.copytree(source,prepared,ignore=shutil.ignore_patterns('build','.gradle'))
        patches={c['name']:c['content'] for c in edits if 'develop' in c.get('step_id','')}
        if patches:apply_patch_files(prepared,patches,frozen)
        await log(f'已将 {len(edits)} 项工作目录修改冻结到本轮输入，历史记录保持原样')
    result['stage']='test' if inputs.get('restart_node')=='test' else 'baseline'
    await log('运行源码原有测试，等待Gradle退出与JUnit报告；没有报告不计通过')
    baseline=await manager.baseline(identity,{**inputs,'timeout_seconds':300},prepared=prepared)
    current=Path(baseline['workspace'])
    checked=test_results(current)
    result['attempts'].append({'attempt':0,**baseline,'tests':checked});save()
    if baseline['exit_code']==0 and checked['executed']>0 and not checked['failed'] and not checked['skipped'] and not checked['missing_reference_classes'] and inputs.get('restart_node') not in ('analysis','develop'):
        result['stage']='complete';result['summary']='本轮起始代码已通过原有参考测试，无需新增源码修改';result['workspace']=str(current)
        if inputs.get('previous_plan'):result['plan']=inputs['previous_plan']
        return result,'completed'
    if inputs.get('restart_node') == 'test':
        result.update(stage='blocked', summary='修改后的代码未通过参考测试；仅验证模式未调用开发员工', workspace=str(current))
        return result,'blocked'
    result['stage']='analyze'
    await log('基线未通过，平台调用Codex分析需求、架构与开发员工操作规则')
    if inputs.get('restart_node') == 'develop':
        result['plan']=inputs['previous_plan']
    else:
        plan,usage=await invoke('it_analysis',0,{'goal':inputs['goal'],'sources':inputs['sources'],
            'run_manifest':{'run_id':identity,'project':inputs.get('project',{}),'code_source_id':inputs['code_source_id'],'reference_test_files':len(frozen),'wrapper_present':(current/'gradlew').is_file(),'toolchains':result.get('toolchains',[])},'code':code_context(current),'employees':inputs.get('employees',[]),'failure':baseline['output']},DeliveryPlan,PLAN)
        result['plan']=plan.model_dump();result['planning_usage']=usage
    (root/'plan.json').write_text(json.dumps(result['plan'],ensure_ascii=False,indent=2))
    feedback=baseline
    for attempt in range(1,inputs['max_attempts']+1):
        result['stage']='develop';await log(f'第{attempt}轮：平台开发员工根据实际失败生成修复')
        package,usage=await invoke('it_development',attempt,{'goal':inputs['goal'],'plan':result['plan'],
            'code':code_context(current),'employees':inputs.get('employees',[]),'failure':feedback.get('output',''),'previous_changes':result.get('last_changes',{})},Package,REPAIR)
        files={f.path:f.content for f in package.files}
        if len(files)!=len(package.files):raise ValueError('重复补丁路径')
        if not files:
            result['summary']=package.summary
            latest=result['attempts'][-1]
            tests=latest.get('tests',{})
            if latest.get('exit_code')==0 and tests.get('executed',0)>0 and not any(tests.get(k) for k in ('failed','skipped','missing_reference_classes')):
                result.update(stage='complete',workspace=str(current))
                return result,'completed'
            break
        next_root=root/f'attempt-{attempt}'
        shutil.copytree(current,next_root,ignore=shutil.ignore_patterns('build','.gradle','baseline.log'))
        try:apply_patch_files(next_root,files,frozen)
        except (ValueError,HTTPException) as e:
            feedback={'output':str(e)}
            result['attempts'].append({'attempt':attempt,'error':str(e),'usage':usage});save();continue
        result['last_changes']=files
        result['artifacts']=[{'path':name,'content':value,'sha256':hashlib.sha256(value.encode()).hexdigest()} for name,value in files.items()]
        (root/f'changes-{attempt}.json').write_text(json.dumps({'summary':package.summary,'files':files},ensure_ascii=False,indent=2))
        result['stage']='test';await log(f'第{attempt}轮：隔离副本应用修复，运行未修改的原有测试')
        run=await manager.baseline(identity,{**inputs,'timeout_seconds':300},prepared=next_root)
        checked=test_results(next_root)
        intact=test_manifest(next_root)==frozen
        entry={'attempt':attempt,'summary':package.summary,'changed_files':list(files),'usage':usage,
               'reference_intact':intact,'artifacts':copy.deepcopy(result.get('artifacts',[])),**run,'tests':checked}
        result['attempts'].append(entry);save()
        current=next_root;feedback=run
        if not intact:raise ValueError('执行后参考测试哈希发生变化，停止验收')
        if run['exit_code']==0 and checked['executed']>0 and not checked['failed'] and not checked['skipped'] and not checked['missing_reference_classes']:
            result['stage']='complete';result['summary']=f'平台修复后，{checked["passed"]}项原有测试通过；部署和完整业务覆盖仍未验证'
            result['workspace']=str(current);return result,'completed'
        await log('记录测试失败与未运行项，反馈到下一轮开发；保留每轮代码和报告')
    result['stage']='blocked';result.setdefault('summary','达到本轮迭代上限，参考测试尚未全部通过；保留失败证据，不宣称交付成功')
    result['workspace']=str(current)
    return result,'blocked'


def install_delivery(app,manager):
    @app.post('/api/workspaces/{identity}/delivery-runs',status_code=202)
    async def start(identity:str,data:DeliveryRequest):
        with manager.sessions.begin() as db:
            design=get_design(db,identity)
            task,duplicate=prepare_task_run(db,identity,data)
            if duplicate:return task_record(duplicate)
            if task:
                data=data.model_copy(update={"goal":task.description+"\n验收要求："+task.acceptance})
            if db.scalar(select(Evaluation.id).where(Evaluation.design_id==identity,Evaluation.status.in_(['queued','running']))):raise HTTPException(409,'AI 团队已有运行进行中')
            sources=manager.context(db,identity)
            if task:sources=[s for s in sources if s["kind"]!="code" or s["id"]==task.code_source_id]
            source=next((s for s in reversed(sources) if s['kind']=='code' and (not task or s['id']==task.code_source_id) and (manager.root/s['id']).is_dir()),None)
            if not source:raise HTTPException(422,'先导入AI 团队源码与测试样例')
            if not test_manifest(manager.root/source['id']):raise HTTPException(422,'源码快照没有src/test参考测试')
            resume_workspace=None;previous_plan=None;editor_inputs=None
            if (data.restart_node or data.edits_digest) and (not task or not data.resume_run_id):raise HTTPException(422,'节点运行需要选择本任务的历史运行')
            if data.resume_run_id:
                prior=db.get(Evaluation,data.resume_run_id)
                if not prior or prior.design_id!=identity or prior.kind!='delivery' or prior.status not in ['blocked','completed','failed','cancelled','interrupted']:raise HTTPException(422,'请选择同AI 团队已结束的研发记录')
                if prior.inputs['code_source_id']!=source['id']:
                    old_source=db.get(Source,prior.inputs['code_source_id'])
                    new_source=db.get(Source,source['id'])
                    old_files={f['path']:f['sha256'] for f in json.loads(old_source.content)['files']}
                    new_files={f['path']:f['sha256'] for f in json.loads(new_source.content)['files']}
                    if any(new_files.get(p)!=h for p,h in old_files.items()):raise HTTPException(409,'原源码基线内容已变化，请从新基线启动；仅新增缺失资源可续跑')
                resume_workspace=prior.result.get('workspace') or next((a.get('workspace') for a in reversed(prior.result.get('attempts',[])) if a.get('workspace')), None) or prior.inputs.get('resume_workspace') or str(manager.root/source['id']);previous_plan=prior.result.get('plan') or prior.inputs.get('previous_plan')
                if not prior.result.get('attempts'):editor_inputs=copy.deepcopy(prior.inputs.get('editor_snapshot'))
                if not resume_workspace or not Path(resume_workspace).is_dir():raise HTTPException(422,'该运行没有可继续的代码版本')
            if data.edits_digest:
                from .run_flow import editor_snapshot
                from .tasks import task_lineage
                editor_inputs=editor_snapshot(manager.root.parent/'output-workspaces',task_lineage(db,task.id,data.resume_run_id))
                if editor_inputs['digest'] != data.edits_digest:raise HTTPException(409,'文件再次发生修改，请刷新节点后重试')
                for change in editor_inputs['changes']:
                    if change.get('deleted'):raise HTTPException(422,'暂不支持采用删除文件，请恢复后重试')
                    if 'analysis' in change.get('step_id',''):
                        if data.restart_node=='test':raise HTTPException(422,'需求方案已修改，请从开发继续，使代码符合新方案后再测试')
                        try:previous_plan=DeliveryPlan.model_validate_json(change['content']).model_dump()
                        except Exception:raise HTTPException(422,'修改的需求方案不符合结构，请检查 JSON 字段')
                    elif 'develop' in change.get('step_id',''):
                        name=change['name']
                        validate_files({name:change['content']})
                        if name.endswith('settings.gradle.kts') or '/src/test/' in '/'+name or not name.endswith(('.java','.kt','.gradle.kts')):raise HTTPException(422,'只能采用生产源码或 Gradle 配置修改')
                    else:raise HTTPException(422,'此类修改暂不支持作为执行输入')
            if data.restart_node=='test' and any('analysis' in c.get('step_id','') for c in (editor_inputs or {}).get('changes',[])):raise HTTPException(422,'需求方案已修改，请从开发继续')
            if data.restart_node=='develop' and not previous_plan:raise HTTPException(422,'请先运行需求与架构，生成方案后再开发')
            row=Evaluation(design_id=identity,design_version=design.version,kind='delivery',inputs={**data.model_dump(),'editor_snapshot':editor_inputs,'resume_workspace':resume_workspace,'previous_plan':previous_plan,
                'task_snapshot':task_record(task) if task else None,'team_snapshot':[{'id':e.id,'key':e.key,'version':e.version,'profile':copy.deepcopy(e.profile)} for e in db.scalars(select(Employee).where(Employee.design_id==identity,Employee.active.is_(True)))],'workflow_snapshot':copy.deepcopy(design.draft),'project':{'version':design.version,'workflow_nodes':len(design.draft.get('workflow',[]))},'code_source_id':source['id'],'sources':sources,'employees':[{'key':e.key,'version':e.version,'profile':e.profile,'instruction_bundle':employee_context_from_db(db,e),'runtime_manifest':e.files.get('runtime.json',''),'instructions':e.files.get('AGENTS.md',e.profile.get('instructions',''))} for e in db.scalars(select(Employee).where(Employee.design_id==identity,Employee.active.is_(True))) if e.key.startswith('it_')]})
            db.add(Message(design_id=identity,role='user',content=data.goal))
            db.add(Message(design_id=identity,role='assistant',content='已启动原有样例驱动的AI 团队开发流程。平台将保存每轮需求/架构分析、代码修复和参考测试结果；请在资料与评估查看进度。'))
            db.add(row);db.flush()
            if task:db.add(TaskRun(task_id=task.id,evaluation_id=row.id,request_id=data.task_request_id))
            record={c.name:getattr(row,c.name) for c in row.__table__.columns}
        manager.start(record['id']);return record

    manager.start_delivery=start

    @app.post('/api/evaluations/{identity}/materialize-workers')
    def materialize(identity:str):
        with manager.sessions.begin() as db:
            row=db.get(Evaluation,identity)
            if not row or row.kind!='delivery':raise HTTPException(404,'AI 团队研发记录不存在')
            if row.status not in ['completed','blocked']:raise HTTPException(422,'等待本轮研发完成后保存员工')
            if row.result.get('worker_ids'):return {'worker_ids':row.result['worker_ids']}
            plan=row.result.get('plan')
            if not plan:raise HTTPException(422,'没有员工操作方案')
            design=get_design(db,row.design_id)
            if design.version!=row.design_version:raise HTTPException(409,'AI 团队版本已变化，保留研发结果，未覆盖员工')
            draft=copy.deepcopy(design.draft) or {'name':design.title,'goal':row.inputs['goal'],'members':[],'workflow':[],'requirements':[],'assumptions':[],'questions':[],'ready':False}
            specs=[('it_analysis','需求与架构员工','analyze','读取任务、来源和原测试，明确需求、架构约束、疑问和最小改动计划。'),
                   ('it_development','代码开发员工','develop',plan['employee_instructions']),
                   ('it_validation','参考测试验证员工','test','冻结原有测试，执行实际Gradle测试，解析JUnit报告。没有执行测试不得通过；禁止修改测试或伪造报告。')]
            previous=None
            for key,name,stage,instructions in specs:
                if any(m['key']==key and m['role']!='平台源码研发员工' for m in draft['members']):raise HTTPException(409,'员工标识冲突，未覆盖现有岗位')
                profile={'key':key,'name':name,'role':'平台源码研发员工','kind':'ai','responsibilities':[instructions],'instructions':instructions,
                         'skills':['Codex','Gradle','JUnit'],'inputs':['任务说明、源码快照、原有测试与上轮失败'],'outputs':['可追溯方案、源码变更或真实测试报告']}
                draft['members']=[m for m in draft['members'] if m['key']!=key]+[profile]
                node={'key':key+'_step','name':name+'工作','owner':key,'kind':'work','depends_on':[previous] if previous else [],
                      'input':'冻结的任务、源码与上游产物','output':'平台版本化产物与执行记录','acceptance':'原有参考测试哈希不变，实际执行并通过；无报告不能通过'}
                draft['workflow']=[n for n in draft['workflow'] if n['key']!=node['key']]+[node]
                previous=node['key']
            old_versions={e.key:e.version for e in db.scalars(select(Employee).where(Employee.design_id==design.id))}
            apply_draft(db,design.id,design.version,draft,'platform_delivery_workers')
            ids=[]
            for key,name,stage,instructions in specs:
                worker=db.scalar(select(Employee).where(Employee.design_id==design.id,Employee.key==key))
                if key in old_versions and worker.version==old_versions[key]:worker.version+=1
                worker.files={**worker.files,'AGENTS.md':instructions,
                    '.agents/skills/delivery/SKILL.md':'---\nname: delivery\ndescription: Run the platform reference-test delivery workflow\n---\n'+instructions,
                    'runtime.json':json.dumps({'adapter':'gradle_delivery','stage':stage,'run_id':identity,'quality':row.status,'entrypoint':'POST /api/workspaces/{project_id}/delivery-runs'},ensure_ascii=False),
                    'evaluations/reference-tests.json':json.dumps(row.result['reference_tests'],ensure_ascii=False),
                    'evaluations/latest-result.json':json.dumps({'run_id':identity,'status':row.status,'summary':row.result.get('summary')},ensure_ascii=False)}
                ids.append(worker.id)
            row.result={**row.result,'worker_ids':ids,'installed_design_version':design.version}
            return {'worker_ids':ids}
    manager.materialize_delivery_workers=materialize
