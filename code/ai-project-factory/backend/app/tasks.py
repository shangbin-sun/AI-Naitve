"""Persistent work items; execution remains owned by the existing delivery runner."""
import asyncio
import json
from typing import Literal

from fastapi import HTTPException, Response
from pydantic import Field
from sqlalchemy import ForeignKey, Integer, String, Text, UniqueConstraint, select
from sqlalchemy.orm import Mapped, mapped_column

from .models import Base, Evaluation, Source, now, uid
from .schemas import Strict
from .web_editor import EditorRequest, editor_url
from .service import get_design


class WorkTask(Base):
    __tablename__ = 'work_tasks'
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    design_id: Mapped[str] = mapped_column(ForeignKey('designs.id'), index=True)
    title: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text)
    acceptance: Mapped[str] = mapped_column(Text, default='')
    code_source_id: Mapped[str | None] = mapped_column(ForeignKey('sources.id'), nullable=True)
    version: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[str] = mapped_column(String, default=now)
    updated_at: Mapped[str] = mapped_column(String, default=now)


class TaskRun(Base):
    __tablename__ = 'task_runs'
    __table_args__ = (UniqueConstraint('task_id', 'request_id'),)
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    task_id: Mapped[str] = mapped_column(ForeignKey('work_tasks.id'), index=True)
    evaluation_id: Mapped[str] = mapped_column(ForeignKey('evaluations.id'), unique=True)
    request_id: Mapped[str] = mapped_column(String(100))


class TaskDefinition(Strict):
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(min_length=10, max_length=4000)
    acceptance: str = Field(default='', max_length=1000)
    code_source_id: str | None = None


class TaskEdit(TaskDefinition):
    expected_version: int


class TaskStart(Strict):
    expected_version: int
    request_id: str = Field(min_length=1, max_length=100)
    resume_run_id: str | None = None
    max_attempts: int = Field(default=2, ge=1, le=4)
    offline: bool = False
    restart_node: Literal["analysis", "develop", "test"] | None = None
    edits_digest: str | None = None


def record(row):
    return {c.name: getattr(row, c.name) for c in row.__table__.columns}


def get_task(db, project_id, task_id):
    task = db.get(WorkTask, task_id)
    if not task or task.design_id != project_id:
        raise HTTPException(404, '任务不存在')
    return task


def validate_source(db, project_id, source_id):
    if source_id:
        source = db.get(Source, source_id)
        if not source or source.design_id != project_id or source.kind != 'code':
            raise HTTPException(422, '请选择本项目导入的源码快照')


def prepare_task_run(db, project_id, data):
    """Called inside delivery creation's transaction, before runner dispatch."""
    if not data.task_id:
        return None, None
    task = get_task(db, project_id, data.task_id)
    if not data.task_request_id:
        raise HTTPException(422, '缺少任务运行请求标识')
    link = db.scalar(select(TaskRun).where(TaskRun.task_id == task.id, TaskRun.request_id == data.task_request_id))
    if link:
        return task, db.get(Evaluation, link.evaluation_id)
    if data.task_version != task.version:
        raise HTTPException(409, '任务已修改，请刷新后运行')
    if not task.code_source_id:
        raise HTTPException(422, '请先为任务选择源码与测试样例快照')
    validate_source(db, project_id, task.code_source_id)
    if data.resume_run_id and not db.scalar(select(TaskRun).where(TaskRun.task_id == task.id, TaskRun.evaluation_id == data.resume_run_id)):
        raise HTTPException(422, '只能从此任务自己的运行继续')
    return task, None


def task_lineage(db, task_id, run_id):
    runs, seen = [], set()
    while run_id and run_id not in seen:
        seen.add(run_id)
        if not db.scalar(select(TaskRun).where(TaskRun.task_id == task_id, TaskRun.evaluation_id == run_id)):
            raise HTTPException(404, '此任务的运行不存在')
        row = db.get(Evaluation, run_id)
        runs.append(row)
        run_id = row.inputs.get('resume_run_id')
    return runs


