"""In-process periodic jobs. Every job is safe to run on several API workers at
once: billing takes a PostgreSQL advisory lock and the rest are idempotent
UPDATEs."""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime
from typing import Awaitable, Callable

from ..config import Settings
from ..db import db
from ..utils import EAT
from . import exports, mpesa
from .push import PushSender
from .storage import MediaStorage

log = logging.getLogger("kodi.scheduler")


class Scheduler:
    def __init__(self, settings: Settings, storage: MediaStorage | None = None, push: PushSender | None = None) -> None:
        self.settings = settings
        self.storage = storage
        self.push = push
        self._tasks: list[asyncio.Task] = []

    def start(self) -> None:
        jobs: list[tuple[str, float, Callable[[], Awaitable[None]]]] = [
            ("billing", 600, self.billing_tick),
            ("stk-sweep", 60, self.stk_sweep),
            ("callback-retry", 300, self.callback_retry),
            ("call-sweep", 60, self.call_sweep),
        ]
        if self.storage is not None:
            jobs.append(("receipt-pdfs", 120, self.receipt_pdfs))
        if self.push is not None and self.push.enabled:
            jobs.append(("push-sweep", 60, self.push_sweep))
        for name, interval, job in jobs:
            self._tasks.append(asyncio.create_task(self._loop(name, interval, job), name=f"job:{name}"))

    async def stop(self) -> None:
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()

    async def _loop(self, name: str, interval: float, job: Callable[[], Awaitable[None]]) -> None:
        await asyncio.sleep(5)  # let the app finish starting
        while True:
            try:
                await job()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                log.exception("Scheduled job %s failed", name)
            await asyncio.sleep(interval)

    async def billing_tick(self) -> None:
        """Run the billing engine once a day, after billing_hour_eat."""
        if datetime.now(EAT).hour < self.settings.billing_hour_eat:
            return
        done_today = await db.fetchval(
            "SELECT EXISTS (SELECT 1 FROM billing_runs WHERE run_date = nairobi_today() AND finished_at IS NOT NULL)")
        if done_today:
            return
        async with db.tx() as conn:
            result = await conn.fetchval("SELECT fn_run_billing()")
        log.info("Billing run: %s", result)

    async def stk_sweep(self) -> None:
        expired = await db.fetchval("SELECT fn_expire_stale_stk_requests(make_interval(secs => $1))",
                                    float(self.settings.stk_timeout_seconds))
        if expired:
            log.info("Timed out %s STK requests", expired)

    async def callback_retry(self) -> None:
        rows = await db.fetch(
            """SELECT id, callback_type FROM mpesa_callbacks
               WHERE processed_at IS NULL AND callback_type IN ('stk_callback', 'c2b_confirmation')
                 AND received_at < now() - interval '1 minute'
               ORDER BY received_at LIMIT 100""")
        for row in rows:
            await mpesa.process_callback(row["id"], row["callback_type"])

    async def call_sweep(self) -> None:
        """Safety net for calls whose ring timer was lost (e.g. a worker restart)."""
        await db.execute(
            """UPDATE call_sessions SET status = 'missed', end_reason = 'no_answer'
               WHERE status = 'ringing' AND started_at < now() - make_interval(secs => $1)""",
            float(self.settings.call_ring_timeout_seconds * 2))
        await db.execute(
            """UPDATE call_sessions SET status = 'ended', end_reason = 'stale'
               WHERE status = 'ongoing' AND coalesce(answered_at, started_at) < now() - interval '4 hours'""")

    async def receipt_pdfs(self) -> None:
        """Pre-render receipt PDFs so tenants can open them instantly (and offline)."""
        rendered = await exports.render_pending_receipts(self.storage)
        if rendered:
            log.info("Rendered %s receipt PDFs", rendered)

    async def push_sweep(self) -> None:
        sent = await self.push.sweep()
        if sent:
            log.info("Pushed %s missed notifications", sent)
