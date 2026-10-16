# University Parking Slot Reservation System

**Reserve. Park. Go.** — an hourly parking reservation system for a school or university, with a driver app and an administrator console, a dark "smart parking" interface, and a local SQLite database.

- **Roles:** Driver and Administrator
- **Booking:** hourly reservations on an interactive parking map (with an accessible list view)
- **Payments:** recorded manually by staff — there is no online payment gateway
- **Occupancy:** manual administrator check-in / check-out (no sensors)
- **Database:** SQLite only (`better-sqlite3`), stored in `data/parking.db`
- **Stack:** Node.js, Express 5, EJS, Bootstrap 5, vanilla JavaScript, Chart.js

## Quick start

Requires Node.js 22 or newer (developed and tested on Node 22.22; the code uses no version-specific APIs beyond `process.loadEnvFile`, which needs Node 20.12+). Node 26 is intended to work but was not available to test here.

```bash
npm install            # installs from package-lock.json
npm run setup          # creates .env with a random SESSION_SECRET
npm run db:seed        # creates data/parking.db with demo zones, slots, drivers and history
npm start              # http://localhost:3000
```

On Windows / VS Code: open the folder, open the integrated terminal (Ctrl+`), and run the four commands above one at a time.

### Development accounts (created by `npm run db:seed`)

| Role | Email | Password |
| --- | --- | --- |
| Administrator | `admin@university.test` | `Admin#12345` |
| Driver (car) | `maria@university.test` | `Driver#12345` |
| Driver (car) | `juan@university.test` | `Driver#12345` |
| Driver (motorcycle) | `ana@university.test` | `Driver#12345` |

These are development-only defaults. Change them with `SEED_ADMIN_PASSWORD` / `SEED_DRIVER_PASSWORD` in `.env` before seeding (keep the quotes — an unquoted `#` starts a comment in `.env` files), or change the passwords in the app. **Never seed or deploy with these defaults on a shared server.** Drivers can also register themselves at `/register`.

### Other scripts

| Command | What it does |
| --- | --- |
| `npm run db:init` | Create the database and apply migrations (no demo data) |
| `npm run db:seed` | Initialise + insert demo data (skipped if an administrator already exists) |
| `npm run db:reset` | Delete the database file, then re-create and re-seed it |
| `npm run dev` | Start with automatic restart on file changes |
| `npm test` | Run the automated test suite (`node:test`, no extra dependencies) |
| `npm run check` | Syntax-check all scripts and compile every EJS template |

## What drivers can do

- **Find Parking** (the main screen): choose date, start/end time, zone and vehicle type; see the calculated duration; press *Search availability*. The lot is drawn as a map of numbered bays with live states — **Available** (green), **Reserved** (blue), **Occupied** (red), **Unavailable/maintenance** (gray), **Selected** (bright-blue outline). Every state uses colour *and* an icon *and* text. A synchronised list view is available for screen readers and keyboard users (and works without JavaScript).
- A side panel shows the selected slot (zone, type, status, rate, period, availability) and a live reservation summary with the estimated fee. The server re-validates everything when the booking is submitted.
- Confirm a booking, then see the unique reference (`UP-YYYYMMDD-XXXXX`), slot, zone, time, fee and status. Success is only shown after the database transaction commits.
- **My Reservations:** Upcoming, Active, Completed, Cancelled and No-show views; details; cancel and reschedule (until the cutoff); history is never deleted.
- **Payments:** balances, payment history, printable receipts. **My Vehicles** (car or motorcycle) and **Profile**.

## What administrators can do

- **Dashboard:** KPI cards (operational slots, available now, reserved now, occupied now, today's reservations, outstanding balances) and charts (reservations over time, peak hours, demand by zone, cancellation/no-show rates, recorded collections), plus recent activity — all from SQL queries.
- **Parking Slots:** zone CRUD, slot CRUD (including bulk add), slot types, operational status, hourly rates, search and filters. Taking a slot or zone out of service is **blocked** while a vehicle is checked in or upcoming reservations exist — conflicts are never overridden silently.
- **Reservations:** search by reference, driver, email or plate; filter by date, zone and status; details; cancel with a required reason; no-show management (single or bulk).
- **Check-in / Check-out:** look up by reference or plate, verify, record arrival/departure; active sessions with elapsed time, expected end, rate and running fee; late arrivals and overstays flagged; duplicate check-ins and invalid check-outs prevented.
- **Payments:** record manual payments (cash, GCash, bank transfer, other — non-cash needs a reference), view valid and voided payments, paid / partial / unpaid balances, print receipts, void with a reason.
- **Drivers:** create accounts, search, activate/deactivate, reset passwords.
- **Reports:** daily, weekly and monthly (reservations, utilization, sessions, no-shows, assessed fees, recorded collections, outstanding) with CSV export of the filtered results.
- **Settings:** booking and billing rules, hourly rates, and the audit log.

## Booking and billing rules

All values below (except the fixed rules) are editable under **Settings → Booking rules**.

1. A slot cannot have overlapping active (confirmed/active) reservations. Adjacent bookings are fine (one ends exactly when the next starts). Cancelled, completed and no-show bookings free their interval.
2. Bookings are on the configured increment (default 60 min), within opening hours (default 06:00–22:00), between 1 and 8 hours, up to 14 days ahead, and cannot start in the past.
3. Slots in maintenance or inactive status cannot be newly booked; cars use standard/compact/accessible slots, motorcycles use motorcycle slots.
4. A vehicle cannot hold two overlapping reservations; a driver can hold up to 5 open reservations.
5. Creating a reservation (conflict check + insert) runs in one `BEGIN IMMEDIATE` transaction, and SQLite triggers reject overlapping rows even from raw SQL, so concurrent requests cannot double-book a slot.
6. **Cancellation / rescheduling:** drivers until 60 minutes before the start; administrators any time before check-in, with a reason.
7. **Check-in** opens 30 minutes before the start; arriving more than 15 minutes after the start is flagged *late*. A booking can be marked **no-show** 30 minutes after its start.
8. **Fee = hourly rate × started hours** of the reservation. If the vehicle leaves later than the booked end plus a 10-minute grace period, every started extra hour is billed too. Arriving late or leaving early does not reduce the fee. Cancelled bookings assess ₱0; no-shows assess a configurable number of hours (default 0).
9. Money is stored as **integer centavos** and shown in Philippine pesos. Rates are per slot type (defaults: standard ₱20, compact ₱15, accessible ₱20, motorcycle ₱10 per hour); a booking keeps the rate it was made at.
10. **Payments never change reservation or occupancy status.** A balance is *finalized fee − valid payments*; open bookings use their estimate and can be prepaid. Voided payments are excluded.

Times are stored in UTC and shown in campus time (`TZ_OFFSET_MINUTES`, default +480 for the Philippines, which has no daylight saving).

## Project structure

```
server.js                 entry point
src/app.js                Express app factory (helmet CSP, sessions, CSRF, routes, error pages)
src/config/env.js         environment handling
src/db/                   better-sqlite3 connection, migrations/001_init.sql, session store, seed, init CLI
src/services/             business rules: reservations, availability, parking (check-in/out), payments, billing, reports, catalog, users, settings, audit
src/routes/               auth, driver, admin, api (JSON availability)
src/middleware/           CSRF, auth/role guards, flash messages
src/utils/                time (UTC <-> campus time), money (centavos), validation, view helpers, errors
views/layouts/            main.ejs (app shell), auth.ejs
views/partials/           app-sidebar, app-header, status-badge, parking-slot, slot-results, stat-card, summary-card,
                          filter-toolbar, data-table, pagination, form-field, confirm-modal, toast, empty-state
views/driver, views/admin, views/auth, views/shared, views/errors
public/css/               theme.css (tokens + shell), components.css, parking-slots.css, no-js.css
public/js/                app.js, reservation-form.js, parking-slots.js, charts.js
tests/                    node:test suites (auth, booking, operations, payments, admin, app, billing, rate limit)
scripts/                  setup.js, check-syntax.js
.npmrc                    skips install-time compilation (see Troubleshooting)
```

Database tables: `users`, `vehicles`, `parking_zones`, `parking_slots`, `reservations`, `parking_rates`, `parking_sessions`, `payments`, `audit_logs` (the nine required tables) plus `settings`, `schema_migrations` and `sessions`. Foreign keys are enforced, queries are parameterised, and indexes cover the booking and reporting queries.

## Security

- Passwords hashed with bcrypt (`bcryptjs`); the session id is regenerated at sign-in; HttpOnly, SameSite=Lax cookies (set `SESSION_COOKIE_SECURE=true` behind HTTPS).
- Role checks on every route; drivers can only see and change their own reservations, vehicles and receipts (other users' records return 404).
- CSRF token on every POST; login and registration rate-limited (`LOGIN_RATE_LIMIT_MAX`, default 10 per 15 minutes per IP, failed attempts only).
- Helmet security headers with a strict Content-Security-Policy (no inline scripts); all assets are served locally — no CDN calls.
- Server-side validation for every consequential action; generic sign-in error messages; no stack traces in responses; CSV exports neutralise spreadsheet formulas.
- Audit log of sign-ins, bookings, cancellations, check-ins, payments, voids, setting and catalogue changes.
- In production the app refuses to start without a real `SESSION_SECRET` (32+ characters). `.env` and the database file are git-ignored.

## Testing

`npm test` runs 63 tests against a temporary SQLite file and an in-process HTTP server. They cover sign-in and role permissions, CSRF, rate limiting, driver record ownership, slot availability, successful bookings, overlap rejection (partial/containing/contained), adjacent bookings, cancellation and rescheduling (including cutoffs), **concurrent booking attempts**, database-level overlap protection, check-in/check-out, late/overstay/no-show handling, fee calculation, partial and voided payments and balance reconciliation, receipts, zone/slot/rate/rule management, dashboard and report queries, CSV export, page rendering and static assets, navigation markup, `.env` handling (including the production secret check), and persistence after a process restart.

Not covered by automated tests: pixel-level appearance and real-browser behaviour. The browser scripts were exercised in a simulated DOM only; please look through the pages in a real browser (desktop, tablet, phone widths) after installing.

## Troubleshooting

- **`better-sqlite3` problems:** it ships prebuilt binaries (Windows, macOS and Linux, x64 and arm64) inside its npm package, so installation does not compile anything. The included `.npmrc` sets `ignore-scripts=true` to make sure npm does not try to compile it. If your platform is not covered and `require('better-sqlite3')` fails, delete `.npmrc`, install a C++ toolchain (Windows: "Desktop development with C++" build tools; macOS: Xcode command-line tools; Linux: `build-essential` and Python 3) and run `npm install` again.
- **Signed out after every restart:** you have no `SESSION_SECRET`; run `npm run setup`.
- **Start over:** stop the server and run `npm run db:reset`.
- **Change the port or database path:** edit `PORT` / `DB_PATH` in `.env`.

## Known limitations

- Administrators cannot create bookings on behalf of drivers (drivers book for themselves).
- Notifications (email/SMS) are not implemented, so there is no notification indicator in the header.
- Rates are per slot type, not per slot or per time of day.
- A single Node process is assumed (SQLite file on the same machine).