def install_tasks(app, manager):
    edit_lock = asyncio.Lock()
    @app.get('/api/workspaces/{project_id}/task-sources')
    def task_sources(project_id: str):
        with manager.sessions() as db:
            get_design(db, project_id)
            return [{'id':s.id,'title':s.title,'kind':s.kind} for s in db.scalars(select(Source).where(Source.design_id==project_id,Source.kind=='code').order_by(Source.created_at.desc()))]

    @app.get('/api/workspaces/{project_id}/tasks')
    def listing(project_id: str):
        with manager.sessions() as db:
            get_design(db, project_id)
            tasks = db.scalars(select(WorkTask).where(WorkTask.design_id == project_id).order_by(WorkTask.updated_at.desc())).all()
            history = {}
            rows = db.execute(select(TaskRun.task_id, Evaluation.id, Evaluation.status,
                Evaluation.result['stage'].as_string(), Evaluation.inputs['task_snapshot']['version'].as_integer()
                ).join(Evaluation, TaskRun.evaluation_id == Evaluation.id).where(Evaluation.design_id == project_id).order_by(Evaluation.created_at.desc()))
            for task_id, run_id, status, stage, task_version in rows:
                history.setdefault(task_id, []).append({'id':run_id,'status':status,'stage':stage,'task_version':task_version})
            return [{**record(task), 'run_count': len(history.get(task.id, [])),
                     'latest_run': history.get(task.id, [None])[0]} for task in tasks]

    @app.post('/api/workspaces/{project_id}/tasks', status_code=201)
    def create(project_id: str, data: TaskDefinition):
        with manager.sessions.begin() as db:
            get_design(db, project_id)
            if not data.title.strip() or len(data.description.strip()) < 10:
                raise HTTPException(422, '请输入任务名称与至少 10 字的任务说明')
            validate_source(db, project_id, data.code_source_id)
            task = WorkTask(design_id=project_id, **data.model_dump())
            db.add(task); db.flush()
            return record(task)

    @app.get('/api/workspaces/{project_id}/tasks/{task_id}')
    def detail(project_id: str, task_id: str):
        with manager.sessions() as db:
            task = get_task(db, project_id, task_id)
            runs = db.scalars(select(Evaluation).join(TaskRun, TaskRun.evaluation_id == Evaluation.id).where(TaskRun.task_id == task.id).order_by(Evaluation.created_at.desc())).all()
            return {**record(task), 'runs': [record(r) for r in runs]}

    @app.get('/api/workspaces/{project_id}/tasks/{task_id}/runs/{run_id}/export')
    def export_run(project_id: str, task_id: str, run_id: str):
        with manager.sessions() as db:
            get_task(db, project_id, task_id)
            link = db.scalar(select(TaskRun).where(TaskRun.task_id == task_id, TaskRun.evaluation_id == run_id))
            if not link:
                raise HTTPException(404, '此任务的运行不存在')
            run = db.get(Evaluation, run_id)
            return Response(json.dumps(record(run), ensure_ascii=False, indent=2), media_type='application/json',
                            headers={'Content-Disposition': f'attachment; filename="run-{run_id}.json"'})

    @app.post('/api/workspaces/{project_id}/tasks/{task_id}/runs/{run_id}/output-workspace')
    def output_workspace(project_id: str, task_id: str, run_id: str):
        from .output_workspace import prepare_outputs
        with manager.sessions() as db:
            get_task(db, project_id, task_id)
            link = db.scalar(select(TaskRun).where(TaskRun.task_id == task_id, TaskRun.evaluation_id == run_id))
            if not link:
                raise HTTPException(404, '此任务的运行不存在')
            return prepare_outputs(manager.root.parent / 'output-workspaces', db.get(Evaluation, run_id))

    @app.get('/api/workspaces/{project_id}/tasks/{task_id}/runs/{run_id}/flow')
    def flow(project_id: str, task_id: str, run_id: str):
        from .run_flow import editor_snapshot, nodes
        with manager.sessions() as db:
            get_task(db, project_id, task_id)
            runs = task_lineage(db, task_id, run_id)
            snapshot = editor_snapshot(manager.root.parent / 'output-workspaces', runs)
            return {'run_id':run_id, 'nodes':nodes(runs[0], snapshot),
                    'edits_digest':snapshot['digest'],
                    'changes':[{k:v for k,v in c.items() if k != 'content'} for c in snapshot['changes']]}

    @app.post('/api/workspaces/{project_id}/tasks/{task_id}/runs/{run_id}/web-editor')
    def open_web_editor(project_id: str, task_id: str, run_id: str, data: EditorRequest):
        return editor_url(output_workspace(project_id, task_id, run_id), data)

    @app.put('/api/workspaces/{project_id}/tasks/{task_id}')
    async def edit(project_id: str, task_id: str, data: TaskEdit):
        async with edit_lock:
            with manager.sessions.begin() as db:
                task = get_task(db, project_id, task_id)
                if task.version != data.expected_version:
                    raise HTTPException(409, '任务已修改，请刷新后再保存')
                if not data.title.strip() or len(data.description.strip()) < 10:
                    raise HTTPException(422, '请输入任务名称与至少 10 字的任务说明')
                validate_source(db, project_id, data.code_source_id)
                for key, value in data.model_dump(exclude={'expected_version'}).items():
                    setattr(task, key, value)
                task.version += 1; task.updated_at = now()
                return record(task)

    @app.post('/api/workspaces/{project_id}/tasks/{task_id}/runs', status_code=202)
    async def start(project_id: str, task_id: str, data: TaskStart):
        from .delivery import DeliveryRequest
        return await manager.start_delivery(project_id, DeliveryRequest(
            goal='任务运行：以任务冻结的说明和验收条件为准', task_id=task_id,
            task_version=data.expected_version, task_request_id=data.request_id,
            resume_run_id=data.resume_run_id, max_attempts=data.max_attempts, offline=data.offline,
            restart_node=data.restart_node, edits_digest=data.edits_digest,
        ))
