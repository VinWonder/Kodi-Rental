"""REST side of messaging (history, fallback send, read receipts, call log,
ICE servers). Live traffic uses the WebSocket at /ws."""
from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field

from ..db import as_dicts, db
from ..deps import SettingsDep, UserDep
from ..security import ice_servers
from ..services import chat
from ..services.calls import CALL_COLUMNS

router = APIRouter(tags=["chat"])


class ReadIn(BaseModel):
    last_read_message_id: int = Field(ge=1)


@router.get("/conversations")
async def list_conversations(user: UserDep):
    return await chat.list_conversations(user.id)


@router.get("/conversations/{conversation_id}/messages")
async def list_messages(conversation_id: UUID, user: UserDep,
                        before_id: int | None = Query(default=None, ge=1),
                        limit: int = Query(default=50, ge=1, le=200)):
    return await chat.list_messages(conversation_id, user.id, before_id, limit)


@router.post("/conversations/{conversation_id}/messages", status_code=status.HTTP_201_CREATED)
async def send_message(conversation_id: UUID, body: chat.ChatSendIn, user: UserDep):
    """Fallback for clients without a live socket (e.g. the service worker
    flushing its offline queue). Pass client_message_id to make retries safe."""
    return await chat.send_message(user.id, conversation_id, body)


@router.post("/conversations/{conversation_id}/read")
async def mark_read(conversation_id: UUID, body: ReadIn, user: UserDep):
    return await chat.mark_read(conversation_id, user.id, body.last_read_message_id)


@router.delete("/conversations/{conversation_id}/messages/{message_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_message(conversation_id: UUID, message_id: int, user: UserDep):
    deleted = await db.fetchval(
        """UPDATE messages SET deleted_at = now()
           WHERE id = $1 AND conversation_id = $2 AND sender_id = $3 AND deleted_at IS NULL
             AND message_type NOT IN ('system', 'call_log') RETURNING id""",
        message_id, conversation_id, user.id)
    if deleted is None:
        raise HTTPException(404, "Message not found")


@router.get("/conversations/{conversation_id}/calls")
async def call_history(conversation_id: UUID, user: UserDep, limit: int = Query(default=50, ge=1, le=200)):
    await chat.require_participant(conversation_id, user.id)
    return as_dicts(await db.fetch(
        f"SELECT {CALL_COLUMNS} FROM call_sessions WHERE conversation_id = $1 ORDER BY started_at DESC LIMIT $2",
        conversation_id, limit))


@router.get("/rtc/ice-servers")
async def get_ice_servers(user: UserDep, settings: SettingsDep):
    """Pass to `new RTCPeerConnection({ iceServers })`. Kenyan mobile networks
    commonly use carrier-grade NAT, so configure TURN for reliable calls."""
    return {"ice_servers": ice_servers(settings, user.id)}
