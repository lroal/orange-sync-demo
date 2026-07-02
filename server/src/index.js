import cors from 'cors';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import rdb from 'orange-orm';
import { createDemoMap, demoCommands, demoDbOptions } from '../../shared/schema.js';

if (process.env.ORANGE_QUERY_LOG === '1')
  rdb.on('query', console.dir);

const require = createRequire(import.meta.url);
const orangeOrmMain = require.resolve('orange-orm');
const { setupChangeTracking } = require(path.join(path.dirname(orangeOrmMain), 'sync/setupChangeTracking.js'));
const port = Number(process.env.PORT || 3055);
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl)
  throw new Error('DATABASE_URL is required. Use the devcontainer Postgres service or set DATABASE_URL to a Postgres connection string.');

const map = createDemoMap(rdb);
const db = map({
  db: createDatabase,
  commands: demoCommands,
  ...demoDbOptions
})({
  commandHandlers: {
    async addServerTask(db, args) {
      const { projectId, title } = args || {};
      if (typeof projectId !== 'string' || !projectId)
        throw new Error('addServerTask requires projectId');

      await db.task.insert({
        id: randomUUID(),
        projectId,
        assigneeId: null,
        title: typeof title === 'string' && title ? title : 'Server command task',
        done: false,
        sortOrder: 99
      });
      return { created: true };
    }
  }
});

const schemaSql = `
create table if not exists team (
  id uuid primary key,
  name text not null
);

create table if not exists person (
  id uuid primary key,
  "teamId" uuid not null references team(id),
  name text not null,
  email text
);

create table if not exists project (
  id uuid primary key,
  "ownerId" uuid not null references person(id),
  title text not null,
  status text not null,
  "updatedAt" timestamptz
);

create table if not exists project_detail (
  id uuid primary key,
  "projectId" uuid not null unique references project(id) on delete cascade,
  summary text,
  "riskLevel" text
);

create table if not exists task (
  id uuid primary key,
  "projectId" uuid not null references project(id) on delete cascade,
  "assigneeId" uuid references person(id),
  title text not null,
  done boolean default false,
  "sortOrder" integer
);
`;

await initDatabase();

const app = express();
app.use(cors({
  origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
  credentials: false
}));
app.use(express.json({ limit: '5mb' }));

app.use((req, _res, next) => {
  console.log(new Date().toISOString() + ' ' + req.method + ' ' + req.originalUrl);
  next();
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/seed-big-server', async (req, res, next) => {
  try {
    const options = normalizeBigSeedOptions(req.body || {});
    const result = await seedBigServerDatabase(options);
    res.json(result);
  }
  catch (e) {
    next(e);
  }
});

app.use('/rdb', logSyncTiming);
app.use('/rdb', db.express({
  sync: {
    queue: { concurrency: 10, maxPending: 100 }
  }
}));

app.use((err, _req, res, _next) => {
  res.status(err.status || 500).json({
    error: err.message || String(err)
  });
});

const server = app.listen(port, () => {
  console.log("Orange sync demo backend listening on http://localhost:" + port);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error("Port " + port + " is already in use. Stop the existing dev server or set PORT to another value.");
    process.exit(1);
  }

  throw err;
});

function createDatabase(con) {
  return con.pg(databaseUrl, { size: 4 });
}

function logSyncTiming(req, res, next) {
  const startedAt = process.hrtime.bigint();
  const body = req.body || {};
  const phase = body.phase || body.action || 'api';
  const itemCount = Array.isArray(body.items)
    ? body.items.length
    : Array.isArray(body.mutations)
      ? body.mutations.length
      : 0;
  const tableCount = Array.isArray(body.tables) ? body.tables.length : 0;

  res.on('finish', () => {
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const parts = [
      `[sync] ${phase}`,
      `${res.statusCode}`,
      `${elapsedMs.toFixed(1)} ms`
    ];
    if (itemCount)
      parts.push(`requestItems=${itemCount}`);
    if (tableCount)
      parts.push(`tables=${tableCount}`);
    console.info(parts.join(' '));
  });

  next();
}

async function initDatabase() {
  await resetLegacyIntegerSchema();
  await runStatements(db, schemaSql);
  await setupChangeTracking(db, db.tables);
  await seedIfEmpty();
}

