# University Parking — Reserve. Park. Go.

A parking-slot reservation system for a school or university facility. Drivers find a free slot on a live map and
reserve it by the hour, and report vehicles that break the parking rules; parking staff manage how slots operate,
check vehicles in and out, record manual payments and penalise plates for etiquette violations. Everything is stored in a **local SQLite file** — there is no other database and no payment gateway.

* **Stack:** Node.js · Express 5 · EJS · Bootstrap 5 · SQLite (`better-sqlite3`)
* **Roles:** Driver and Administrator
* **UI:** a dark "smart parking" interface used by both roles (colour-blind-safe slot states: colour + icon + text)
* **Everything is local:** Bootstrap, Bootstrap Icons and Chart.js are served from `node_modules` — no CDN, no external requests.

---

## Quick start

```bash
npm install
cp .env.example .env        # optional for local development; edit as needed
npm start                   # http://localhost:3000
```

On the first start the database file `data/parking.sqlite` is created, the schema is applied and (in development) demo
data is loaded: five zones (four car lots with 138 car slots and 24 motorcycle bays, and Motorcycle Parking with 80 motorcycle bays), six drivers, about two weeks of booking history, a car currently parked and an
arrival expected later today.

### Development credentials

| Role          | Email                      | Password        |
| ------------- | -------------------------- | --------------- |
| Administrator | `admin@university.local`   | `Admin@12345`   |
| Driver        | `driver@university.local`  | `Driver@12345`  |

All demo drivers (`maria.santos@…`, `paolo.reyes@…`, `angela.cruz@…`, `carlo.mendoza@…`, `liza.fernandez@…`, all
`@university.local`) share `Driver@12345`. **These credentials are for development only.** Demo data is never loaded by
default when `NODE_ENV=production`.

### Requirements

