import asyncio

from fastapi import HTTPException
from sqlalchemy import select

from .models import Design, Job, Message, Source, now
from .service import apply_draft
from .evidence import source_context
from .chat_attachments import image_context


class JobManager:
    """Local single-process runner. Jobs persist; interrupted jobs require explicit retry."""

    def __init__(self, sessions, runtime):
        self.sessions = sessions
        self.runtime = runtime
        self.tasks = {}
        self.lock = asyncio.Lock()
        self.capacity = asyncio.Semaphore(2)

    def recover(self):
        with self.sessions.begin() as db:
            for job in db.scalars(select(Job).where(Job.status.in_(["queued", "running"]))):
                job.status = "interrupted"
                job.error = "服务重启中断了本次设计，请重新发送消息；原草稿已保留"
                job.finished_at = now()

    def start(self, identity):
        task = asyncio.create_task(self.run(identity))
        self.tasks[identity] = task
        task.add_done_callback(lambda _: self.tasks.pop(identity, None))

    async def shutdown(self):
        tasks = list(self.tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    async def log(self, identity, message):
        with self.sessions.begin() as db:
            job = db.get(Job, identity)
            job.logs = [*job.logs[-99:], {"at": now(), "message": message}]

    async def run(self, identity):
        try:
            async with self.capacity:
                with self.sessions.begin() as db:
                    job = db.get(Job, identity)
                    job.status = "running"
                    design = db.get(Design, job.design_id)
                    messages = list(db.scalars(select(Message).where(Message.design_id == design.id).order_by(Message.created_at)))
                    context = {"current_draft": design.draft, "conversation": [{"id": m.id, "role": m.role, "content": m.content} for m in messages[-30:]]}
                    context["chat_images"] = image_context(db, design.id, [m.id for m in messages[-30:]])
                    context['reference_sources'] = [
                        source_context(s)
                        for s in db.scalars(select(Source).where(Source.design_id==design.id).order_by(Source.created_at)).all()[-30:]
                    ]
                response, usage = await self.runtime.generate(context, lambda text: self.log(identity, text))
                async with self.lock:
                    with self.sessions.begin() as db:
                        job = db.get(Job, identity)
                        if job.status not in ("queued", "running"):
                            return
                        job.proposal = response.model_dump()
                        job.usage = usage
                        if db.get(Design, job.design_id).version != job.base_version:
                            job.status = "conflict"
                            job.error = "生成期间你修改了草稿，已保留手动修改；请重新发送要求以基于最新版本生成"
                        else:
                            apply_draft(db, job.design_id, job.base_version, response.draft.model_dump(), "codex")
                            db.add(Message(design_id=job.design_id, role="assistant", content=response.reply))
                            job.status = "completed"
                        job.finished_at = now()
        except asyncio.CancelledError:
            self.fail(identity, "cancelled", "已停止生成，之前保存的草稿不受影响")
            raise
        except Exception as exc:
            error = exc.detail if isinstance(exc, HTTPException) else str(exc)
            self.fail(identity, "failed", error[:1000])

    def fail(self, identity, status, error):
        with self.sessions.begin() as db:
            job = db.get(Job, identity)
            if job:
                job.status, job.error, job.finished_at = status, error, now()
