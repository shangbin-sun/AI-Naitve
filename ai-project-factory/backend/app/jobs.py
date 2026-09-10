import asyncio
import time

from .performance import Trace, current_trace

from fastapi import HTTPException
from sqlalchemy import select

from .models import Design, Job, Message, Source, CodexConversation, ChatOperation, MessageReference, now
from .service import apply_draft
from .evidence import source_context
from .chat_attachments import document_context, image_context


class JobManager:
    """Local single-process runner. Jobs persist; interrupted jobs require explicit retry."""

    def __init__(self, sessions, runtime, performance=None):
        self.performance = performance
        self.sessions = sessions
        self.runtime = runtime
        self.tasks = {}
        self.lock = asyncio.Lock()
        self.capacity = asyncio.Semaphore(2)
        self.previews = {}
        self.preview_written_at = {}
        self.subscribers = {}

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
        if hasattr(self.runtime, 'close'):
            await self.runtime.close()

    def subscribe(self, identity):
        event = asyncio.Event()
        self.subscribers.setdefault(identity, set()).add(event)
        return event

    def unsubscribe(self, identity, event):
        listeners = self.subscribers.get(identity, set())
        listeners.discard(event)
        if not listeners:
            self.subscribers.pop(identity, None)

    def notify(self, identity):
        for event in self.subscribers.get(identity, ()):
            event.set()

    async def log(self, identity, message):
        started = time.perf_counter()
        if isinstance(message, dict) and message.get('type') in ('thread', 'turn'):
            with self.sessions.begin() as db:
                job = db.get(Job, identity)
                if message['type'] == 'thread':
                    row = db.get(CodexConversation, job.design_id)
                    if row is None:
                        db.add(CodexConversation(design_id=job.design_id, thread_id=message['thread_id'], imported_messages=message['imported_messages']))
                    elif row.thread_id != message['thread_id']:
                        raise RuntimeError('Codex 会话绑定冲突')
                else:
                    operation = db.get(ChatOperation, identity)
                    if operation:
                        operation.turn_id = message['turn_id']
            return
        is_reply = isinstance(message, dict) and message.get("type") == "reply"
        if is_reply:
            self.previews[identity] = message['text']
            self.notify(identity)
            # Publish every delta; checkpoint the first and at most every 200 ms.
            if started - self.preview_written_at.get(identity, float('-inf')) < .2:
                return
        with self.sessions.begin() as db:
            job = db.get(Job, identity)
            if is_reply:
                if job.status == "running":
                    job.proposal = {"reply": message["text"]}
            else:
                job.logs = [*job.logs[-99:], {"at": now(), "message": message}]
        self.notify(identity)
        trace = current_trace.get()
        if is_reply:
            self.preview_written_at[identity] = started
            if trace:
                trace.once('first_reply_persisted')
                trace.add('reply_db_writes')
                trace.add('reply_db_ms', round((time.perf_counter() - started) * 1000, 3))

    async def run(self, identity):
        trace = Trace(self.performance, identity)
        token = current_trace.set(trace)
        trace.mark('job_started')
        status = 'failed'
        try:
            async with self.capacity:
                trace.mark('queue_acquired')
                with self.sessions.begin() as db:
                    job = db.get(Job, identity)
                    job.status = "running"
                    design = db.get(Design, job.design_id)
                    operation = db.get(ChatOperation, identity)
                    if operation is None:
                        raise RuntimeError('旧运行缺少会话操作记录，请重新发送')
                    message = db.get(Message, operation.message_id)
                    conversation = db.get(CodexConversation, design.id)
                    reference = db.get(MessageReference, message.id)
                    context = {'project_id': design.id, 'job_id': job.id, 'project_version': design.version,
                               'employee_reference': {'id': reference.employee_id, 'name': reference.name} if reference else None,
                               'mode': operation.mode, 'thread_id': conversation.thread_id if conversation else None,
                               'message_id': message.id, 'message': message.content,
                               'chat_images': image_context(db, design.id, [message.id]),
                               'chat_documents': document_context(db, design.id, [message.id]), 'legacy': []}
                    if conversation is None:
                        history = list(db.scalars(select(Message).where(Message.design_id == design.id, Message.id != message.id).order_by(Message.created_at)))
                        context['legacy'] = [{'id': m.id, 'role': m.role, 'content': m.content,
                                              'images': image_context(db, design.id, [m.id]) if m.role == 'user' else [],
                                              'documents': document_context(db, design.id, [m.id]) if m.role == 'user' else []} for m in history]
                    if operation.mode == 'plan':
                        context['plan_context'] = {'current_draft': design.draft, 'reference_sources': [
                            source_context(source) for source in db.scalars(select(Source).where(Source.design_id == design.id).order_by(Source.created_at)).all()[-30:]]}
                trace.mark('context_ready', mode=context['mode'], existing_thread=bool(context['thread_id']),
                           imported_message_count=len(context['legacy']), image_count=len(context['chat_images']),
                           input_text_bytes=len(context['message'].encode()))
                response, usage = await self.runtime.generate(context, lambda text: self.log(identity, text))
                trace.mark('runtime_returned', usage=usage)
                async with self.lock:
                    trace.mark('save_lock_acquired')
                    with self.sessions.begin() as db:
                        job = db.get(Job, identity)
                        if job.status not in ("queued", "running"):
                            status = job.status
                            return
                        job.proposal = response.model_dump() if context['mode'] == 'plan' else {'reply': response.reply, 'draft': None}
                        job.usage = usage
                        if context['mode'] == 'plan' and db.get(Design, job.design_id).version != job.base_version:
                            job.status = "conflict"
                            job.error = "生成期间你修改了草稿，已保留手动修改；请重新发送要求以基于最新版本生成"
                        else:
                            if context['mode'] == 'plan' and response.draft is not None:
                                apply_draft(db, job.design_id, job.base_version, response.draft.model_dump(), "codex")
                            reply_message = Message(design_id=job.design_id, role="assistant", content=response.reply)
                            db.add(reply_message)
                            db.flush()
                            job.proposal = {**job.proposal, "message_id": reply_message.id}
                            job.status = "completed"
                        job.finished_at = now()
                        status = job.status
                    trace.mark('save_committed')
        except asyncio.CancelledError:
            status = 'cancelled'
            self.fail(identity, "cancelled", "已停止生成，之前保存的草稿不受影响")
            raise
        except Exception as exc:
            error = exc.detail if isinstance(exc, HTTPException) else str(exc)
            self.fail(identity, "failed", error[:1000])

        finally:
            self.previews.pop(identity, None)
            self.preview_written_at.pop(identity, None)
            self.notify(identity)
            trace.finish(status)
            current_trace.reset(token)

    def fail(self, identity, status, error):
        with self.sessions.begin() as db:
            job = db.get(Job, identity)
            if job:
                if identity in self.previews:
                    job.proposal = {'reply': self.previews[identity]}
                job.status, job.error, job.finished_at = status, error, now()
        self.notify(identity)
