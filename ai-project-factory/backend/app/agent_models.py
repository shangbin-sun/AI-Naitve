"""Additive run tables: existing code-task and evaluation archives remain valid."""
from sqlalchemy import JSON, ForeignKey, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column
from .models import Base, now


class AgentTask(Base):
    __tablename__ = 'agent_tasks'
    __table_args__ = (UniqueConstraint('project_id', 'request_id'),)
    id: Mapped[str] = mapped_column(String, primary_key=True)
    project_id: Mapped[str] = mapped_column(ForeignKey('designs.id'), index=True)
    request_id: Mapped[str] = mapped_column(String)
    scope: Mapped[str] = mapped_column(String)
    title: Mapped[str] = mapped_column(String)
    inputs: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[str] = mapped_column(String, default=now)


class AgentRun(Base):
    __tablename__ = 'agent_runs'
    id: Mapped[str] = mapped_column(String, primary_key=True)
    task_id: Mapped[str] = mapped_column(ForeignKey('agent_tasks.id'), index=True)
    status: Mapped[str] = mapped_column(String, default='queued')
    snapshot: Mapped[dict] = mapped_column(JSON)
    state: Mapped[dict] = mapped_column(JSON, default=dict)
    thread_id: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[str] = mapped_column(String, default=now)
    updated_at: Mapped[str] = mapped_column(String, default=now)
