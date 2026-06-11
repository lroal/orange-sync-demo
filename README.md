
 codex resume 019ea5ea-cbf2-7c81-9834-14e1aedde2e2
# Orange Sync Demo

Demo for two-way sync with Orange ORM.

The demo intentionally syncs ORM/patch writes only. Raw SQL is used for database setup, not for user writes.

## Run

```bash
npm install
npm run db:up
npm run dev
```

Root `npm install` installs both `client` and `server`. You can also install them separately:

```bash
cd client && npm install
cd ../server && npm install
```

Backend: http://localhost:3055

Frontend: http://localhost:5173

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