async function resetLegacyIntegerSchema() {
  const columns = await db.query(`
    select data_type
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'team'
      and column_name = 'id'
  `);
  if (!columns.length || columns[0].data_type === 'uuid')
    return;

  console.warn(`Resetting demo database because team.id is ${columns[0].data_type}, expected uuid.`);
  await runStatements(db, `
    drop table if exists orange_changes cascade;
    drop table if exists orange_sync_applied_mutations cascade;
    drop table if exists task cascade;
    drop table if exists project_detail cascade;
    drop table if exists project cascade;
    drop table if exists person cascade;
    drop table if exists team cascade;
  `);
}

async function seedIfEmpty() {
  const rows = await db.query('select count(*)::int as count from team');
  if (Number(rows[0]?.count || 0) > 0)
    return;

  const ids = {
    platform: '11111111-1111-4111-8111-111111111111',
    product: '22222222-2222-4222-8222-222222222222',
    ada: '33333333-3333-4333-8333-333333333333',
    grace: '44444444-4444-4444-8444-444444444444',
    syncProject: '55555555-5555-4555-8555-555555555555',
    syncProjectDetail: '66666666-6666-4666-8666-666666666666',
    syncTaskCapture: '77777777-7777-4777-8777-777777777777',
    syncTaskReplay: '88888888-8888-4888-8888-888888888888',
    opfsProject: '99999999-9999-4999-8999-999999999999',
    opfsProjectDetail: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    opfsTaskVerify: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  };

  const platform = await db.team.insert({ id: ids.platform, name: 'Platform' });
  const product = await db.team.insert({ id: ids.product, name: 'Product' });
  const ada = await db.person.insert({ id: ids.ada, teamId: platform.id, name: 'Ada Lovelace', email: 'ada@example.test' });
  const grace = await db.person.insert({ id: ids.grace, teamId: product.id, name: 'Grace Hopper', email: 'grace@example.test' });

  await db.project.insert({
    id: ids.syncProject,
    ownerId: ada.id,
    title: 'Offline sync rollout',
    status: 'active',
    updatedAt: new Date(),
    detail: {
      id: ids.syncProjectDetail,
      projectId: ids.syncProject,
      summary: 'Exercise push, pull, references, hasOne and hasMany relations.',
      riskLevel: 'medium'
    },
    tasks: [
      { id: ids.syncTaskCapture, projectId: ids.syncProject, assigneeId: ada.id, title: 'Capture local patches', done: true, sortOrder: 1 },
      { id: ids.syncTaskReplay, projectId: ids.syncProject, assigneeId: grace.id, title: 'Replay mutations on server', done: false, sortOrder: 2 }
    ]
  });

  await db.project.insert({
    id: ids.opfsProject,
    ownerId: grace.id,
    title: 'OPFS browser client',
    status: 'planning',
    updatedAt: new Date(),
    detail: {
      id: ids.opfsProjectDetail,
      projectId: ids.opfsProject,
      summary: 'Use sqliteOPFS as the local durable browser database.',
      riskLevel: 'low'
    },
    tasks: [
      { id: ids.opfsTaskVerify, projectId: ids.opfsProject, assigneeId: grace.id, title: 'Verify worker-backed SQLite', done: false, sortOrder: 1 }
    ]
  });
}

