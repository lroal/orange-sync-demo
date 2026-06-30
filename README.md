# Orange Sync Demo

Demo for two-way sync with Orange ORM.

The demo intentionally syncs ORM/patch writes only. Raw SQL is used for database setup, not for user writes.

## Run

```bash
npm install
DATABASE_URL=postgres://orange:orange@localhost:54329/orange_sync_demo npm run dev
```

In a devcontainer, open http://localhost:5173 and run:

```bash
npm run dev
```

The backend uses Postgres through `DATABASE_URL`. In the devcontainer, Vite serves the browser app on port 5173 while sync and API requests go through nginx on port 8080.

Root `npm install` installs both `client` and `server`. You can also install them separately:

```bash
cd client && npm install
cd ../server && npm install
```

Frontend devcontainer entrypoint: http://localhost:5173

nginx sync/API entrypoint: http://localhost:8080

Backend direct: http://localhost:3055

Frontend direct: http://localhost:5173

## Big Bootstrap Sync

Use a separate browser OPFS database for bootstrap sync performance testing:

```bash
npm run dev:big
```

This uses `orange-sync-demo-big2.sqlite3`. To test sync transfer performance, choose a profile and click `Seed server + bootstrap sync`. This resets the server demo tables, creates synthetic server-side rows, resets the local big database, and performs a real bootstrap pull through the nginx sync endpoint on `http://localhost:8080/rdb?sync=pull`.

To measure a full bootstrap sync without reseeding the server, click `Bootstrap sync`. This resets only the local browser database and pulls the current server rows. `Reset local only` clears the local browser database without starting a sync.

- `Many`: 50,000 projects, 150,000 tasks, short summaries
- `Wide`: 10,000 projects, 20,000 tasks, 8 KB summaries
- `Mixed`: 25,000 projects, 125,000 tasks, 1 KB summaries

The project list is paged so the UI only reads one page from local SQLite at a time.

Use browser network throttling to simulate low bandwidth; the demo does not add artificial server delay or change sync batch sizes for these profiles.

## Model

Relations included:

- `team.people`: `hasMany`
- `person.team`: `references`
- `project.owner`: `references`
- `project.detail`: `hasOne`
- `project.tasks`: `hasMany`
- `task.project`: `references`
- `task.assignee`: `references`

The browser client currently runs ORM and sync from the UI thread against `sqliteOPFS` with the `opfs-sahpool` VFS. SQLite/OPFS itself still runs in its required dedicated worker. When the UI is opened on Vite port 5173, sync push/pull uses nginx on `http://localhost:8080/rdb`.

## TODO

- Add proper `sqliteOPFS` concurrency for the SharedWorker model: keep write transactions exclusive with a FIFO writer checkout, and add a separate readonly connection/lane so reads can run during an active write transaction while only seeing committed snapshots when the active VFS supports it.
