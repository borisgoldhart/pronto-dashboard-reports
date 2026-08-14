# Pronto Dashboard

> Full reference — stack, auth flows (incl. "Sign in with HavasPronto"), widget/graph
> schema, endpoints, and the per-user cache schema — lives in
> **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

A fast, standalone HTML reporting dashboard that replaces the legacy havaspronto.com
reporting UI. It talks to the **Pronto Reporting API** (Solr-backed), caches historic
results permanently, and lets users build/resize graph widgets on a dashboard.

Architecture: **Node/Express backend proxy + SPA frontend** (ECharts + Gridstack).
The backend holds the credential, solves CORS, and owns the cache — so the app can be
hosted standalone, parallel to havaspronto.com.

## Build phases

1. **Authentication & API connectivity** — ✅ done (login → bearer → verified)
2. **Dashboard grid layout** (Gridstack, add/resize widgets + ECharts) — ✅ built
3. **Legacy field naming captured** — ✅ see `docs/legacy-report-fields.md`; the real
   8 data sources + 93-field Group By/Sub-group/Filter list + intervals now drive the
   builder (`server/fields.js`, served via `/api/report/options`) ← _you are here_
4. **Office filter (SAYT)** — ✅ search-and-add multiple offices in the report fly-out;
   list derived from the reporting facet (`GET /api/report/offices`, cached 7 days),
   filter fans out one query per office and merges. Also: header ⓘ hover showing applied
   filters, auto-title from data source + dates, single-slice chart tooltips.
5. Full graph-builder UI polish (Sub-group + Pivot + stats-field picker + donut/semi
   chart types) and standalone hosting (optional SQLite/Redis cache swap)

## Phase 2 — run the dashboard

```bash
npm start          # then open http://localhost:8787
```

Click **+ Add widget**, choose a data source / group-by / interval / chart type, and
Apply. Tiles are drag-repositionable and resizable (drag the tile edges/corner);
charts re-fit on resize. **Save layout** persists widget specs + positions to
`data/dashboard.default.json` so the board reloads exactly as left. Each tile's ⟳
refetches bypassing the cache; ✎ edits; 🗑 removes.

Supported chart types: grouped bar, stacked column, line, pie. The top nav mirrors the
Pronto UI for visual alignment.

## Phase 1 — quick start

```bash
cd pronto-dashboard
npm install
cp .env.example .env      # then edit .env (see below)
npm run verify            # hits the live API, confirms auth + caching
npm start                 # then open http://localhost:8787
```

### Credentials (`.env`)

Authentication uses Pronto's **Bearer Auth**:

```
POST /v2/api/auth/login  { email, password }   ->  { token }
Authorization: Bearer <token>                   (sent on every API call)
POST /v2/api/auth/me                            (verifies the token)

## Multi-user mode (team sharing)

Leave the .env credentials empty and the app requires a login. The primary path is
**"Sign in with HavasPronto"** — the PKCE-broker flow the Pronto Time Tracker uses:
the user logs in on havaspronto.com itself (SSO included), the dashboard polls the
site's `pkce/exchange` endpoint and never sees credentials. Fallbacks: email+password
(exchanged for a bearer token via POST /v2/api/auth/login — the password is never
stored) or pasting an API token.
Sessions live in an httpOnly `pronto_sid` cookie, persisted in `.cache/.sessions.json`
(30-day expiry, survives restarts). Every report query runs with the user's own
credentials, so results respect their Pronto permissions. Dashboards + widget
definitions are stored per user in `data/users/<pronto-user-id>/`, and the report
cache is partitioned by user id — no cross-user leakage. Logout lives in the
avatar menu. If a token generator page exists on havaspronto.com, set
TOKEN_GENERATOR_URL and the login screen will link to it.

Expired user tokens are refreshed transparently via `POST /v2/api/auth/refresh`
(contract confirmed from the Pronto Time Tracker app — see
`docs/reference/time-tracker-auth.md`, which also documents the site's OAuth2
PKCE-broker endpoints, the likely path to "Sign in with HavasPronto" SSO).
```

Set credentials in `.env`, in precedence order:

- `PRONTO_EMAIL` + `PRONTO_PASSWORD` — **recommended.** The server logs in, caches the
  token, and re-logs-in automatically on a 401. Best for standalone hosting.
- `PRONTO_BEARER_TOKEN` — a token you already hold; used directly, no login.
- `PRONTO_COOKIE` — legacy same-origin session fallback.

The token lifecycle lives in `server/session.js`; the cached token is stored in
`.cache/.token.json`.

## How the graph builder maps to the API

| Legacy UI field   | API param        | Example values |
|-------------------|------------------|----------------|
| Data Source       | `{core}/{entity}`| `report/user_history`, `report/timesheet_user_data`, `search/job`, `search/asset` |
| Group By          | `facet_field`    | `client_office_name`, `brandcat_name`, `author_office_name`, `job_office_name`, `author_name`, `jobid` |
| Interval          | `gap`            | `+1MONTH`, `+1DAY`, `+6MONTHS` |
| Display Data As   | count vs sum     | `count` field, or `report_stats_field` + `stats_field_sum` |
| Date Range        | `date_range`     | `01-01-2026 to 30-06-2026` (DD-MM-YYYY) |
| Filters           | `filter_fields[n][name/value]` | e.g. `author_office_name=Global Resource Pool (Agency)` |

Response is Solr JSON: `facets.interval_report.buckets[]` (per interval) →
`.facet.buckets[]` (per group) with `count` and `stats_field_sum`.

### Second data source (bar / stacked column only)

`spec.overlay = { enabled, dataSource, displayAs, statsField }` runs a **second** query
and draws it as a line on its own right-hand axis — e.g. project count as columns
against timesheet hours as a line. It is deliberately constrained:

- It inherits the date range, interval, offices and filters of the primary. Two series
  are only comparable if they were measured over the same windows, so those controls
  are not repeated in the UI.
- It is always **ungrouped** — one total per interval. Splitting the second source by
  the same group as the bars would put a dozen lines over a dozen stacks.
- Office filters are re-resolved per source: timesheets attribute to the user's office
  (`author_office_name`), jobs to the project's office (`client_office_name`).
- Points are merged onto the primary's buckets **by label, not by position**. The API
  omits a bucket when a source has no rows in that window, so a positional merge would
  shift the line by a month. A missing month is `null` (a gap in the line), never `0`.
- A failure in the second query never fails the widget: the bars still render and the
  tile header says the second source is unavailable.

See `overlaySpecFor()` / `alignOverlay()` in `server/query.js`.

## API (backend)

| Route | Purpose |
|-------|---------|
| `GET  /api/health` | server up + auth mode |
| `GET  /api/auth/status` | which credential mechanism is configured |
| `GET  /api/auth/verify` | fire a small live query, confirm auth works |
| `GET  /api/report/options` | enums for the graph-builder UI |
| `POST /api/report/query` | run a report (body = widget spec); cached |
| `GET  /api/report/cache/stats` · `POST /api/report/cache/clear` | cache admin |

## Caching

File-based JSON cache, one file per query, keyed by a hash of the widget spec. Historic
data never changes, so entries are permanent (no TTL). Swappable for SQLite/Redis later
— see `server/cache.js` (small interface: `get`/`set`/`stats`/`clear`).
