"""WebSocket gateway: live chat, typing indicators, server events and WebRTC
call signalling.

Protocol (JSON text frames). The first frame must authenticate (keeps the JWT
out of URLs and access logs):
    -> {"type": "auth", "token": "<access token>"}
    <- {"type": "ready", "user_id": "...", "ice_servers": [...]}

Client -> server (every frame may carry a "ref" that is echoed in the reply):
    ping                                   <- pong
    chat.send   {conversation_id, client_message_id?, message_type?, body?, media_id?, reply_to_id?}
                                           <- chat.ack {message}; all participants get chat.message
    chat.typing {conversation_id}          -> others get chat.typing
    chat.read   {conversation_id, last_read_message_id} -> others get chat.read
    call.invite {conversation_id, call_type: audio|video, callee_id?, issue_id?}
                                           <- call.created {call}; callee gets call.incoming
    call.accept / call.reject / call.end {call_id, reason?}
                                           -> other party gets call.accepted / call.rejected / call.ended
    rtc.offer {call_id, sdp} · rtc.answer {call_id, sdp} · rtc.ice {call_id, candidate}
                                           -> relayed verbatim to the other party
    call.stats  {call_id, ice_candidate_type}   (records whether TURN relay was needed)

Server -> client (unsolicited): notification, chat.message, event, call.*, rtc.*
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any
from uuid import UUID

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from ..config import get_settings
from ..db import db
from ..deps import load_user_from_token
from ..security import ice_servers
from ..services import calls, chat
from ..services.realtime import Client, hub

log = logging.getLogger("kodi.ws")
router = APIRouter()

MAX_FRAME_BYTES = 64 * 1024
AUTH_TIMEOUT_SECONDS = 10


async def _other_party(call: dict[str, Any], user_id: UUID) -> UUID:
    return call["callee_id"] if user_id == call["caller_id"] else call["caller_id"]


def _call_payload(call: dict[str, Any]) -> dict[str, Any]:
    return {k: call[k] for k in ("id", "conversation_id", "caller_id", "callee_id", "call_type", "status",
                                 "issue_id", "started_at", "answered_at", "ended_at", "duration_seconds",
                                 "end_reason") if k in call}


async def _ring_timeout(call_id: UUID, seconds: int) -> None:
    try:
        await asyncio.sleep(seconds)
        call = await calls.transition(call_id, None, "timeout")
        if call:
            message = {"type": "call.ended", "call": _call_payload(call)}
            await hub.relay(call["caller_id"], message)
            await hub.relay(call["callee_id"], message)
    except asyncio.CancelledError:
        pass
    finally:
        hub.timers.pop(call_id, None)


def _cancel_ring(call_id: UUID) -> None:
    timer = hub.timers.pop(call_id, None)
    if timer:
        timer.cancel()


async def _handle(client: Client, msg: dict[str, Any]) -> None:
    kind = msg.get("type")
    ref = msg.get("ref")
    uid = client.user_id

    if kind == "ping":
        await client.send({"type": "pong", "ref": ref})

    elif kind == "chat.send":
        data = chat.ChatSendIn.model_validate(msg)
        message = await chat.send_message(uid, UUID(msg["conversation_id"]), data)
        # Delivery to every participant (including this user's other devices)
        # happens via the database event, so it works across API workers.
        await client.send({"type": "chat.ack", "ref": ref, "message": message})

    elif kind in ("chat.typing", "chat.read"):
        conversation_id = UUID(msg["conversation_id"])
        await chat.require_participant(conversation_id, uid)
        outgoing: dict[str, Any] = {"type": kind, "conversation_id": str(conversation_id), "user_id": str(uid)}
        if kind == "chat.read":
            state = await chat.mark_read(conversation_id, uid, int(msg["last_read_message_id"]))
            outgoing["last_read_message_id"] = state["last_read_message_id"]
        for other in await chat.participant_ids(conversation_id):
            if other != uid:
                await hub.relay(other, outgoing)

    elif kind == "call.invite":
        call_type = msg.get("call_type", "video")
        if call_type not in ("audio", "video"):
            raise HTTPException(422, "call_type must be audio or video")
        call = await calls.create_call(
            caller_id=uid, conversation_id=UUID(msg["conversation_id"]), call_type=call_type,
            callee_id=UUID(msg["callee_id"]) if msg.get("callee_id") else None,
            issue_id=UUID(msg["issue_id"]) if msg.get("issue_id") else None,
            is_online=hub.is_online)
        reachable = await hub.relay(call["callee_id"], {
            "type": "call.incoming", "call": _call_payload(call), "caller_name": call["caller_name"]})
        await client.send({"type": "call.created", "ref": ref, "call": _call_payload(call),
                           "callee_online": reachable})
        timeout = get_settings().call_ring_timeout_seconds
        hub.timers[call["id"]] = hub.spawn(_ring_timeout(call["id"], timeout))

    elif kind in ("call.accept", "call.reject", "call.end"):
        call_id = UUID(msg["call_id"])
        action = kind.split(".")[1]
        call = await calls.transition(call_id, uid, action, msg.get("reason"))  # type: ignore[arg-type]
        if call is None:
            await client.send({"type": "call.noop", "ref": ref, "call_id": str(call_id)})
            return
        _cancel_ring(call_id)
        event = {"accept": "call.accepted", "reject": "call.rejected", "end": "call.ended"}[action]
        payload = {"type": event, "call": _call_payload(call)}
        await hub.relay(await _other_party(call, uid), payload)
        await client.send({**payload, "ref": ref})

    elif kind in ("rtc.offer", "rtc.answer", "rtc.ice"):
        call = await calls.get_for_party(UUID(msg["call_id"]), uid)
        if call["status"] not in ("ringing", "ongoing"):
            raise HTTPException(409, "Call is not active")
        outgoing = {"type": kind, "call_id": str(call["id"]), "from": str(uid)}
        if kind == "rtc.ice":
            outgoing["candidate"] = msg.get("candidate")
        else:
            outgoing["sdp"] = msg.get("sdp")
        if not await hub.relay(await _other_party(call, uid), outgoing):
            await client.send({"type": "error", "ref": ref, "detail": "Peer unreachable"})

    elif kind == "call.stats":
        await calls.record_ice_type(UUID(msg["call_id"]), uid, str(msg.get("ice_candidate_type")))

    else:
        await client.send({"type": "error", "ref": ref, "detail": f"Unknown message type: {kind}"})


@router.websocket("/ws")
async def websocket_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    settings = get_settings()

    try:
        first = json.loads(await asyncio.wait_for(ws.receive_text(), AUTH_TIMEOUT_SECONDS))
        user = await load_user_from_token(first.get("token", ""), settings) if first.get("type") == "auth" else None
    except (asyncio.TimeoutError, ValueError, AttributeError, WebSocketDisconnect):
        user = None
    if user is None:
        await ws.close(code=4401, reason="Unauthorized")
        return

    staff_accounts = {r["account_id"] for r in await db.fetch(
        "SELECT account_id FROM account_members WHERE user_id = $1", user.id)}
    tenant_ids = {r["id"] for r in await db.fetch("SELECT id FROM tenants WHERE user_id = $1", user.id)}
    client = Client(ws=ws, user_id=user.id, staff_accounts=staff_accounts, tenant_ids=tenant_ids)
    hub.register(client)
    await client.send({"type": "ready", "user_id": str(user.id), "ice_servers": ice_servers(settings, user.id)})

    try:
        while True:
            raw = await ws.receive_text()
            if len(raw) > MAX_FRAME_BYTES:
                await client.send({"type": "error", "detail": "Frame too large"})
                continue
            try:
                msg = json.loads(raw)
                if not isinstance(msg, dict):
                    raise ValueError
            except ValueError:
                await client.send({"type": "error", "detail": "Frames must be JSON objects"})
                continue
            try:
                await _handle(client, msg)
            except HTTPException as exc:
                await client.send({"type": "error", "ref": msg.get("ref"), "status": exc.status_code,
                                   "detail": exc.detail})
            except ValidationError as exc:
                await client.send({"type": "error", "ref": msg.get("ref"), "status": 422,
                                   "detail": exc.errors(include_url=False, include_context=False)})
            except (KeyError, ValueError, TypeError) as exc:
                await client.send({"type": "error", "ref": msg.get("ref"), "status": 422,
                                   "detail": f"Invalid or missing field: {exc}"})
            except Exception as exc:  # noqa: BLE001 - keep the socket alive
                detail = getattr(exc, "message", None)
                if detail is None:
                    log.exception("WebSocket handler error")
                await client.send({"type": "error", "ref": msg.get("ref"), "status": 400,
                                   "detail": detail or "Request failed"})
    except WebSocketDisconnect:
        pass
    finally:
        if hub.unregister(client):
            for call in await calls.end_calls_for_user(user.id):
                _cancel_ring(call["id"])
                other = await _other_party(call, user.id)
                await hub.relay(other, {"type": "call.ended", "call": _call_payload(call)})