* Node.js **22 or newer** (the project was built and tested on Node 22.22.0 — see [Known limitations](#known-limitations)).
* `npm`. `better-sqlite3` ships its prebuilt binaries inside the npm package (Windows, macOS and Linux on x64/arm64), so
  no compiler is needed. The bundled `.npmrc` sets `ignore-scripts=true` so npm does not try to compile it from
  source anyway; none of the dependencies need install scripts, and `npm start` / `npm test` / `npm run …` still work.

### npm scripts

| Script              | What it does                                                                         |
| ------------------- | ------------------------------------------------------------------------------------ |
| `npm start`         | Start the server                                                                     |
| `npm run dev`       | Start with automatic restart on file changes                                         |
| `npm test`          | Run the automated test suite (Node's built-in test runner, ~11 s)                    |
| `npm run check`     | Syntax-check every `.js` file and compile every EJS template                         |
| `npm run db:init`   | Create the database file and apply migrations (creates an admin from `ADMIN_EMAIL`/`ADMIN_PASSWORD` if set) |
| `npm run db:info`   | Read-only report: applied migrations, new auth columns/tables, verified vs unverified accounts |
| `npm run mail:preview` | Render the three e-mails to `data/mail-preview/` (nothing is sent) |
| `npm run db:seed`   | Load demo data into an **empty** database                                            |
| `npm run db:reset`  | Delete the database file and rebuild it with demo data (refused in production)       |

---

## What you can do

### Drivers
* **Dashboard** — upcoming and active reservations, balance due, quick link to Find Parking.
* **Find Parking** — pick a date, start/end time, zone and vehicle; availability **refreshes automatically** after each
  change; there is no search button (one appears only without JavaScript). The **map is the only view**: every bay of
  the zone stays on it with its state (available, reserved, occupied, unavailable, maintenance) whatever the vehicle
  filter, and bays for the other kind of vehicle are shown greyed out and cannot be chosen. A car or motorcycle icon
  follows the chosen vehicle (dropdown, vehicle card), and a banned plate is flagged. Choose a green slot on the map,
  review the slot details and the summary panel, then continue to a confirmation page. Refreshes go through AJAX (only the newest answer is applied); the page also works as plain server-rendered HTML.
* **My Reservations** — filter by upcoming / active / completed / cancelled, open details, **reschedule** (re-checked
  against availability) or **cancel** (a late-cancel fee applies inside the free-cancellation window).
* **Payments** — balances and payment history, receipts.
* **Etiquette Reports** — report another vehicle by plate number: type of violation, what happened, date and time,
  and an optional image (JPEG/PNG/WebP/GIF, up to 2 MB, stored in SQLite). Follow each report's status (pending, under
  review, resolved, dismissed) and the administrator's notes, and see any penalties on your own vehicles' plates.
* **My Vehicles** — add, edit and remove vehicles (plate numbers are unique). A vehicle is a **car or a motorcycle**
  (vans and SUVs are registered as cars). Manufacturer and model are dropdowns that follow the vehicle type
  (`public/js/vehicle-catalog.js`, shared with the server), each with an **Other** choice for typing a name that is
  not listed.
* **Sidebar badges** on My Reservations, Payments and Etiquette Reports count updates about your own records made by
  others (a booking cancelled, rescheduled, checked in/out or marked no-show by staff; a payment recorded or voided; a
  report reviewed; a penalty applied to or lifted from your plate). The records behind them are highlighted on the page
  you open until you have seen it once.
* **Profile** — update contact details and change the password. Full names allow letters (any alphabet), spaces and
  hyphens only (`public/js/name-rules.js`, also used at sign-up); a new password must differ from the current one.
* Drivers can **register themselves** — with a 6-digit code e-mailed to confirm the address — and
  reset a forgotten password through an e-mailed link. Accounts can be deactivated by an administrator (takes effect
  on the next request).

### Administrators
* **Dashboard** — live KPIs, occupancy bar, reservations per day, outcomes, peak hours, demand by zone and daily
  collections, plus who is parked and who is arriving. Every number comes from a SQLite query.
* **Parking Slots** — the campus layout is **fixed** (zones, slot codes, types and positions come from
  `src/db/lotPlans.js`): nothing creates, deletes, moves or re-types a zone or slot. Administrators see each zone's
  lot map with live states and manage how slots operate: active / maintenance / inactive, notes and a per-slot rate
  override.
* **Reservations** — listed by priority: today's first, then future (soonest first), then past (most recent first),
  by campus date. Search and filter, view the full history of one booking, cancel (reason required, fee can be
  waived) or mark no-show.
* **Sidebar badges** on Reservations, Payments and Etiquette Reports count updates made by others since you last
  opened that section (new, cancelled, rescheduled or missed bookings; payments recorded or voided; balances newly owed;
  new etiquette reports). They refresh every 30 seconds, and the records behind them are highlighted on the page you
  open (with a "New" pill) until you have seen it once. Read state is stored per user (`notification_reads`).
* **Check-in / Check-out** — search by booking reference or plate; arrivals and parked vehicles are listed. Occupancy
  changes **only** when staff confirm an arrival or departure — "reserved" never silently becomes "occupied".
* **Payments** — record **cash** payments manually (cash is the only accepted method; older GCash / bank-transfer
  records are kept and still count), print receipts, void a payment (reason required; voided payments stop counting
  but stay in the history).
* **Drivers** — create, edit, deactivate and reset the password of drivers (and create further administrators); see their vehicles and history.
* **Etiquette Reports** (replaces the former analytics Reports page) — every report drivers submitted, open ones first,
  with the plate's report count and active penalties. Review a report (status, severity, notes for the reporter) and
  penalise the plate: a **permanent additional fee** added to every new reservation with that plate, a **temporary
  ban** (1–365 days) or a **permanent ban** from reservations and reschedules. A plate page shows who has it registered
  and all its reports and penalties. Penalties belong to the plate (re-registering the vehicle does not escape them),
  can be lifted with a reason but never deleted, ask for confirmation first, and are written to the audit log.
* **Settings** — booking rules, rates and slot types, and the searchable **audit log** (each entry's details shown as a
  labelled list).

---

## Rules and billing

All of these are editable under *Settings → Booking rules* (defaults shown).

| Rule                                   | Default                                   |
| -------------------------------------- | ----------------------------------------- |
| Facility hours                         | 06:00 – 22:00 (bookings never cross midnight) |
| Booking step                           | 60 minutes (30 is selectable)             |
| Minimum / maximum booking              | 60 minutes / 8 hours                      |
| Book in advance                        | up to 14 days                             |
| Active reservations per driver         | 5                                         |
| Early check-in                         | 15 minutes before the start               |
| Late-arrival grace                     | 15 minutes (afterwards the booking can be marked no-show; a sweep closes bookings that ended unused) |
| Free cancellation                      | until 2 hours before the start            |
| Late-cancellation fee                  | 50 % of the estimated fee                 |
| No-show fee                            | 50 % of the estimated fee                 |
| Overstay grace / rate                  | 10 minutes / 150 % of the hourly rate     |
| Billing increment                      | 60 minutes, rounded **up**                |

* **Rates** — most specific wins: slot override → zone + slot type → zone → slot type → default. Seeded: ₱20 default,
  ₱30 regular, ₱20 accessible, ₱15 motorcycle per hour. A reservation **locks its rate when it is booked**.
* **Etiquette penalties** — an additional fee on a plate is added to the estimated fee of every reservation made with
  that plate from then on (stored on the booking, so later changes do not alter it). Late-cancellation and no-show
  fees are a percentage of the reserved fee without it, plus the additional fee in full; a free cancellation costs
  nothing. A banned plate cannot book or reschedule; bookings made before the ban are kept.
* **Zones** — cars (vans and SUVs included) park in Main Building, Engineering, Science and Administration (accessible bays included);
  motorcycles park in Motorcycle Parking (MC) and in the few motorcycle bays of Engineering (EN-21..30), Science
  (SC-31..38) and Administration (AD-17..22). There are no EV charging slots. A slot taken out of a lot but with
  booking history is *retired*: hidden from maps and lists, kept for its records (`npm run db:lots` applies the lot plans).
* **No overlaps, adjacency allowed** — 9–10 and 10–11 can both be booked on one slot. A vehicle also cannot hold two
  overlapping reservations. A checked-in vehicle keeps blocking its slot until it leaves (or the booked end, if later).
* **Overstay** — past the grace period, *all* minutes beyond the reserved end are billed at the overstay rate.
  There is no refund for leaving early.
* **A fee becomes final only** on check-out, cancellation or no-show; before that the page shows an *estimate*.
  Balance = (final or estimated fee) − valid payments. Overpayments are refused.
* **Money** is stored as integer centavos; **times** are stored as campus-local text (`YYYY-MM-DD HH:MM:SS`).

---

## Architecture

```
server.js                 start-up: config → database → (first-run seed) → Express → no-show sweep
src/
  config.js               environment configuration
  app.js                  Express app: security middleware, sessions, static assets, routes
  db/                     better-sqlite3 setup, migrations/, seed, CLI, SQLite session store
  services/               business logic (availability, reservations, fees, sessions, payments, etiquette, …);
                          mail.js (outgoing e-mail: console or SMTP) and mailTemplates.js (the three e-mails);
                          registration.js (sign-up codes), passwordReset.js (reset links)
  routes/                 auth.js, driver.js, admin/*.js  (thin: parse → call service → render/redirect)
  middleware/             security (helmet, CSRF, rate limits), auth/role gates, view rendering, errors
  utils/                  time (campus-local, injectable clock), money, validation, CSV, pagination,
                          email.js (server side of the e-mail rules: DNS check)
views/                    EJS pages; partials/ holds the reusable parking-slot, map, summary, stat, table … components
                          (auth/login.ejs and auth/register.ejs are one-line wrappers around partials/auth-shell.ejs)
public/css/               theme.css (design tokens), components.css, auth.css (sign-in / sign-up screen), parking-slots.css
public/js/                app.js, auth.js (sign-in / sign-up screen), email-rules.js (e-mail rules shared with the server),
                          parking-slots.js, reservation-form.js, charts.js
scripts/                  syntax-check.js, mail-preview.js (render the e-mails), db-info.js (inspect the database)
tests/                    automated tests (node:test)
```

**Database tables:** `users`, `vehicles`, `parking_zones`, `slot_types`, `parking_slots`, `parking_rates`,
`reservations`, `parking_sessions`, `payments`, `audit_logs`, `settings`, `sessions`, `pending_registrations` and
`password_resets`. Foreign keys are enforced, WAL mode is on, and schema changes are applied by numbered migrations in
`src/db/migrations/` (`NNN_name.sql`, or `NNN_name.js` for changes SQLite cannot express idempotently, such as
`ALTER TABLE … ADD COLUMN`). Run `node scripts/db-info.js` to see which migrations a database has and how many accounts
are verified.

**Double-booking protection.** Booking runs inside one `BEGIN IMMEDIATE` transaction that re-checks availability, and
SQLite triggers (`RESERVATION_OVERLAP`, `SLOT_NOT_ACTIVE`) enforce the same rule inside the database as a second line of
defence. A multi-process test with eight racing processes confirms exactly one booking wins.

### Security
* Passwords hashed with bcrypt; password rules enforced; sessions regenerated on sign-in.
* Session-bound **CSRF token** on every state-changing request (`_csrf` field or `X-CSRF-Token` header).
* Sign-in and registration **rate limiting**; generic sign-in errors (no account enumeration).
* Helmet security headers with a strict Content-Security-Policy (`script-src 'self'` — no inline scripts; inline *styles* are allowed for layout widths).
* Role checks on every route; drivers can only see their own records (others return 404); deactivated users are
  signed out on their next request.
* All SQL is parameterised; EJS output is escaped; CSV export neutralises spreadsheet-formula injection.
* Important actions (sign-in, bookings, check-in/out, payments, voids, settings, user changes) are written to the audit log.
* **E-mail addresses** are checked by one shared rules file (`public/js/email-rules.js`, run by the browser for quick
  feedback and by the server, which is authoritative): format, a typo guard for the big providers (`gmail.com.com`,
  `gmial.com`) and Gmail's own rules. At sign-up the server also asks DNS whether the domain can receive mail (3 s
  limit, 10 min cache; a slow or failing lookup never blocks anyone, and a "no such domain" answer is only believed when
  a control lookup of a known-good domain succeeds). Uniqueness ignores case; addresses are stored in lower case.
* **Outgoing mail** is configured only through the environment. `MAIL_MODE=console` (print to the terminal) is refused
  when `NODE_ENV=production`, both at start-up and by the mailer itself. Every link in an e-mail is built from
  `APP_BASE_URL`, never from the request's Host header. Codes, tokens and SMTP passwords are never logged.
* **Sign-up codes** come from `crypto.randomInt`, are stored only as HMAC-SHA256 (keyed by `AUTH_CODE_SECRET`, bound to
  the pending sign-up's id) and compared with `timingSafeEqual`. A code lives 10 minutes and survives 5 wrong tries;
  resends wait 60 s and stop after 5. No `users` row exists until the code is verified, and the pending sign-up's id
  lives in the session, never in a URL. A second visitor signing up with the same address gets a new id, so they cannot
  finish (or hijack) the first visitor's sign-up.
* **Reset links** carry 32 random bytes (base64url); only the SHA-256 hash is stored. They live 30 minutes, work once,
  and a new request voids the older ones. "Forgot password" always shows the same answer and does its work after the
  response, so neither the text nor the timing reveals whether an account exists (at most 3 links per account per
  hour; extra requests are silently dropped). Opening a link moves the token's hash into the session and redirects to
  a clean `/reset-password`, which is sent with `Referrer-Policy: no-referrer`. A reset signs the account out
  everywhere (its sessions are deleted, and any session that began before `password_changed_at` is refused) and
  e-mails a "password changed" notice.
* **Every successful sign-in** (password or code) regenerates the session id.

**Rate limits** (per IP address, in addition to the per-code and per-account limits above):

| Endpoint | Limit |
| --- | --- |
| `POST /login` | 10 failed attempts / 15 min (`LOGIN_RATE_*`) |
| `POST /register` | 30 / hour |
| `POST /register/verify` | 30 / 15 min |
| `POST /register/resend` | 10 / hour |
| `POST /forgot-password` | 10 / 15 min |
| `POST /reset-password` | 10 / 15 min |

---

## Configuration

Set values in `.env` (see [`.env.example`](.env.example) — it contains no secrets).

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT`, `HOST` | `3000`, `127.0.0.1` | Listen address. Use `HOST=0.0.0.0` to reach it from other devices. |
| `NODE_ENV` | `development` | `production` enables strict checks (see below). |
| `APP_TIMEZONE` | `Asia/Manila` | Campus time zone (fixed UTC offset assumed). |
| `DATABASE_PATH` | `data/parking.sqlite` | SQLite file location. |
| `SESSION_SECRET` | – | **Required in production** (≥ 16 chars). Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `APP_BASE_URL` | `http://<HOST>:<PORT>` | The site's public address; every link in an e-mail is built from it. **Required in production, and must be `https://`.** |
| `AUTH_CODE_SECRET` | derived in dev | Signs the 6-digit sign-up codes before they are stored (HMAC-SHA256). **Required in production** (≥ 32 chars). |
| `EMAIL_DNS_CHECK` | `true` | Ask DNS whether a new sign-up's domain can receive mail. `false` skips it (offline machines). |
| `MAIL_MODE` | `console` in dev, `smtp` in production | `console` prints each message in the terminal and sends nothing (**refused in production**); `smtp` uses the `SMTP_*` settings; `brevo` uses Brevo's HTTPS API. |
| `BREVO_API_KEY` | – | Brevo API key for `MAIL_MODE=brevo` (with `MAIL_FROM` set to a sender verified in Brevo). |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | –, `587`, –, –, – | SMTP server for `MAIL_MODE=smtp`. Port 587 requires STARTTLS; 465 is TLS from the first byte. |
| `SESSION_MAX_AGE_HOURS` | `8` | Sign-in lifetime. |
| `COOKIE_SECURE`, `TRUST_PROXY` | `false` | Set both to `true` behind an HTTPS reverse proxy. |
| `LOGIN_RATE_WINDOW_MINUTES`, `LOGIN_RATE_MAX_ATTEMPTS` | `15`, `10` | Sign-in throttling. |
| `SEED_DEMO_DATA` | `true` in dev, `false` in production | Load demo data when the database is empty. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | – | Create the first administrator when demo data is off. |
| `BCRYPT_ROUNDS` | `10` | Password hashing cost. |
| `NO_SHOW_SWEEP_SECONDS` | `60` | How often overdue bookings are closed as no-shows. |

Without `SESSION_SECRET`, development mode generates a random one at every start, which signs everybody out on
restart — set one in `.env` to keep sessions across restarts.

### Sending e-mail

Nothing is sent until you choose `MAIL_MODE=smtp`. With the default `console` mode every e-mail is printed in the
terminal where `npm run dev` runs, which is all you need to develop and test. To preview how the three messages look
without sending anything: `node scripts/mail-preview.js` writes HTML and text files to `data/mail-preview/`.

**Using a Gmail account** (fine for a demo or a handful of messages a day; not for a production service):

1. Turn on **2-Step Verification** for the Google account (myaccount.google.com → Security). App Passwords do not exist without it.
2. Create an **App Password** (myaccount.google.com → Security → 2-Step Verification → App passwords). Google shows a
   16-character password once; it is not your normal password and can be revoked at any time.
3. In `.env`: `MAIL_MODE=smtp`, `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`, `SMTP_USER=<the Gmail address>`,
   `SMTP_PASS=<the App Password>`, `MAIL_FROM="University Parking <the Gmail address>"`.

Gmail rewrites the "From" address to the signed-in account and limits how many messages one account may send per day.
For real traffic use a transactional e-mail provider with your own domain (SPF/DKIM) and put its SMTP details in the same variables.

**Using Brevo (HTTPS, works where SMTP is blocked — e.g. Railway below the Pro plan):**

1. Create a free account at [brevo.com](https://www.brevo.com) (the free plan sends a limited number of e-mails per day).
2. *Senders, domains & dedicated IPs → Senders → Add a sender*: the address mail should come from (your Gmail works);
   Brevo e-mails it a confirmation link. Only verified senders can be used.
3. *SMTP & API → API keys → Generate a new API key*. Copy it straight into your variables; it is shown once.
4. Set `MAIL_MODE=brevo`, `BREVO_API_KEY=<the key>`, `MAIL_FROM="University Parking <the verified address>"`.
5. If sends fail with `BREVO_401 ... unrecognised IP address`, open *Security → Authorised IPs* in Brevo and turn off
   IP blocking for the API (hosted platforms such as Railway do not have a fixed outgoing address).

A free Gmail address as the sender works for a demo, but some inboxes file it as spam because Brevo is not Gmail; a
domain of your own, authenticated in Brevo, fixes that.

### Putting it into real use
1. `NODE_ENV=production`, a real `SESSION_SECRET` and `AUTH_CODE_SECRET`, `APP_BASE_URL=https://your-site`, working
   `SMTP_*` / `MAIL_FROM` settings, and `ADMIN_EMAIL` / `ADMIN_PASSWORD` with `SEED_DEMO_DATA=false`
   (sign in and change the password). The server refuses to start while any of these is missing or wrong.
2. Serve it behind HTTPS (nginx, Caddy, …) and set `COOKIE_SECURE=true` and `TRUST_PROXY=true`.
3. Run **one** application process — the SQLite file is the single source of truth (WAL mode allows concurrent reads).
4. **Back up** `data/parking.sqlite` (use `sqlite3 data/parking.sqlite ".backup backup.sqlite"` or copy the file while
   the app is stopped; copy the `-wal` file too if you copy a running database).

---

## Testing

```bash
npm test         # 200+ tests, ~20 s, no network required
npm run check    # syntax and template compile check
```

The suite starts the real Express app on an ephemeral port with a fresh SQLite file and drives it over HTTP with a
cookie-aware client. It covers page rendering for both roles, authentication and role separation, CSRF, rate limiting,
the booking rules (overlap, adjacency, limits, reschedule, cancel), fees and overstay, check-in/out and no-shows,
payments and voids, reports and CSV, settings and the audit log, restart persistence, demo-data generation at
different times of day, and a multi-process concurrency test. The clock is injectable, so time-dependent rules are
tested deterministically. `tests/email-rules.test.js` covers the shared address rules and the DNS checker (with a fake
resolver), `tests/mail.test.js` the mailer, the templates and the production configuration checks (in clean child
processes), `tests/migration.test.js` upgrades a copy of the previous release's database, and
`tests/register-email.test.js` drives the sign-up route and the static logo, and `tests/auth-flows.test.js` covers the
verification code (wrong / expired / locked / resend / cooldown / takeover), forgot and reset password (identical
answers, single-use links, sessions signed out).

The interactive map, zone tabs, confirmation dialogs and charts were additionally exercised in headless Chromium
during development (desktop 1440 px and mobile 390 px, including console-error checks); those browser scripts are not
part of the distributed test suite. The same goes for the sign-in / sign-up screen's motion, focus handling and history
behaviour (see the checklist below); `tests/auth-ui.test.js` covers what the server decides.

---

## Sign-in / sign-up screen

`/login` and `/register` are one screen: a single card holding both forms, with a brand overlay that slides between
them (≥ 900 px) or a two-segment control above sliding panes (< 900 px). The same card also hosts the verification
code, forgot-password and reset-password steps. Field names, CSRF and the password sign-in are unchanged.

```
views/auth/login.ejs, register.ejs        one line each: include the shell with mode = 'login' | 'register'
views/partials/auth-shell.ejs             the card: overlay, both forms, live region (server sets data-mode)
views/partials/auth-field.ejs             one field: label, input, show/hide toggle, error line
public/css/auth.css                       layout, motion tokens and every transition (all driven by [data-mode])
public/js/auth.js                         progressive enhancement: history, inert, focus, toggle, validation, loading
```

* **Without JavaScript** the switch controls are ordinary links to `/login` and `/register`; each URL renders in the
  right mode with the other form `inert`.
* **With JavaScript** a switch sets `data-mode` (CSS does all the movement, so it can be interrupted at any point),
  pushes `/login` or `/register` onto the history keeping the query string, updates the title and the `inert` state,
  announces the change in a polite live region, and moves focus into the new form once the slide ends (to the heading
  on touch devices, so the on-screen keyboard does not open by itself).
* **Motion** timings live in `:root` of `auth.css` (`--dur-micro/fast/form/slide`, `--ease-*`). `.is-ready` is added
  after the first painted frame, so a page that loads in register mode does not animate. With
  `prefers-reduced-motion` the slide becomes a 150 ms cross-fade.
* **Client-side validation** mirrors the server rules for quicker feedback; the server remains the authority and its
  messages are rendered in the same place. The create-account e-mail field runs the same rules file as the server
  (`public/js/email-rules.js`); when the domain looks like a mistyped well-known provider it also offers
  "Did you mean hehe@gmail.com?" with a **Use it** button (opens in 200 ms; with reduced motion it fades in over 150 ms). Sign-in keeps a
  lenient check on purpose, so accounts created under older rules can always try their password.
* **The logo is a label, not a control** on every auth screen: a plain `div` (no link, no button, not in the Tab order,
  no pointer cursor, no hover or focus styling, not draggable).
* **Steps inside a pane.** Each pane is a stack of steps in one grid cell, so the card never changes height:
  sign in → *Reset your password* (`/forgot-password`) → *Check your email*, sign-up form → *Check your email*
  (`/register/verify`), and the reset screen (`/reset-password`, overlay fixed on the left, no switch). In-page steps
  use `pushState` and every URL is also a real route. Forward: the old step fades to −24 px (180 ms, ease-in), the new
  one arrives from +24 px (280 ms, ease-out, 140 ms later); back mirrors it. A step reached through the server (form →
  code) plays only its entrance. Below 900 px the two-segment control gives way to a **Back** button during these flows.
* **The code field** is one `<input autocomplete="one-time-code" inputmode="numeric" maxlength="6">` drawn as six boxes;
  pasting "123 456" works, the 6th digit submits, success turns the boxes green with a check before the redirect, and
  failure clears and refocuses the field. "Resend code" counts down and is announced once, when it becomes available.

**Manual checks** (a real browser; sizes 1920×1080, 1366×768, 768×1024, 390×844, and once with reduced motion):

1. `/register` opens in sign-up mode with nothing animating; `/login` opens in sign-in mode with the email field focused.
2. Click the overlay button: the overlay crosses in about 600 ms, the old form fades out, the new one fades in; click
   again mid-slide and it reverses smoothly from where it is.
3. Back, Forward and refresh land on the right mode, and `?query` strings survive a switch.
4. The card is exactly as tall in both modes; Tab visits only the visible form, then the switch link.
5. A wrong password re-renders `/login` (no slide, alert focused); a duplicate e-mail re-renders `/register` with the
   message on the field; the submit button shows "Signing in…" / "Creating account…" while the request runs.
6. Show/hide works on all three password fields; blur validation shows the same messages the server would.
7. With reduced motion on, switching cross-fades in about 150 ms and nothing travels.


---

## Known limitations

* **Payments are manual by design** — staff record what they receive at the office. No online payment, no refunds
  module (a voided payment is the correction mechanism), and no booking e-mail/SMS notifications (e-mail is used only
  for sign-up codes and password resets).
* **Node version:** developed and tested on **Node 22.22.0**. `engines` allows Node 22 and newer, but newer majors
  (for example Node 26) have not been run against this project; `better-sqlite3` must publish a build for your Node version.
* **Dependency substitutions:** sessions use a small built-in SQLite session store (`src/db/sessionStore.js`) on top of
  `better-sqlite3`, and password hashing uses `bcryptjs` (pure JavaScript), because `connect-sqlite3` and the native
  `bcrypt` could not be installed in the environment the project was built in. `bcryptjs` produces standard bcrypt hashes.
* **One time zone, fixed offset** (no daylight-saving handling) and **single-process** operation.
* Browser support: current Chrome, Edge, Firefox and Safari; choosing a slot on the map requires JavaScript (a
  server-rendered fallback shows availability without it). Attaching an image to an etiquette report also needs it.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Cannot find module 'better-sqlite3'` or a native-module load error | Run `npm install` again. On a platform without a bundled binary, install Python 3 and a C++ compiler, then `npm rebuild better-sqlite3 --ignore-scripts=false --build-from-source`. |
| `SESSION_SECRET must be set` | You are in production mode — add a secret to `.env`. |
| "No users exist yet" at start-up | Set `SEED_DEMO_DATA=true`, or `ADMIN_EMAIL` and `ADMIN_PASSWORD`, then restart. |
| Signed out after every restart | Set a fixed `SESSION_SECRET` in `.env`. |
| Every form says "Your session expired or the form was invalid" (403) | `COOKIE_SECURE=true` on a plain `http://` address: the session cookie is never set. Use `COOKIE_SECURE=false` and `TRUST_PROXY=false` unless an HTTPS proxy is in front. |
| On Railway (or another host) the log shows `[mail] ... was not sent: ETIMEDOUT` / `ECONNECTION` | The host blocks SMTP ports. Use `MAIL_MODE=brevo` (see "Using Brevo"). |
| The log shows `BREVO_401` | Wrong `BREVO_API_KEY`, or Brevo blocked the server's IP: turn off IP blocking under *Security → Authorised IPs*. |
| The log shows `BREVO_400` | Usually `MAIL_FROM` is not a verified sender in Brevo. |
| No verification e-mail arrives; the terminal shows `[mail] ... was not sent: EAUTH` | Gmail refused the login: `SMTP_PASS` must be a current 16-character App Password (no spaces), not your Google password. |
| `EADDRINUSE` | Another process uses the port — change `PORT`. |
| Start again from scratch | Stop the server and run `npm run db:reset`. |
#   P e t e r P a r k i n g  
 #   P e t e r P a r k i n g  
 #   P e t e r P a r k i n g  
 