"""WebRTC call lifecycle (the database is the source of truth for call state;
SDP and ICE candidates are relayed by the hub and never stored)."""
from __future__ import annotations

from typing import Any, Callable, Literal
from uuid import UUID

from fastapi import HTTPException

from ..db import db

CALL_COLUMNS = """id, conversation_id, caller_id, callee_id, call_type, status, issue_id,
                  started_at, answered_at, ended_at, duration_seconds, end_reason"""
TERMINAL = {"ended", "missed", "rejected", "failed"}
Action = Literal["accept", "reject", "end", "timeout", "fail"]


async def create_call(
    *,
    caller_id: UUID,
    conversation_id: UUID,
    call_type: str,
    callee_id: UUID | None,
    issue_id: UUID | None,
    is_online: Callable[[UUID], bool],
) -> dict[str, Any]:
    async with db.tx(user_id=caller_id) as conn:
        participants = [r["user_id"] for r in await conn.fetch(
            "SELECT user_id FROM conversation_participants WHERE conversation_id = $1", conversation_id)]
        if caller_id not in participants:
            raise HTTPException(404, "Conversation not found")
        others = [p for p in participants if p != caller_id]
        if callee_id is not None:
            if callee_id not in others:
                raise HTTPException(422, "Callee is not part of this conversation")
        else:
            if not others:
                raise HTTPException(409, "Nobody else has joined this conversation yet")
            online = [p for p in others if is_online(p)]
            callee_id = (online or others)[0]

        busy = await conn.fetchval(
            """SELECT EXISTS (SELECT 1 FROM call_sessions
                               WHERE status IN ('ringing', 'ongoing')
                                 AND (caller_id = $1 OR callee_id = $1))""",
            callee_id,
        )
        if busy:
            raise HTTPException(409, "The other person is on another call")

        row = await conn.fetchrow(
            f"""INSERT INTO call_sessions (conversation_id, caller_id, callee_id, call_type, issue_id)
                VALUES ($1, $2, $3, $4, $5) RETURNING {CALL_COLUMNS}""",
            conversation_id, caller_id, callee_id, call_type, issue_id,
        )
        caller_name = await conn.fetchval("SELECT full_name FROM users WHERE id = $1", caller_id)
    call = dict(row)
    call["caller_name"] = caller_name
    return call


async def get_for_party(call_id: UUID, user_id: UUID) -> dict[str, Any]:
    row = await db.fetchrow(
        f"SELECT {CALL_COLUMNS} FROM call_sessions WHERE id = $1 AND $2 IN (caller_id, callee_id)",
        call_id, user_id,
    )
    if row is None:
        raise HTTPException(404, "Call not found")
    return dict(row)


async def transition(call_id: UUID, user_id: UUID | None, action: Action,
                     reason: str | None = None) -> dict[str, Any] | None:
    """Apply a state change. Returns the updated call, or None if the call was
    already finished (makes duplicate hang-ups harmless)."""
    async with db.tx(user_id=user_id) as conn:
        call = await conn.fetchrow(
            f"SELECT {CALL_COLUMNS} FROM call_sessions WHERE id = $1 FOR UPDATE", call_id)
        if call is None or (user_id is not None and user_id not in (call["caller_id"], call["callee_id"])):
            raise HTTPException(404, "Call not found")
        if call["status"] in TERMINAL:
            return None

        status = call["status"]
        is_callee = user_id == call["callee_id"]
        if action == "accept":
            if not is_callee or status != "ringing":
                raise HTTPException(409, "Only the person being called can answer a ringing call")
            new_status, end_reason = "ongoing", None
        elif action == "reject":
            if not is_callee or status != "ringing":
                raise HTTPException(409, "Only a ringing call can be declined")
            new_status, end_reason = "rejected", "declined"
        elif action == "end":
            if status == "ringing":
                new_status, end_reason = ("rejected", "declined") if is_callee else ("missed", "cancelled")
            else:
                new_status, end_reason = "ended", reason or "hangup"
        elif action == "timeout":
            if status != "ringing":
                return None
            new_status, end_reason = "missed", "no_answer"
        else:
            new_status, end_reason = "failed", reason or "connection_failed"

        row = await conn.fetchrow(
            f"""UPDATE call_sessions SET status = $2, end_reason = coalesce($3, end_reason)
                WHERE id = $1 RETURNING {CALL_COLUMNS}""",
            call_id, new_status, end_reason,
        )
    return dict(row)


async def end_calls_for_user(user_id: UUID) -> list[dict[str, Any]]:
    """Called when a user's last socket disconnects."""
    rows = await db.fetch(
        """SELECT id FROM call_sessions
           WHERE (status = 'ongoing' AND $1 IN (caller_id, callee_id))
              OR (status = 'ringing' AND caller_id = $1)""",
        user_id,
    )
    ended = []
    for r in rows:
        call = await transition(r["id"], user_id, "end", "peer_disconnected")
        if call:
            ended.append(call)
    return ended


async def record_ice_type(call_id: UUID, user_id: UUID, candidate_type: str) -> None:
    if candidate_type not in ("host", "srflx", "prflx", "relay"):
        raise HTTPException(422, "Unknown ICE candidate type")
    await db.execute(
        "UPDATE call_sessions SET ice_candidate_type = $3 WHERE id = $1 AND $2 IN (caller_id, callee_id)",
        call_id, user_id, candidate_type,
    )
