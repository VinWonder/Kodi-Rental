# Kodi Rental API

FastAPI + asyncpg backend for the Kodi rental PWA.

## Setup (Windows, from `kodi-rental-pwa/backend`)

```powershell
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
copy .env.example .env        # then fill in database URL, JWT secret, Fernet key
psql -U postgres -d kodi -v ON_ERROR_STOP=1 -f ..\database\migrations\002_tenant_invites.sql
.venv\Scripts\python -m uvicorn app.main:app --reload --port 8000
```

PWA: http://localhost:8000/ · API docs: http://localhost:8000/docs · Health: http://localhost:8000/healthz · WebSocket: ws://localhost:8000/ws

## M-Pesa callbacks in development

Safaricom must reach your machine over HTTPS. Run a tunnel (`ngrok http 8000` or
`cloudflared tunnel --url http://localhost:8000`), put its URL in `KODI_PUBLIC_BASE_URL`,
save Daraja credentials with `PUT /api/v1/accounts/{id}/mpesa`, then call
`POST /api/v1/accounts/{id}/mpesa/register-c2b`.

## Statements, exports & receipts

- `POST /api/v1/accounts/{id}/reports/exports` with `{"report_type": "monthly_revenue" | "defaulters" |
  "maintenance_overhead" | "occupancy" | "tenant_statement", "format": "pdf" | "csv", "date_from", "date_to",
  "property_id", "tenant_id"}` generates the file now and returns its download `url`.
- `GET .../reports/exports` lists past exports; `GET .../reports/exports/{export_id}/download` fetches one.
- Receipt PDFs: `GET .../receipts/{receipt_id}/pdf` (staff) and `GET /api/v1/me/receipts/{receipt_id}/pdf`
  (tenant). A background job pre-renders new receipts every 2 minutes.
- Tenant self-service statement: `GET /api/v1/me/statement/export?format=pdf|csv`.

## Web Push

Generate keys once with `.venv\Scripts\python -m app.tools.gen_vapid`, then paste them into `.env`
together with a real `KODI_VAPID_SUBJECT` (`mailto:` address or `https://` URL you own).

- `GET /api/v1/push/config`: public key for the browser
- `POST /api/v1/push-subscriptions` / `DELETE /api/v1/push-subscriptions`: register or remove a device
- `POST /api/v1/push/test`: send yourself a test notification

Every notification row the database creates is pushed to the user's devices. Expired
devices (HTTP 404/410 from the push service) are removed automatically.

## Tests

The tests create and drop a database called `kodi_test`. They read `KODI_TEST_ADMIN_DSN`
from the environment or from `backend/.env`:

```powershell
.venv\Scripts\python -m pytest
```
