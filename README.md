# Orange Sync Demo

Demo for two-way sync with Orange ORM.

The demo intentionally syncs ORM/patch writes only. Raw SQL is used for database setup, not for user writes.

## Run

```bash
npm install
DATABASE_URL=postgres://orange:orange@localhost:54329/orange_sync_demo npm run dev
```

In a devcontainer, open http://localhost:8080 and run:

```bash
npm run dev
```

The backend uses Postgres through `DATABASE_URL`. The devcontainer defines Postgres in Docker Compose and exposes the app through nginx with Brotli/gzip compression on port 8080.

Root `npm install` installs both `client` and `server`. You can also install them separately:

```bash
cd client && npm install
cd ../server && npm install
```

nginx devcontainer entrypoint: http://localhost:8080

Backend direct: http://localhost:3055

Frontend direct: http://localhost:5173

## Big Bootstrap Sync

Use a separate browser OPFS database for bootstrap sync performance testing:

```bash
npm run dev:big
```

This uses `orange-sync-demo-big2.sqlite3`. To test sync transfer performance, choose a profile and click `Seed server + bootstrap sync`. This resets the server demo tables, creates synthetic server-side rows, resets the local big database, and performs a real bootstrap pull through `/rdb?sync=pull`.

To measure a full bootstrap sync without reseeding the server, click `Bootstrap sync`. This resets only the local browser database and pulls the current server rows. `Reset local only` clears the local browser database without starting a sync.

- `Many`: 50,000 projects, 150,000 tasks, short summaries
- `Wide`: 10,000 projects, 20,000 tasks, 8 KB summaries
- `Mixed`: 25,000 projects, 125,000 tasks, 1 KB summaries

The project list is paged so the UI only reads one page from local SQLite at a time.

Use browser network throttling to simulate low bandwidth; the demo does not add artificial server delay or change sync batch sizes for these profiles.

Sync timing is logged to the browser console as `[sync-trace]`. In big mode, apply-phase SQL timing is logged as `[sync-apply-sql]`; disable or enable it at runtime with `orangeSyncTrace.setApplySql(false)` / `orangeSyncTrace.setApplySql(true)`, or set `VITE_TRACE_APPLY_SQL=0|1` before starting the demo.

## Model

Relations included:

- `team.people`: `hasMany`
- `person.team`: `references`
- `project.owner`: `references`
- `project.detail`: `hasOne`
- `project.tasks`: `hasMany`
- `task.project`: `references`
- `task.assignee`: `references`

The browser client uses `sqliteOPFS` for local SQLite storage. Sync push/pull uses `/rdb?sync=push` and `/rdb?sync=pull`.
