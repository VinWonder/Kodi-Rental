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
| 4 | Full UI: landlord dashboards, tenant portal, chat & call windows | Done |
| 5 | Integration, end-to-end workflows, deployment | Next |

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
  js/
    app.js                   Routes, auth guard, global wiring
    router.js shell.js       Hash router; layout, nav, render scopes
    api.js realtime.js       REST client (token refresh); WebSocket client
    calls.js                 WebRTC voice/video calls
    components.js            Icons, modals/forms, badges, charts, uploads, signature pad
    pwa.js offline.js        Service worker, install, push; offline pack
    views/                   One module per area (dashboard, properties, tenants,
                             leases, billing, issues, chat, reports, settings, ...)
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

## The app (Phase 4)

**Landlords:**
- **Dashboard:** live KPIs, a billed-vs-collected chart and an occupancy donut.
- **Properties and units:** a status-coloured unit grid, bulk "A1-A12" creation, photo galleries, condition logs and state history.
- **Tenants:** ID and next-of-kin onboarding, and one-tap invite links by WhatsApp or SMS.
- **Allocation:** prefilled tenancy terms; the tenant e-signs.
- **Billing:** invoices, M-Pesa STK prompts with a live "waiting for PIN" panel, cash and bank payments, and assigning unmatched Paybill payments.
- **Repairs:** a board with priority, contractor dispatch, costs and an expense log.
- **Reports:** on-screen tables with PDF and CSV downloads.
- **Settings:** M-Pesa Daraja setup, team roles and contractors.

**Tenants:**
- A balance hero and "Pay with M-Pesa".
- Paybill and account-number instructions.
- Lease signing on a signature pad.
- Repair reports with photos and video, a progress stepper and ratings.
- Statement and receipts, readable offline.

**Both:**
- Chat with photos, files and voice notes, typing indicators and read receipts.
- In-browser voice and video calls over WebRTC, starting on the rear camera so tenants can show damage.
- Notifications, a light/dark theme, and layouts for phone and desktop.

There is also a public vacancy search at `#/vacancies` that needs no sign-in.

## Design & accessibility

- **Look:** glass and soft (neumorphic) surfaces on a calm blue/green palette, with light and dark themes that follow the device setting. Dark mode uses Bootstrap's own colour mode, so every component is themed.
- **Phones first:** a five-tab bottom bar with Messages in the top bar, 44px touch targets, safe-area insets, swipeable board columns and collapsible filters. Desktops get a sidebar.
- **Accessibility:** checked with axe-core (WCAG 2.1 AA plus best practice) on about 55 screens across light/dark and phone/desktop, with no violations. That covers:
  - colour contrast
  - names for every control
  - labelled dialogs and live regions
  - keyboard-reachable scroll areas
  - visible focus
  - reduced-motion support
- **Errors:** messages are written in plain language, with "Go back" and "Try again" buttons, and never show raw validation text.

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
