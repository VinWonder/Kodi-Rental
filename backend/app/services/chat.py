"""Chat persistence shared by the REST routes and the WebSocket handler.
Delivery is not done here: the messages trigger emits a `chat_message` event
that the realtime hub fans out, which keeps multiple API workers consistent."""
from __future__ import annotations

from typing import Any, Literal
from uuid import UUID

from fastapi import HTTPException
from pydantic import BaseModel, Field, model_validator

from ..db import db

MESSAGE_SELECT = """
SELECT m.id, m.conversation_id, m.sender_id, u.full_name AS sender_name, m.message_type,
       CASE WHEN m.deleted_at IS NULL THEN m.body END     AS body,
       CASE WHEN m.deleted_at IS NULL THEN m.media_id END AS media_id,
       mf.mime_type   AS media_mime_type,
       mf.duration_ms AS media_duration_ms,
       m.reply_to_id, m.call_id, m.client_message_id, m.created_at, m.edited_at, m.deleted_at
FROM messages m
LEFT JOIN users u        ON u.id = m.sender_id
LEFT JOIN media_files mf ON mf.id = m.media_id AND m.deleted_at IS NULL
"""


class ChatSendIn(BaseModel):
    message_type: Literal["text", "image", "video", "audio_note", "file"] = "text"
    body: str | None = Field(default=None, max_length=4000)
    media_id: UUID | None = None
    reply_to_id: int | None = None
    client_message_id: UUID | None = None

    @model_validator(mode="after")
    def check_content(self) -> "ChatSendIn":
        if self.message_type == "text":
            if not (self.body and self.body.strip()):
                raise ValueError("Text messages need a body")
        elif self.media_id is None:
            raise ValueError(f"{self.message_type} messages need a media_id (upload the file first)")
        return self


async def fetch_message(message_id: int) -> dict[str, Any] | None:
    row = await db.fetchrow(MESSAGE_SELECT + " WHERE m.id = $1", message_id)
    return dict(row) if row else None


async def participant_ids(conversation_id: UUID) -> list[UUID]:
    rows = await db.fetch("SELECT user_id FROM conversation_participants WHERE conversation_id = $1",
                          conversation_id)
    return [r["user_id"] for r in rows]


async def require_participant(conversation_id: UUID, user_id: UUID) -> dict[str, Any]:
    row = await db.fetchrow(
        """SELECT c.id, c.account_id, c.tenant_id, p.is_tenant, p.last_read_message_id
           FROM conversations c
           JOIN conversation_participants p ON p.conversation_id = c.id AND p.user_id = $2
           WHERE c.id = $1""",
        conversation_id, user_id,
    )
    if row is None:
        raise HTTPException(404, "Conversation not found")
    return dict(row)


async def send_message(user_id: UUID, conversation_id: UUID, data: ChatSendIn) -> dict[str, Any]:
    async with db.tx(user_id=user_id) as conn:
        conv = await conn.fetchrow(
            """SELECT c.id, c.account_id FROM conversations c
               JOIN conversation_participants p ON p.conversation_id = c.id AND p.user_id = $2
               WHERE c.id = $1""",
            conversation_id, user_id,
        )
        if conv is None:
            raise HTTPException(404, "Conversation not found")

        if data.media_id is not None:
            owned = await conn.fetchval(
                """SELECT EXISTS (SELECT 1 FROM media_files
                                   WHERE id = $1 AND uploaded_by = $2 AND purpose = 'chat_attachment'
                                     AND deleted_at IS NULL AND account_id = $3)""",
                data.media_id, user_id, conv["account_id"],
            )
            if not owned:
                raise HTTPException(422, "Attachment not found. Upload it with purpose=chat_attachment first.")

        if data.reply_to_id is not None:
            same_thread = await conn.fetchval(
                "SELECT EXISTS (SELECT 1 FROM messages WHERE id = $1 AND conversation_id = $2)",
                data.reply_to_id, conversation_id,
            )
            if not same_thread:
                raise HTTPException(422, "reply_to_id is not in this conversation")

        message_id = await conn.fetchval(
            """INSERT INTO messages (conversation_id, sender_id, message_type, body, media_id,
                                     reply_to_id, client_message_id)
               VALUES ($1, $2, $3, $4, $5, $6, $7)
               ON CONFLICT (sender_id, client_message_id) WHERE client_message_id IS NOT NULL
               DO NOTHING
               RETURNING id""",
            conversation_id, user_id, data.message_type,
            data.body.strip() if data.body else None, data.media_id, data.reply_to_id,
            data.client_message_id,
        )
        if message_id is None:  # offline-queue retry of a message we already stored
            message_id = await conn.fetchval(
                "SELECT id FROM messages WHERE sender_id = $1 AND client_message_id = $2",
                user_id, data.client_message_id,
            )
        row = await conn.fetchrow(MESSAGE_SELECT + " WHERE m.id = $1", message_id)
    return dict(row)


async def list_conversations(user_id: UUID) -> list[dict[str, Any]]:
    rows = await db.fetch(
        """SELECT c.id, c.account_id, a.business_name, c.tenant_id, t.full_name AS tenant_name,
                  c.last_message_at, c.last_message_preview, p.is_tenant AS i_am_tenant,
                  p.last_read_message_id,
                  (SELECT count(*) FROM messages m
                    WHERE m.conversation_id = c.id AND m.id > coalesce(p.last_read_message_id, 0)
                      AND m.sender_id IS DISTINCT FROM $1 AND m.deleted_at IS NULL) AS unread_count,
                  (SELECT u.unit_number || ' · ' || pr.name
                     FROM leases l JOIN units u ON u.id = l.unit_id JOIN properties pr ON pr.id = u.property_id
                    WHERE l.tenant_id = c.tenant_id
                      AND l.status IN ('pending_signature', 'active', 'notice_given')
                    ORDER BY l.start_date DESC LIMIT 1) AS unit_label
           FROM conversation_participants p
           JOIN conversations c ON c.id = p.conversation_id
           JOIN accounts a      ON a.id = c.account_id
           JOIN tenants t       ON t.id = c.tenant_id
           WHERE p.user_id = $1
           ORDER BY c.last_message_at DESC NULLS LAST""",
        user_id,
    )
    return [dict(r) for r in rows]


async def list_messages(conversation_id: UUID, user_id: UUID, before_id: int | None,
                        limit: int) -> list[dict[str, Any]]:
    await require_participant(conversation_id, user_id)
    rows = await db.fetch(
        MESSAGE_SELECT + """ WHERE m.conversation_id = $1 AND ($2::bigint IS NULL OR m.id < $2)
                             ORDER BY m.id DESC LIMIT $3""",
        conversation_id, before_id, limit,
    )
    return [dict(r) for r in reversed(rows)]


async def mark_read(conversation_id: UUID, user_id: UUID, last_read_message_id: int) -> dict[str, Any]:
    await require_participant(conversation_id, user_id)
    row = await db.fetchrow(
        """UPDATE conversation_participants
              SET last_read_message_id = greatest(coalesce(last_read_message_id, 0),
                      (SELECT max(id) FROM messages WHERE conversation_id = $1 AND id <= $3)),
                  last_read_at = now()
            WHERE conversation_id = $1 AND user_id = $2
        RETURNING conversation_id, user_id, last_read_message_id, last_read_at""",
        conversation_id, user_id, last_read_message_id,
    )
    return dict(row)
