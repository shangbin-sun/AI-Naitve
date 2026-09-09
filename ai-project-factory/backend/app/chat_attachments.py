"""Project-scoped chat attachments with separate image and document inputs."""
import base64
import binascii
import io

from fastapi import HTTPException, Response
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, Field
from sqlalchemy import ForeignKey, LargeBinary, String, select
from sqlalchemy.orm import Mapped, mapped_column

from .models import Base, now, uid
from .service import get_design

MAX_BYTES = 5 * 1024 * 1024


class ChatAttachment(Base):
    __tablename__ = "chat_attachments"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    design_id: Mapped[str] = mapped_column(ForeignKey("designs.id"), index=True)
    message_id: Mapped[str | None] = mapped_column(ForeignKey("messages.id"), nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(200))
    content_type: Mapped[str] = mapped_column(String(30))
    data: Mapped[bytes] = mapped_column(LargeBinary)
    created_at: Mapped[str] = mapped_column(String, default=now)


class UploadAttachment(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    data: str = Field(max_length=7_000_000)
    content_type: str = Field(default="application/octet-stream", max_length=100)


def describe(row):
    return {"id": row.id, "name": row.name, "content_type": row.content_type,
            "url": f"/api/workspaces/{row.design_id}/chat-attachments/{row.id}"}


def message_attachments(db, identity):
    result = {}
    for row in db.scalars(select(ChatAttachment).where(ChatAttachment.design_id == identity, ChatAttachment.message_id.is_not(None))):
        result.setdefault(row.message_id, []).append(describe(row))
    return result


def bind_attachments(db, identity, message_id, ids):
    for attachment_id in ids:
        row = db.get(ChatAttachment, attachment_id)
        if not row or row.design_id != identity or row.message_id is not None:
            raise HTTPException(422, "附件不存在、属于其他项目或已用于另一条消息，请重新上传")
        row.message_id = message_id


def image_context(db, identity, message_ids):
    return [{**describe(row), "message_id": row.message_id,
             "data": base64.b64encode(row.data).decode("ascii")}
            for row in db.scalars(select(ChatAttachment).where(
                ChatAttachment.design_id == identity, ChatAttachment.message_id.in_(message_ids),
                ChatAttachment.content_type.like("image/%"),
            ).order_by(ChatAttachment.created_at)).all()[-12:]]


def document_context(db, identity, message_ids):
    rows = db.scalars(select(ChatAttachment).where(
        ChatAttachment.design_id == identity, ChatAttachment.message_id.in_(message_ids),
        ~ChatAttachment.content_type.like("image/%"),
    ).order_by(ChatAttachment.created_at)).all()[-12:]
    result = []
    for row in rows:
        item = {**describe(row), "message_id": row.message_id}
        if row.content_type in {"text/plain", "text/markdown", "text/csv", "application/json"}:
            item["text"] = row.data.decode("utf-8", errors="replace")
        result.append(item)
    return result


def install_chat_attachments(app, sessions):
    @app.post("/api/workspaces/{identity}/chat-attachments", status_code=201)
    def upload(identity: str, body: UploadAttachment):
        with sessions.begin() as db:
            get_design(db, identity)
            content_type = body.content_type
            if content_type == "application/octet-stream":
                suffix = body.name.lower().rsplit(".", 1)[-1] if "." in body.name else ""
                content_type = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp", "md": "text/markdown", "markdown": "text/markdown", "txt": "text/plain", "csv": "text/csv", "json": "application/json"}.get(suffix, content_type)
            try:
                data = base64.b64decode(body.data, validate=True)
                if not data or len(data) > MAX_BYTES:
                    raise ValueError()
                if content_type.startswith("image/"):
                    with Image.open(io.BytesIO(data)) as image:
                        kind = image.format
                        if kind not in {"PNG", "JPEG", "WEBP"} or image.width * image.height > 25_000_000:
                            raise ValueError()
                        image.verify()
                elif content_type not in {"application/pdf", "text/plain", "text/markdown", "text/csv", "application/json", "application/zip", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}:
                    raise ValueError()
            except (ValueError, binascii.Error, OSError, UnidentifiedImageError, Image.DecompressionBombError):
                raise HTTPException(422, "不支持的附件格式或文件过大（上限 5 MB）")
            row = ChatAttachment(design_id=identity, name=body.name, content_type=content_type, data=data)
            db.add(row)
            db.flush()
            return describe(row)

    @app.get("/api/workspaces/{identity}/chat-attachments/{attachment_id}")
    def download(identity: str, attachment_id: str):
        with sessions() as db:
            row = db.get(ChatAttachment, attachment_id)
            if not row or row.design_id != identity:
                raise HTTPException(404, "附件不存在")
            return Response(row.data, media_type=row.content_type, headers={"X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=3600"})

    @app.delete("/api/workspaces/{identity}/chat-attachments/{attachment_id}")
    def remove(identity: str, attachment_id: str):
        with sessions.begin() as db:
            row = db.get(ChatAttachment, attachment_id)
            if not row or row.design_id != identity:
                raise HTTPException(404, "附件不存在")
            if row.message_id:
                raise HTTPException(409, "已发送附件属于对话历史，不能从附件栏删除")
            db.delete(row)
            return {"deleted": True}
