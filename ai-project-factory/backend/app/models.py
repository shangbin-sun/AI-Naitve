import uuid
from datetime import datetime, timezone

from sqlalchemy import JSON, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def uid():
    return uuid.uuid4().hex


def now():
    return datetime.now(timezone.utc).isoformat()


class Base(DeclarativeBase):
    pass


class Design(Base):
    # Persistent project workspace. Keep the legacy table/IDs so existing
    # conversations, employees and revisions remain attached without copying.
    __tablename__ = "designs"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    title: Mapped[str] = mapped_column(String(200), default="未命名团队")
    draft: Mapped[dict] = mapped_column(JSON, default=dict)
    version: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[str] = mapped_column(String, default=now)
    updated_at: Mapped[str] = mapped_column(String, default=now)


class Message(Base):
    __tablename__ = "messages"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    design_id: Mapped[str] = mapped_column(ForeignKey("designs.id"), index=True)
    role: Mapped[str] = mapped_column(String(20))
    content: Mapped[str] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(String, default=now)


class Job(Base):
    __tablename__ = "jobs"
    __table_args__ = (UniqueConstraint("design_id", "request_id"),)
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    design_id: Mapped[str] = mapped_column(ForeignKey("designs.id"), index=True)
    request_id: Mapped[str] = mapped_column(String(100))
    base_version: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(30), default="queued")
    error: Mapped[str] = mapped_column(Text, default="")
    proposal: Mapped[dict] = mapped_column(JSON, default=dict)
    logs: Mapped[list] = mapped_column(JSON, default=list)
    usage: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[str] = mapped_column(String, default=now)
    finished_at: Mapped[str | None] = mapped_column(String, nullable=True)


class Employee(Base):
    __tablename__ = "employees"
    __table_args__ = (UniqueConstraint("design_id", "key"),)
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    design_id: Mapped[str] = mapped_column(ForeignKey("designs.id"), index=True)
    key: Mapped[str] = mapped_column(String(100))
    profile: Mapped[dict] = mapped_column(JSON)
    files: Mapped[dict] = mapped_column(JSON, default=dict)
    version: Mapped[int] = mapped_column(Integer, default=1)
    active: Mapped[bool] = mapped_column(default=True)
    updated_at: Mapped[str] = mapped_column(String, default=now)


class Revision(Base):
    __tablename__ = "revisions"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    design_id: Mapped[str] = mapped_column(ForeignKey("designs.id"), index=True)
    version: Mapped[int] = mapped_column(Integer)
    source: Mapped[str] = mapped_column(String)
    draft: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[str] = mapped_column(String, default=now)


class Project(Base):
    # Historical plan snapshot, not a separate ongoing project or an executed run.
    __tablename__ = "projects"
    __table_args__ = (UniqueConstraint("design_id", "design_version"),)
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    design_id: Mapped[str] = mapped_column(ForeignKey("designs.id"))
    design_version: Mapped[int] = mapped_column(Integer)
    title: Mapped[str] = mapped_column(String(200))
    snapshot: Mapped[dict] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String, default="draft")
    created_at: Mapped[str] = mapped_column(String, default=now)


class Source(Base):
    __tablename__ = "sources"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    design_id: Mapped[str] = mapped_column(ForeignKey("designs.id"), index=True)
    title: Mapped[str] = mapped_column(String(200))
    location: Mapped[str] = mapped_column(Text)
    kind: Mapped[str] = mapped_column(String(30))
    coverage: Mapped[str] = mapped_column(String(30))
    content: Mapped[str] = mapped_column(Text)
    digest: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[str] = mapped_column(String, default=now)


class Evaluation(Base):
    __tablename__ = "evaluations"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    design_id: Mapped[str] = mapped_column(ForeignKey("designs.id"), index=True)
    design_version: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(30), default="queued")
    kind: Mapped[str] = mapped_column(String(30), default="review")
    inputs: Mapped[dict] = mapped_column(JSON)
    result: Mapped[dict] = mapped_column(JSON, default=dict)
    error: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[str] = mapped_column(String, default=now)
