"""Serve the PWA (../frontend) from the API origin.

Same-origin hosting keeps the service worker's scope at "/" and avoids CORS
for API calls. Cache headers matter for PWAs: the service worker, manifest and
HTML must always be revalidated so updates reach users, while versioned
vendor files and icons can be cached for a long time.
"""
from __future__ import annotations

import logging
from pathlib import Path

from fastapi import FastAPI
from starlette.responses import Response
from starlette.staticfiles import StaticFiles
from starlette.types import Scope

log = logging.getLogger("kodi.static")

ALWAYS_REVALIDATE = {"sw.js", "manifest.json", "index.html", "offline.html", ""}
LONG_LIVED_PREFIXES = ("vendor/", "icons/")


class PWAStaticFiles(StaticFiles):
    async def get_response(self, path: str, scope: Scope) -> Response:
        response = await super().get_response(path, scope)
        clean = path.replace("\\", "/").strip("/")
        if clean in (".", ""):
            clean = "index.html"   # Starlette passes "." for the site root
        if clean in ALWAYS_REVALIDATE or clean.endswith(".html"):
            response.headers["Cache-Control"] = "no-cache"
        elif clean.startswith(LONG_LIVED_PREFIXES):
            response.headers["Cache-Control"] = "public, max-age=2592000"
        else:
            response.headers["Cache-Control"] = "public, max-age=0, must-revalidate"
        if clean == "manifest.json":
            response.headers["Content-Type"] = "application/manifest+json"
        if clean == "sw.js":
            response.headers["Service-Worker-Allowed"] = "/"
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        return response


def mount_frontend(app: FastAPI, directory: str) -> None:
    root = (Path(__file__).resolve().parents[1] / directory).resolve() if not Path(directory).is_absolute() \
        else Path(directory)
    if not (root / "index.html").exists():
        log.warning("Frontend not found at %s; only the API will be served", root)
        return
    app.mount("/", PWAStaticFiles(directory=root, html=True), name="frontend")