async function seedBigServerDatabase(options) {
  const startedAt = performance.now();
  await runStatements(db, `
    truncate table task, project_detail, project, person, team restart identity cascade;
    delete from orange_changes;
    delete from orange_sync_applied_mutations;
  `);

  const { projectCount, tasksPerProject, profile, summaryBytes } = options;
  const teamCount = Math.min(100, Math.max(20, Math.ceil(projectCount / 1000)));
  const personCount = Math.min(5000, Math.max(200, Math.ceil(projectCount / 25)));
  await insertValues('team', ['id', 'name'], Array.from({ length: teamCount }, (_, index) => [
    bigId('team', index),
    `Big team ${index + 1}`
  ]));
  await insertValues('person', ['id', 'teamId', 'name', 'email'], Array.from({ length: personCount }, (_, index) => [
    bigId('person', index),
    bigId('team', index % teamCount),
    `Big person ${index + 1}`,
    `big.person.${index + 1}@example.test`
  ]));

  for (let offset = 0; offset < projectCount; offset += 500) {
    const size = Math.min(500, projectCount - offset);
    await insertValues('project', ['id', 'ownerId', 'title', 'status', 'updatedAt'], Array.from({ length: size }, (_, localIndex) => {
      const index = offset + localIndex;
      return [
        bigId('project', index),
        bigId('person', index % personCount),
        `${profileLabel(profile)} project ${index + 1}`,
        index % 3 === 0 ? 'active' : index % 3 === 1 ? 'planning' : 'paused',
        new Date(Date.UTC(2026, 0, 1 + (index % 28), 9, index % 60, 0))
      ];
    }));
    await insertValues('project_detail', ['id', 'projectId', 'summary', 'riskLevel'], Array.from({ length: size }, (_, localIndex) => {
      const index = offset + localIndex;
      return [
        bigId('detail', index),
        bigId('project', index),
        makeSummary(index, summaryBytes),
        index % 4 === 0 ? 'high' : index % 4 === 1 ? 'medium' : 'low'
      ];
    }));
    const taskRows = [];
    for (let localIndex = 0; localIndex < size; localIndex++) {
      const projectIndex = offset + localIndex;
      for (let taskIndex = 0; taskIndex < tasksPerProject; taskIndex++) {
        taskRows.push([
          bigId('task', projectIndex * Math.max(1, tasksPerProject) + taskIndex),
          bigId('project', projectIndex),
          bigId('person', (projectIndex + taskIndex) % personCount),
          `${profileLabel(profile)} task ${taskIndex + 1} for project ${projectIndex + 1}`,
          taskIndex % 2 === 0,
          taskIndex + 1
        ]);
      }
    }
    await insertValues('task', ['id', 'projectId', 'assigneeId', 'title', 'done', 'sortOrder'], taskRows);
  }

  return {
    ok: true,
    profile,
    projects: projectCount,
    tasks: projectCount * tasksPerProject,
    people: personCount,
    teams: teamCount,
    summaryBytes,
    elapsedMs: Math.round(performance.now() - startedAt)
  };
}

function normalizeBigSeedOptions(input) {
  const profile = typeof input.profile === 'string' ? input.profile : 'many';
  const defaults = {
    many: { projectCount: 50000, tasksPerProject: 3, summaryBytes: 160 },
    wide: { projectCount: 10000, tasksPerProject: 2, summaryBytes: 8192 },
    mixed: { projectCount: 25000, tasksPerProject: 5, summaryBytes: 1024 }
  };
  const selected = defaults[profile] || defaults.many;
  return {
    profile: defaults[profile] ? profile : 'many',
    projectCount: clampInteger(input.projectCount, selected.projectCount, 1, 250000),
    tasksPerProject: clampInteger(input.tasksPerProject, selected.tasksPerProject, 0, 50),
    summaryBytes: clampInteger(input.summaryBytes, selected.summaryBytes, 0, 65536)
  };
}

async function insertValues(table, columns, rows) {
  if (rows.length === 0)
    return;
  const chunkSize = 500;
  const columnSql = columns.map(quoteIdent).join(',');
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const chunk = rows.slice(offset, offset + chunkSize);
    const parameters = [];
    const valuesSql = chunk
      .map((row) => {
        for (const value of row)
          parameters.push(value instanceof Date ? value.toISOString() : value);
        return `(${row.map(() => '?').join(',')})`;
      })
      .join(',');
    await db.query({
      sql: `insert into ${quoteIdent(table)} (${columnSql}) values ${valuesSql} on conflict do nothing`,
      parameters
    });
  }
}

function bigId(kind, index) {
  const prefixes = {
    team: '10000000',
    person: '20000000',
    project: '30000000',
    detail: '40000000',
    task: '50000000'
  };
  const prefix = prefixes[kind] || '90000000';
  const value = index.toString(16).padStart(12, '0');
  return `${prefix}-0000-4000-8000-${value}`;
}

function makeSummary(index, targetBytes) {
  const base = `Synthetic server-side summary for row ${index + 1}. `;
  if (targetBytes <= base.length)
    return base.slice(0, targetBytes);
  const filler = `payload-${String(index + 1).padStart(8, '0')}-`;
  let result = base;
  while (result.length < targetBytes)
    result += filler;
  return result.slice(0, targetBytes);
}

function profileLabel(profile) {
  return profile === 'wide' ? 'Wide' : profile === 'mixed' ? 'Mixed' : 'Many';
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed))
    return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

async function runStatements(targetDb, sql) {
  for (const statement of sql.split(';')) {
    if (statement.trim())
      await targetDb.query(statement);
  }
}
