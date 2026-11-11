"""In-app notifications and Web Push subscriptions."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request, status
from pydantic import BaseModel, Field, model_validator

from ..db import as_dicts, db
from ..deps import SettingsDep, UserDep
from ..state import PushDep

router = APIRouter(tags=["notifications"])


class ReadNotificationsIn(BaseModel):
    ids: list[int] = Field(default_factory=list, max_length=500)
    all: bool = False

    @model_validator(mode="after")
    def need_target(self):
        if not self.ids and not self.all:
            raise ValueError("Provide ids or all=true")
        return self


class PushKeys(BaseModel):
    p256dh: str = Field(min_length=20, max_length=200)
    auth: str = Field(min_length=10, max_length=100)


class PushSubscriptionIn(BaseModel):
    endpoint: str = Field(pattern=r"^https://", max_length=1000)
    keys: PushKeys


class PushUnsubscribeIn(BaseModel):
    endpoint: str = Field(max_length=1000)


@router.get("/notifications")
async def list_notifications(user: UserDep, unread_only: bool = False,
                             before_id: int | None = Query(default=None, ge=1),
                             limit: int = Query(default=30, ge=1, le=100)):
    return as_dicts(await db.fetch(
        """SELECT id, account_id, type, title, body, data, read_at, created_at FROM notifications
           WHERE user_id = $1 AND (NOT $2 OR read_at IS NULL) AND ($3::bigint IS NULL OR id < $3)
           ORDER BY id DESC LIMIT $4""", user.id, unread_only, before_id, limit))


@router.get("/notifications/unread-count")
async def unread_count(user: UserDep):
    return {"unread": await db.fetchval(
        "SELECT count(*) FROM notifications WHERE user_id = $1 AND read_at IS NULL", user.id)}


@router.post("/notifications/read")
async def mark_notifications_read(body: ReadNotificationsIn, user: UserDep):
    result = await db.execute(
        """UPDATE notifications SET read_at = now()
           WHERE user_id = $1 AND read_at IS NULL AND ($2 OR id = ANY($3::bigint[]))""",
        user.id, body.all, body.ids)
    return {"marked": int(result.split()[-1])}


@router.get("/push/config")
async def push_config(settings: SettingsDep, push: PushDep):
    """Public VAPID key the browser needs for PushManager.subscribe()."""
    return {"enabled": push.enabled, "public_key": settings.vapid_public_key if push.enabled else None}


@router.post("/push/test")
async def push_test(user: UserDep, push: PushDep):
    """Send a test notification to every device this user has subscribed."""
    if not push.enabled:
        raise HTTPException(503, "Web Push is not configured on the server (set KODI_VAPID_* keys)")
    delivered = await push.send_to_user(user.id, {
        "id": 0, "type": "system", "title": "Kodi notifications are on",
        "body": "You will be alerted about payments, invoices, repairs and messages.",
        "url": "/#/notifications", "tag": "push-test", "data": {}})
    return {"devices": delivered}


@router.post("/push-subscriptions", status_code=status.HTTP_201_CREATED)
async def save_push_subscription(body: PushSubscriptionIn, user: UserDep, request: Request):
    await db.execute(
        """INSERT INTO push_subscriptions (user_id, endpoint, p256dh_key, auth_secret, user_agent)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh_key = EXCLUDED.p256dh_key,
                                                auth_secret = EXCLUDED.auth_secret, user_agent = EXCLUDED.user_agent""",
        user.id, body.endpoint, body.keys.p256dh, body.keys.auth, (request.headers.get("user-agent") or "")[:500])
    return {"subscribed": True}


@router.delete("/push-subscriptions", status_code=status.HTTP_204_NO_CONTENT)
async def delete_push_subscription(body: PushUnsubscribeIn, user: UserDep):
    await db.execute("DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2", body.endpoint, user.id)
