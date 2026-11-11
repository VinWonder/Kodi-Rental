"""Application settings, loaded from environment variables / backend/.env (prefix KODI_)."""
from functools import lru_cache
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_prefix="KODI_", extra="ignore")

    env: Literal["development", "test", "production"] = "development"

    # --- Database -----------------------------------------------------------
    database_url: str = "postgresql://postgres:postgres@localhost:5432/kodi"
    db_pool_min: int = 2
    db_pool_max: int = 20

    # --- Auth -----------------------------------------------------------------
    jwt_secret: str = Field(min_length=32)
    jwt_algorithm: str = "HS256"
    access_token_minutes: int = 15
    refresh_token_days: int = 30
    invite_token_days: int = 7

    # Fernet key used to encrypt Daraja consumer key/secret/passkey at rest.
    fernet_key: str

    # --- URLs -----------------------------------------------------------------
    # Must be a publicly reachable HTTPS origin in production: Safaricom posts
    # STK and C2B callbacks to {public_base_url}/hooks/{token}/...
    public_base_url: str = "http://localhost:8000"
    frontend_base_url: str = "http://localhost:5500"
    cors_origins: list[str] = ["http://localhost:5500", "http://127.0.0.1:5500"]
    trust_proxy_headers: bool = False  # True only behind nginx/Cloudflare that sets X-Forwarded-For

    # --- Media ----------------------------------------------------------------
    media_root: str = "./media"
    max_upload_mb: int = 25

    # --- M-Pesa Daraja --------------------------------------------------------
    mpesa_sandbox_base_url: str = "https://sandbox.safaricom.co.ke"
    mpesa_production_base_url: str = "https://api.safaricom.co.ke"
    # Safaricom callback source IPs. Empty list = accept from anywhere (development only).
    mpesa_callback_ip_allowlist: list[str] = []
    # Reject C2B payments whose "Account No." matches no unit/invoice/tenant
    # (requires Safaricom to enable External Validation on the shortcode).
    mpesa_c2b_reject_unknown_ref: bool = False
    stk_timeout_seconds: int = 180

    # --- Scheduler ------------------------------------------------------------
    scheduler_enabled: bool = True
    billing_hour_eat: int = Field(default=6, ge=0, le=23)

    # --- WebRTC ---------------------------------------------------------------
    stun_urls: list[str] = ["stun:stun.l.google.com:19302"]
    turn_urls: list[str] = []          # e.g. ["turn:turn.example.co.ke:3478?transport=udp", "turns:turn.example.co.ke:5349"]
    turn_secret: str | None = None     # coturn `static-auth-secret` -> short-lived credentials
    turn_credential_ttl_seconds: int = 3600
    call_ring_timeout_seconds: int = 45

    # --- Web Push (PWA notifications) -------------------------------------------
    # Generate with: python -m app.tools.gen_vapid   (raw P-256 keys, base64url)
    vapid_public_key: str | None = None
    vapid_private_key: str | None = None
    # Push services require a contact. Use a real mailbox or https URL you control.
    vapid_subject: str = "mailto:support@example.com"
    push_ttl_seconds: int = 24 * 3600

    # --- Frontend -----------------------------------------------------------------
    # Serve ../frontend from this API (same origin, simplest for the service worker).
    serve_frontend: bool = True
    frontend_dir: str = "../frontend"


@lru_cache
def get_settings() -> Settings:
    return Settings()
