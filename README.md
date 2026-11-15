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
  migrations/003_property_reviews.sql   Verified tenant reviews
  tests/smoke_test.sql
backend/
  app/
    main.py                  App factory: routers, lifespan, static PWA hosting
    config.py                Settings (KODI_* env vars / backend/.env)
    routers/                 auth, accounts, properties, units, tenants, leases, billing,
                             mpesa, hooks (Safaricom), issues, chat, realtime (/ws),
                             notifications (+ Web Push), media, reports (PDF/CSV), public,
                             reviews (verified tenant ratings)
    services/                daraja, mpesa, realtime hub, chat, calls, scheduler,
                             storage, exports (PDF/CSV), push (Web Push)
    tools/                   gen_vapid.py (push keys), gen_icons.py (PWA icons)
  tests/                     pytest suite against a real PostgreSQL
frontend/
  index.html                 App shell
  manifest.json              Install metadata, icons, shortcuts
  sw.js                      Service worker: caching strategies, offline pack, push
  offline.html               Fallback page
  css/app.css                Base styles and components
  css/living.css             Design layer: palette, 3D house, tilt, explore pages
  css/wow.css                Transitions, 3D twin, palette, smart search, skies, landing
  css/places.css             Maps (price pins, mini map, pin picker) and reviews
  vendor/leaflet-1.9.4/      Leaflet map library (BSD-2), served same-origin
  js/
    app.js                   Routes, auth guard, global wiring
    router.js shell.js       Hash router; layout, nav, render scopes
    api.js realtime.js       REST client (token refresh); WebSocket client
    calls.js                 WebRTC voice/video calls
    components.js            Icons, modals/forms, badges, charts, uploads, signature pad, 3D house
    tilt.js twin.js          3D pointer tilt; 3D building twin
    fx.js palette.js         Transitions, count-up, confetti; Ctrl+K command palette
    map.js                   Lazy Leaflet loader, OpenStreetMap tiles, price/home pins
    smartsearch.js           Plain-English house search parser
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
& $psql -U postgres -d kodi -v ON_ERROR_STOP=1 -f ..\database\migrations\003_property_reviews.sql

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

- **Look ("Kodi Living"):** deep emerald and warm gold, photo-first cards, pill-shaped controls and a floating tab bar on phones. Light and dark themes follow the device setting, using Bootstrap's own colour mode so every component is themed. The design layer lives in `frontend/css/living.css`, on top of `app.css`.
- **3D:** built with CSS 3D transforms only (no WebGL, so it works offline and on low-end phones):
  - a lit 3D house that turns slowly on the welcome screens and the landlord banner
  - cards that tilt towards the mouse with a light glare (`js/tilt.js`, mouse and trackpad only)
  - a 3D rent card on the tenant home
  - screens that build up in depth as they load
  - all motion stops when the device asks for reduced motion
- **Finding a house (public vacancies):** borrows proven marketplace patterns:
  - one search pill, with filters behind a button
  - a bar of home-type categories
  - swipeable photo cards with a save heart, and a "Saved" tab kept on the device
  - a photo-collage detail page with an amenities list
  - a sticky price and contact bar
- **Beyond a listings app:**
  - *3D building twin:* each property is drawn as a 3D building you can rotate, floor by floor. Units are coloured by state, occupied homes have lit windows, units in arrears glow red, and tapping a unit opens it (`js/twin.js`).
  - *Smart search:* type or say "2 bedroom in Kilimani under 40k". The app pulls out the home type, budget and county on the device, and shows how it understood the request (`js/smartsearch.js`).
  - *Book a viewing:* pick a day and a time slot; the request goes to the landlord on WhatsApp or SMS.
  - *Command palette:* press Ctrl+K (or ⌘K) to jump to any screen, tenant or unit (`js/palette.js`).
  - *Motion:* screens change with the View Transitions API, a listing photo grows into the detail page, cards animate as you scroll, and numbers count up. M-Pesa payments land with confetti and a vibration (`js/fx.js`, `css/wow.css`).
  - *Living sky:* the welcome screens follow the time of day (dawn, day, dusk, night).
  - *Map view:* "Show map" puts every vacancy on an OpenStreetMap map as a price pin (one pin per building, priced from its cheapest unit). Tap a pin for the homes there. Listings show the area on a mini map, and landlords drop their building's pin on a map in the property form. Leaflet loads only when a map is first shown (`js/map.js`).
  - *Verified reviews:* only a tenant with a signed lease that has run 30+ days can rate a building, once (editable). Ratings show on cards and listings with a star breakdown. Landlords can reply publicly but cannot edit or delete reviews. Tenants are invited to "Rate your home" after 30 days (`routers/reviews.py`, `js/views/reviews.js`).
- **Map tiles in production:** `tile.openstreetmap.org` is a donated service with a fair-use policy and can be slow. Before launch, point `TILE_URL` in `js/map.js` at a tile provider you have an account with (MapTiler, Stadia, Thunderforest) and add its host to `img-src` in `index.html`.
- **Phones first:** 44px touch targets, safe-area insets, swipeable figure cards and board columns. Desktops get a sidebar.
- **Accessibility:** checked with axe-core (WCAG 2.1 AA plus best practice) on about 70 screens across light/dark and phone/desktop. That covers:
  - colour contrast
  - names for every control
  - labelled dialogs and live regions
  - keyboard-reachable scroll areas
  - visible focus
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
