# Kodi Rentals

Caretaker-free rental management for the Kenyan market, built as an installable
Progressive Web App. Landlords manage properties, units, tenants and leases;
rent is invoiced automatically and collected over M-Pesa (STK Push and Paybill);
tenants report repairs, chat and call the landlord, and download receipts and
statements, all from the browser, online or offline.

| Layer      | Stack |
|------------|-------|
| Database   | PostgreSQL 18: enums, constraints, triggers for billing, reconciliation and unit state |
| Backend    | Python 3.15, FastAPI, asyncpg, WebSockets (chat + WebRTC signalling), fpdf2, pywebpush |
| Payments   | Safaricom M-Pesa Daraja API: STK Push, C2B validation/confirmation |
| Frontend   | Vanilla JS (ES modules), Bootstrap 5, service worker, Web App Manifest, Web Push |

## Progress

| Phase | Scope | Status |
|-------|-------|--------|
| 1 | Relational schema (`database/`) | Done |
| 2 | API, M-Pesa hooks, WebSocket/WebRTC signalling, PDF/CSV statements & receipts | Done |
| 3 | PWA: manifest, service worker, offline statements, install banners, push notifications | Done |
| 4 | Full UI: landlord dashboards, tenant portal, chat & call windows | Next |
| 5 | Integration, end-to-end workflows, deployment | Planned |

## Project layout

```
database/
  schema.sql                 Phase 1 DDL (tables, enums, indexes, triggers, views)
  seeds/001_kenya_locations.sql
  migrations/002_tenant_invites.sql
  tests/smoke_test.sql
backend/
  app/
    main.py                  App factory: routers, lifespan, static PWA hosting
    config.py                Settings (KODI_* env vars / backend/.env)
    routers/                 auth, accounts, properties, units, tenants, leases, billing,
                             mpesa, hooks (Safaricom), issues, chat, realtime (/ws),
                             notifications (+ Web Push), media, reports (PDF/CSV), public
    services/                daraja, mpesa, realtime hub, chat, calls, scheduler,
                             storage, exports (PDF/CSV), push (Web Push)
    tools/                   gen_vapid.py (push keys), gen_icons.py (PWA icons)
  tests/                     pytest suite against a real PostgreSQL
frontend/
  index.html                 App shell
  manifest.json              Install metadata, icons, shortcuts
  sw.js                      Service worker: caching strategies, offline pack, push
  offline.html               Fallback page
  css/app.css                Theme tokens (light/dark, glass surfaces)
  js/                        config, api (auth + refresh), pwa (SW, install, push),
                             offline (offline pack), ui, app (router + screens)
  icons/  vendor/bootstrap/
```

## Run it locally (Windows)

```powershell
cd backend
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
copy .env.example .env          # fill in DB password, secrets, VAPID keys (see comments)

# database (once)
$psql = "C:\Program Files\PostgreSQL\18\bin\psql.exe"
& $psql -U postgres -c "CREATE DATABASE kodi"
& $psql -U postgres -d kodi -v ON_ERROR_STOP=1 -f ..\database\schema.sql
& $psql -U postgres -d kodi -v ON_ERROR_STOP=1 -f ..\database\seeds\001_kenya_locations.sql
& $psql -U postgres -d kodi -v ON_ERROR_STOP=1 -f ..\database\migrations\002_tenant_invites.sql

.venv\Scripts\python -m uvicorn app.main:app --reload --port 8000
```

- App (PWA): http://localhost:8000/
- API docs: http://localhost:8000/docs
- Tests: `.venv\Scripts\python -m pytest` (uses `KODI_TEST_ADMIN_DSN`; creates and drops `kodi_test`)

Service workers and push need a secure origin. `localhost` counts as secure, but
to try the app on a phone, serve it over HTTPS, for example with
`cloudflared tunnel --url http://localhost:8000`. The same tunnel URL goes in
`KODI_PUBLIC_BASE_URL` so Safaricom can reach the M-Pesa callbacks.

See [backend/README.md](backend/README.md) for M-Pesa setup and the statement/receipt endpoints.

## PWA behaviour

- **Install:** Chrome/Edge on Android and desktop show Kodi's own install banner.
  iPhone/iPad Safari shows "Share, then Add to Home Screen" instructions.
- **Offline:** the app shell is precached. After sign-in, an *offline pack*
  (statement, invoices, payments, leases, issues, recent receipt PDFs, statement
  PDF; dashboards and reports for landlords) is saved and refreshed every 30
  minutes and whenever the connection returns. Screens show a "saved copy" note
  when offline. Saved data is cleared on sign-out or when another user signs in.
- **Updates:** a new version installs in the background, and the user taps *Update* to switch.
- **Notifications:** Web Push for payments, invoices, repairs, messages and
  missed calls. Each notification is pushed once, even with several API workers.
  On iOS this works only after Kodi is added to the Home Screen (iOS 16.4+).
