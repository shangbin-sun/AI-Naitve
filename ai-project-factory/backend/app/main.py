import asyncio
import io
import json
import zipfile
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from pydantic import BaseModel, Field
from sqlalchemy import select

from .config import Settings
from .database import make_database
from .jobs import JobManager
from .models import Design, Employee, Job, Message, Project, Revision
from .runtime import CodexRuntime
from .schemas import EditDraft, EditEmployee, SendMessage
from .service import apply_draft, edit_employee, get_design, instantiate
from .evidence import EvidenceManager, install_evidence
from .employee_builder import install_builder
from .delivery import install_delivery
from .tasks import install_tasks
from .chat_attachments import install_chat_attachments, message_attachments, bind_attachments


def record(row):
    return {column.name: getattr(row, column.name) for column in row.__table__.columns}


class NewDesign(BaseModel):
    title: str = Field(default="未命名项目", min_length=1, max_length=200)
    goal: str = Field(default="", max_length=10000)


class Instantiate(BaseModel):
    expected_version: int


def create_app(settings=None, runtime=None):
    settings = settings or Settings.from_env()
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    engine, sessions = make_database(settings.database_url)
    runtime = runtime or CodexRuntime(settings)
    manager = JobManager(sessions, runtime)
    evidence = EvidenceManager(sessions, runtime, settings)

    @asynccontextmanager
    async def lifespan(app):
        manager.recover()
        evidence.recover()
        yield
        await manager.shutdown()
        await evidence.shutdown()
        engine.dispose()

    app = FastAPI(title="AI Project Factory", version="0.1.0", lifespan=lifespan)
    app.state.sessions = sessions
    app.state.manager = manager
    app.state.evidence = evidence
    install_evidence(app, evidence)
    install_builder(app, evidence)
    install_delivery(app, evidence)
    install_tasks(app, evidence)
    install_chat_attachments(app, sessions)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["localhost", "127.0.0.1", "testserver"])

    @app.middleware("http")
    async def local_origin(request: Request, call_next):
        # This first milestone is intentionally a loopback-only personal workspace.
        origin = request.headers.get("origin")
        if origin and origin not in {"http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:8000", "http://127.0.0.1:8000"}:
            return Response("Origin not allowed", status_code=403)
        return await call_next(request)

    @app.get("/api/health")
    def health():
        return {"status": "ok", "mode": "local", "version": "0.1.0"}

    @app.get("/api/runtime")
    async def runtime_status():
        return await runtime.status()

    @app.get("/api/workspaces")
    @app.get("/api/designs", include_in_schema=False)
    def designs():
        with sessions() as db:
            return [record(d) for d in db.scalars(select(Design).order_by(Design.updated_at.desc()))]

    @app.post("/api/workspaces", status_code=201)
    @app.post("/api/designs", status_code=201, include_in_schema=False)
    def new_design(data: NewDesign):
        with sessions.begin() as db:
            row = Design(title=data.title, draft={"goal": data.goal} if data.goal else {})
            db.add(row)
            db.flush()
            return record(row)

    @app.get("/api/workspaces/{identity}")
    @app.get("/api/designs/{identity}", include_in_schema=False)
    def design(identity: str):
        with sessions() as db:
            row = get_design(db, identity)
            attachments = message_attachments(db, identity)
            return {**record(row),
                "messages": [{**record(m), "attachments": attachments.get(m.id, [])} for m in db.scalars(select(Message).where(Message.design_id == identity).order_by(Message.created_at))],
                "jobs": [record(j) for j in db.scalars(select(Job).where(Job.design_id == identity).order_by(Job.created_at.desc()))],
                "employees": [record(e) for e in db.scalars(select(Employee).where(Employee.design_id == identity, Employee.active.is_(True)))],
            }

    @app.post("/api/workspaces/{identity}/messages", status_code=202)
    @app.post("/api/designs/{identity}/messages", status_code=202, include_in_schema=False)
    async def send_message(identity: str, data: SendMessage):
        if not data.content.strip() and not data.attachment_ids:
            raise HTTPException(422, "请输入消息")
        async with manager.lock:
            with sessions.begin() as db:
                row = get_design(db, identity)
                duplicate = db.scalar(select(Job).where(Job.design_id == identity, Job.request_id == data.request_id))
                if duplicate:
                    return record(duplicate)
                if db.scalar(select(Job).where(Job.design_id == identity, Job.status.in_(["queued", "running"]))):
                    raise HTTPException(409, "当前团队正在生成，请等待完成或先停止")
                if row.version != data.expected_version:
                    raise HTTPException(409, "团队已更新，请刷新后发送")
                message = Message(design_id=identity, role="user", content=data.content.strip())
                db.add(message)
                db.flush()
                bind_attachments(db, identity, message.id, data.attachment_ids)
                job = Job(design_id=identity, request_id=data.request_id, base_version=row.version)
                db.add(job)
                db.flush()
                result = record(job)
            manager.start(result["id"])
            return result

    @app.post("/api/jobs/{identity}/cancel")
    async def cancel(identity: str):
        with sessions() as db:
            job = db.get(Job, identity)
            if not job:
                raise HTTPException(404, "运行不存在")
            if job.status not in ("queued", "running"):
                return record(job)
        task = manager.tasks.get(identity)
        if task:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            with sessions() as db:
                pending = db.get(Job, identity).status in ("queued", "running")
            if pending:
                manager.fail(identity, "cancelled", "已停止生成，之前保存的草稿不受影响")
        else:
            manager.fail(identity, "interrupted", "执行进程不存在，已停止本次任务")
        with sessions() as db:
            return record(db.get(Job, identity))

    @app.put("/api/workspaces/{identity}/draft")
    @app.put("/api/designs/{identity}/draft", include_in_schema=False)
    async def update_draft(identity: str, data: EditDraft):
        async with manager.lock:
            with sessions.begin() as db:
                return record(apply_draft(db, identity, data.expected_version, data.draft.model_dump(), "manual"))

    @app.get("/api/workspaces/{identity}/revisions")
    @app.get("/api/designs/{identity}/revisions", include_in_schema=False)
    def revisions(identity: str):
        with sessions() as db:
            get_design(db, identity)
            return [record(r) for r in db.scalars(select(Revision).where(Revision.design_id == identity).order_by(Revision.version.desc()))]

    @app.get("/api/employees")
    def employees():
        with sessions() as db:
            return [record(e) for e in db.scalars(select(Employee).where(Employee.active.is_(True)).order_by(Employee.updated_at.desc()))]

    @app.get("/api/employees/{identity}")
    def employee(identity: str):
        with sessions() as db:
            row = db.get(Employee, identity)
            if not row:
                raise HTTPException(404, "员工不存在")
            return record(row)

    @app.put("/api/employees/{identity}")
    async def save_employee(identity: str, data: EditEmployee):
        async with manager.lock:
            with sessions.begin() as db:
                return record(edit_employee(db, identity, data))

    @app.get("/api/employees/{identity}/export")
    def export_employee(identity: str):
        with sessions() as db:
            row = db.get(Employee, identity)
            if not row:
                raise HTTPException(404, "员工不存在")
            buffer = io.BytesIO()
            with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
                archive.writestr("employee.json", json.dumps({"format_version": 1, "draft_version": row.version, "profile": row.profile}, ensure_ascii=False, indent=2))
                for name, content in row.files.items():
                    archive.writestr(name, content)
            return Response(buffer.getvalue(), media_type="application/zip", headers={"Content-Disposition": f'attachment; filename="{row.key}-draft-v{row.version}.zip"'})

    @app.post("/api/workspaces/{identity}/snapshots", status_code=201)
    @app.post("/api/designs/{identity}/projects", status_code=201, include_in_schema=False)
    async def create_project(identity: str, data: Instantiate):
        async with manager.lock:
            with sessions.begin() as db:
                return record(instantiate(db, identity, data.expected_version))

    @app.get("/api/projects/{identity}/employees/{employee_id}/export")
    def export_project_employee(identity: str, employee_id: str):
        with sessions() as db:
            project = db.get(Project, identity)
            if not project:
                raise HTTPException(404, "项目不存在")
            employee = next((e for e in project.snapshot["employees"] if e["id"] == employee_id), None)
            if not employee:
                raise HTTPException(404, "此员工不在该项目快照中")
            buffer = io.BytesIO()
            with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
                archive.writestr("employee.json", json.dumps({"format_version": 1, "draft_version": employee["version"], "profile": employee["profile"]}, ensure_ascii=False, indent=2))
                for name, content in employee["files"].items():
                    archive.writestr(name, content)
            return Response(buffer.getvalue(), media_type="application/zip", headers={"Content-Disposition": f'attachment; filename="{employee["profile"]["key"]}-snapshot-v{employee["version"]}.zip"'})

    @app.get("/api/snapshots")
    @app.get("/api/projects", include_in_schema=False)
    def projects():
        with sessions() as db:
            return [record(p) for p in db.scalars(select(Project).order_by(Project.created_at.desc()))]

    return app


app = create_app()
