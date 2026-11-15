"""Kodi Rental API - FastAPI application factory.
Run (dev): uvicorn app.main:app --reload --port 8000   (from backend/)"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import APIRouter, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from .config import Settings, get_settings
from .db import db
from .errors import register_exception_handlers
from .routers import (accounts, auth, billing, chat, hooks, issues, leases, media, mpesa, notifications,
                      properties, public, realtime, reports, reviews, tenants, units)
from .security import SecretBox
from .services.daraja import DarajaClient
from .services.push import PushSender
from .services.realtime import hub
from .services.scheduler import Scheduler
from .services.storage import MediaStorage
from .static import mount_frontend

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        await db.connect(settings.database_url, settings.db_pool_min, settings.db_pool_max)
        app.state.secret_box = SecretBox(settings.fernet_key)
        app.state.storage = MediaStorage(settings.media_root, settings.max_upload_mb)
        app.state.daraja = getattr(app.state, "daraja", None) or DarajaClient(settings)
        app.state.push = getattr(app.state, "push", None) or PushSender(settings)
        hub.push = app.state.push
        await hub.start()
        scheduler = Scheduler(settings, app.state.storage, app.state.push)
        if settings.scheduler_enabled:
            scheduler.start()
        try:
            yield
        finally:
            await scheduler.stop()
            await hub.stop()
            await app.state.daraja.aclose()
            await db.close()

    app = FastAPI(
        title="Kodi Rental API",
        version="0.3.0",
        description="Caretaker-free rental management for Kenyan landlords: properties, tenants, "
                    "M-Pesa billing, maintenance, chat and calls.",
        lifespan=lifespan,
        docs_url="/docs" if settings.env != "production" else None,
        redoc_url=None,
    )
    app.add_middleware(GZipMiddleware, minimum_size=1024)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
    )
    register_exception_handlers(app)

    api = APIRouter(prefix="/api/v1")
    for module in (auth, accounts, properties, units, tenants, leases, billing, mpesa, issues, chat,
                   notifications, media, reports, public, reviews):
        api.include_router(module.router)
    app.include_router(api)
    app.include_router(hooks.router)      # /hooks/{token}/...  (Safaricom)
    app.include_router(realtime.router)   # /ws

    @app.get("/healthz", tags=["ops"])
    async def health():
        await db.fetchval("SELECT 1")
        return {"status": "ok"}

    if settings.serve_frontend:
        mount_frontend(app, settings.frontend_dir)   # must be last: catches everything else
    return app


app = create_app()
