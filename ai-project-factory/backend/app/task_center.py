"""Task lifecycle, immutable execution inputs, and retry/acceptance operations."""
import base64
import copy
from pathlib import Path
from fastapi import HTTPException
from pydantic import BaseModel, Field, model_validator
from .models import now
from .schemas import Draft
from .workspaces import safe_path, write_json


class InputFile(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    data: str = Field(max_length=14_000_000)


class TaskOptions(BaseModel):
    expected_updated_at: str | None = None
    input_text: str = Field(default='', max_length=20000)
    acceptance: str = Field(default='', max_length=10000)
    attachments: list[InputFile] = Field(default_factory=list, max_length=10)
    require_review: bool = False
    save_draft: bool = False
    task_id: str | None = None
    source_run: str | None = None
    use_latest: bool = False

    @model_validator(mode='after')
    def validate_attachments(self):
        names=set(); total=0
        for file in self.attachments:
            if Path(file.name).name != file.name or file.name in ('.','..') or '\\' in file.name or file.name in names:
                raise ValueError('输入文件名不可重复或包含目录')
            names.add(file.name)
            try: total += len(base64.b64decode(file.data, validate=True))
            except Exception: raise ValueError('输入文件编码无效') from None
        if total > 10_000_000: raise ValueError('输入附件总大小不能超过10MB')
        return self


def task_inputs(data):
    value={'description':data.description, 'node':data.node}
    for key in ('input_text','acceptance','attachments','require_review'):
        field=getattr(data,key)
        if field: value[key]=[f.model_dump() for f in field] if key=='attachments' else field
    return value


def public_inputs(value):
    result=copy.deepcopy(value)
    result['attachments']=[{'name':f['name'], 'path':'inputs/files/'+f['name'], 'size':len(base64.b64decode(f['data']))} for f in value.get('attachments',[])]
    return result


def nodes_for(snapshot, scope, node, draft=False):
    if draft and not snapshot['definition']['draft'].get('members'): return {}
    definition=Draft.model_validate(snapshot['definition']['draft'])
    owners=[s.owner for s in definition.workflow]
    if scope=='workflow' and len(owners)!=len(set(owners)):
        raise HTTPException(422, '一个员工只能对应一个节点，请先在团队方案中合并该员工的工作步骤')
    steps=[s.model_dump() for s in definition.workflow if scope=='workflow' or s.key==node or s.owner==node]
    if not steps: raise HTTPException(422,'请配置团队员工节点，或选择有效员工')
    members={m.key:m.model_dump() for m in definition.members}
    if scope=='node':
        owner=steps[0]['owner']
        internal=[s.model_dump() for s in definition.workflow if s.owner==owner]
        internal_keys={s['key'] for s in internal}
        combined=copy.deepcopy(internal[0])
        combined['name']=members[owner]['name']
        combined['depends_on']=list(dict.fromkeys(d for s in internal for d in s['depends_on'] if d not in internal_keys))
        for field in ('input','output','acceptance'):
            combined[field]='\n'.join(f"{s['name']}：{s[field]}" for s in internal)
        combined['internal_steps']=internal
        steps=[combined]

    if scope=='node' and (len(steps)!=1 or members[steps[0]['owner']]['kind']!='ai'):
        raise HTTPException(422,'单员工执行必须选择一名 AI 员工')
    return {s['key']:{'step':s,'employee':members[s['owner']], 'status':'pending', 'attempt':None,
                     'thread_id':None,'artifacts':[],'attempts':[]} for s in steps}


def initialize_files(manager, task, run):
    root=manager.directory(task,run)
    for name in ('inputs','nodes','handoffs','outputs','logs'): (root/name).mkdir(parents=True,exist_ok=True)
    inputs=run.state.get('task_inputs',task.inputs)
    for previous in (root/'inputs/files').glob('*'):
        if previous.name not in {f['name'] for f in inputs.get('attachments',[])}:
            safe_path(root/'inputs/files',previous.name).unlink()
    write_json(root/'inputs/task.json',public_inputs(inputs))
    for file in inputs.get('attachments',[]):
        path=safe_path(root/'inputs/files',file['name']); path.parent.mkdir(parents=True,exist_ok=True)
        path.write_bytes(base64.b64decode(file['data']))


def reset_node(node, reason):
    prior={k:copy.deepcopy(v) for k,v in node.items() if k!='attempts'}
    history=node.setdefault('attempts',[])
    if node.get('attempt'): history.append({**prior,'archived_at':now(),'reason':reason})
    node.update(status='pending',attempt=None,thread_id=None,artifacts=[])
    for key in ('question','answer','error','started_at','finished_at','activity','verification','summary'): node.pop(key,None)


class Review(BaseModel):
    approved: bool
    note: str = Field(default='',max_length=12000)
    node: str | None = None


class Retry(BaseModel):
    node: str
    reason: str = Field(default='',max_length=12000)


def install_task_center(app, manager):
    @app.post('/api/workspaces/{project}/agent-runs/{run_id}/start')
    async def start_draft(project: str, run_id: str):
        if len(manager.tasks)>=4: raise HTTPException(429,'已有4个任务执行中，请稍后开始')
        with manager.sessions.begin() as db:
            task,run=manager.rows(db,project,run_id)
            if run.status!='draft': raise HTTPException(409,'该任务已启动')
            if not task.inputs.get('description','').strip(): raise HTTPException(422,'请填写工作要求')
            run.snapshot=manager.workspaces.snapshot(project)
            run.state={**run.state,'nodes':nodes_for(run.snapshot,task.scope,task.inputs.get('node'))}
            run.status='queued';initialize_files(manager,task,run);manager.persist(task,run,run.state)
        manager.launch(project,run_id)
        return {'id':run_id}

    @app.post('/api/workspaces/{project}/agent-runs/{run_id}/retry')
    async def retry(project: str,run_id: str,data: Retry):
        if run_id in manager.tasks: raise HTTPException(409,'请等待当前执行结束')
        if len(manager.tasks)>=4: raise HTTPException(429,'已有4个任务执行中，请稍后重试')
        with manager.sessions.begin() as db:
            task,run=manager.rows(db,project,run_id)
            if run.status not in ('failed','interrupted','cancelled'): raise HTTPException(409,'当前执行不能重试')
            state=copy.deepcopy(run.state);node=state['nodes'].get(data.node)
            if not node or node['status']=='completed': raise HTTPException(409,'只能重试未完成的员工')
            reset_node(node,data.reason or '用户重试')
            state['events'].append({'at':now(),'tool':'retry','node':data.node,'note':data.reason})
            # A fresh coordinator cannot replay the previous attempt's child binding.
            state.setdefault('coordinator_history',[]).append(run.thread_id)
            run.thread_id=None;run.status='queued';state.pop('error',None)
            manager.persist(task,run,state)
        manager.launch(project,run_id)
        return {'id':run_id}

    @app.post('/api/workspaces/{project}/agent-runs/{run_id}/rework')
    async def rework(project: str,run_id: str,data: Retry):
        if run_id in manager.tasks: raise HTTPException(409,'请先停止当前执行')
        if len(manager.tasks)>=4: raise HTTPException(429,'已有4个任务执行中')
        with manager.sessions.begin() as db:
            task,run=manager.rows(db,project,run_id)
            if run.status in ('draft','queued','running'): raise HTTPException(409,'当前状态不能从修改点执行')
            state=copy.deepcopy(run.state)
            if data.node not in state['nodes'] or not data.reason.strip(): raise HTTPException(422,'请选择员工并填写修改要求')
            affected={data.node}
            while True:
                more={k for k,n in state['nodes'].items() if any(d in affected for d in n['step'].get('depends_on',[]))}
                if more<=affected:break
                affected|=more
            for key in affected:
                reset_node(state['nodes'][key],data.reason)
                (manager.directory(task,run)/'handoffs'/f'{key}.json').unlink(missing_ok=True)
            (manager.directory(task,run)/'outputs/index.json').unlink(missing_ok=True)
            state['rework_note']=data.reason
            state.setdefault('events',[]).append({'at':now(),'tool':'rework','node':data.node,'note':data.reason,'affected':sorted(affected)})
            state.setdefault('coordinator_history',[]).append(run.thread_id)
            state.pop('error',None);state.pop('finished_at',None)
            run.thread_id=None;run.status='queued'
            manager.persist(task,run,state)
        manager.launch(project,run_id)
        return {'id':run_id}

    @app.post('/api/workspaces/{project}/agent-runs/{run_id}/review')
    def review(project: str,run_id: str,data: Review):
        with manager.sessions.begin() as db:
            task,run=manager.rows(db,project,run_id)
            if run.status!='awaiting_review' or run_id in manager.tasks: raise HTTPException(409,'当前执行不在待验收状态')
            state=copy.deepcopy(run.state)
            if data.approved:
                run.status='completed';state['finished_at']=now()
            else:
                if not data.note.strip() or data.node not in state['nodes']: raise HTTPException(422,'请选择退回员工并说明原因')
                # Completed downstream outputs must be invalidated together with their input.
                affected={data.node}
                while True:
                    more={k for k,n in state['nodes'].items() if any(d in affected for d in n['step']['depends_on'])}
                    if more<=affected: break
                    affected |= more
                for key in affected: reset_node(state['nodes'][key],data.note)
                (manager.directory(task,run)/'outputs/index.json').unlink(missing_ok=True)
                for key in affected:
                    (manager.directory(task,run)/'handoffs'/f'{key}.json').unlink(missing_ok=True)
                state['rework_note']=data.note
                state.setdefault('coordinator_history',[]).append(run.thread_id)
                run.thread_id=None;run.status='interrupted'
            event={'at':now(),'tool':'review','approved':data.approved,'note':data.note,'node':data.node}
            state.setdefault('reviews',[]).append(event);state['events'].append(event)
            manager.persist(task,run,state)
            return manager.describe(task,run)
