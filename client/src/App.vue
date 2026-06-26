<script setup>
import { computed, onMounted, reactive, ref, shallowRef } from 'vue';
import { bigMode, db, localDbName, rotateLocalDbNameForRecovery, syncOperationTimeoutMs } from './db.js';
import rdb from 'orange-orm';
db.reactive(reactive);

// rdb.on('queryComplete', ({ sql, parameters, elapsedMs, workerElapsedMs, error }) => {
// 	const workerPart = typeof workerElapsedMs === 'number'
// 		? `, worker ${workerElapsedMs.toFixed(1)} ms`
// 		: '';
// 	console.info(`[sql] ${elapsedMs.toFixed(1)} ms${workerPart}${error ? ' failed' : ''}`, { sql, parameters });
// });

rdb.on('sqliteOpen', ({ connectionString, filename, requestedVfs, vfs, fallback, readonly }) => {
	const fallbackPart = fallback ? ', fallback' : '';
	const readonlyPart = readonly ? ', readonly' : '';
	console.info(`[sqliteOPFS] opened vfs=${vfs}, requested=${requestedVfs}${fallbackPart}${readonlyPart}`, {
		connectionString,
		filename
	});
});

const projects = shallowRef([]);
const people = shallowRef([]);
const selectedProjectId = ref(null);
const status = ref('Booting local database');
const busy = ref(false);
const lastSync = ref(null);
const newTaskTitle = ref('');
const serverUrl = import.meta.env.VITE_SERVER_URL || '';
const projectPage = ref(0);
const projectPageSize = ref(parsePositiveInteger(import.meta.env.VITE_PROJECT_PAGE_SIZE, 25));
const projectTotal = ref(0);
const bigProjectCount = parsePositiveInteger(import.meta.env.VITE_BIG_PROJECTS, 5000);
const bigTasksPerProject = parsePositiveInteger(import.meta.env.VITE_BIG_TASKS_PER_PROJECT, 3);
const serverBigProfile = ref(import.meta.env.VITE_BIG_SERVER_PROFILE || 'many');
let localSchemaResetAttempted = false;
const sqliteCorruptionRecoveryKey = 'orange-sync-demo.sqliteCorruptionRecoveryAttempted';

const selectedProject = computed(() =>
  projects.value.find((project) => project.id === selectedProjectId.value) || projects.value[0]
);
const projectPageCount = computed(() => Math.max(1, Math.ceil(projectTotal.value / projectPageSize.value)));
const projectPageStart = computed(() => projectTotal.value === 0 ? 0 : projectPage.value * projectPageSize.value + 1);
const projectPageEnd = computed(() => Math.min(projectTotal.value, (projectPage.value + 1) * projectPageSize.value));

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

onMounted(async () => {
  db.syncClient.on('pull', async () => {
    console.dir('on pull');
    lastSync.value = new Date();
    await refreshLocal();
  });
  db.syncClient.on('push', () => {
    lastSync.value = new Date();
  });
  db.syncClient.on('error', ({ error }) => {
    void handleSyncError(error);
  });
  await run('Starting auto sync', async () => {
    await db.syncClient.start();
    sessionStorage.removeItem(sqliteCorruptionRecoveryKey);
  });
});

async function refreshLocal() {
	const startedAt = performance.now();
	try {
		const fetchStartedAt = performance.now();
    const total = await readProjectTotal();
    projectTotal.value = total;
    const maxPage = Math.max(0, Math.ceil(total / projectPageSize.value) - 1);
    if (projectPage.value > maxPage)
      projectPage.value = maxPage;
		const [fetchedProjectRows, personRows] = await Promise.all([
			time('db.project.getAll with relations', () => db.project.getAll({
				owner: { team: {} },
				detail: {},
				tasks: { assignee: {}, orderBy: 'sortOrder' },
				orderBy: 'id',
        limit: projectPageSize.value,
        offset: projectPage.value * projectPageSize.value
			})),
			time('db.person.getAll with team', () => db.person.getAll({ team: {}, orderBy: 'name' }))
		]);
		console.info(`[timing] project/person Promise.all getAll took ${(performance.now() - fetchStartedAt).toFixed(1)} ms`);

    const viewStartedAt = performance.now();
    projects.value = fetchedProjectRows;
    people.value = personRows;
    if (!projects.value.some((project) => project.id === selectedProjectId.value))
      selectedProjectId.value = null;
    if (!selectedProjectId.value && projects.value.length > 0)
      selectedProjectId.value = projects.value[0].id;
    console.info(`[timing] refreshLocal view assignment took ${(performance.now() - viewStartedAt).toFixed(1)} ms`);
  }
  finally {
    const elapsedMs = performance.now() - startedAt;
    console.info(`[timing] refreshLocal took ${elapsedMs.toFixed(1)} ms`);
	}
}

async function readProjectTotal() {
  try {
    const rows = await db.query('SELECT COUNT(*) AS count FROM "project"');
    const row = Array.isArray(rows) ? rows[0] : rows?.rows?.[0];
    return Number(row?.count ?? row?.COUNT ?? 0);
  }
  catch (e) {
    if (/no such table/u.test(e && e.message || String(e)))
      return 0;
    throw e;
  }
}

async function time(label, fn) {
	const startedAt = performance.now();
	try {
		return await fn();
	}
	finally {
		console.info(`[timing] ${label} took ${(performance.now() - startedAt).toFixed(1)} ms`);
	}
}

async function handleSyncError(error) {
  if (await recoverLocalSyncSchemaMismatch(error))
    return;
  if (recoverLocalSqliteCorruption(error))
    return;
  status.value = error.message || String(error);
}

async function recoverLocalSyncSchemaMismatch(error) {
  if (!isLocalSyncSchemaMismatch(error) || localSchemaResetAttempted)
    return false;
  localSchemaResetAttempted = true;
  await resetLocalDatabase();
  return true;
}

function isLocalSyncSchemaMismatch(error) {
  return /Local sync schema does not match current map/u.test(error && error.message || String(error));
}

function recoverLocalSqliteCorruption(error) {
  if (!isLocalSqliteCorruption(error))
    return false;

  if (sessionStorage.getItem(sqliteCorruptionRecoveryKey)) {
    status.value = 'Local SQLite database is corrupt. Clear site data for this origin, then reload.';
    return true;
  }

  const nextDbName = rotateLocalDbNameForRecovery();
  if (!nextDbName) {
    status.value = 'Local SQLite database is corrupt. Clear site data for this origin, then reload.';
    return true;
  }

  sessionStorage.setItem(sqliteCorruptionRecoveryKey, '1');
  status.value = 'Local SQLite database is corrupt. Switching to ' + nextDbName + ' and reloading.';
  setTimeout(() => window.location.reload(), 250);
  return true;
}

function isLocalSqliteCorruption(error) {
  return /SQLITE_CORRUPT|database disk image is malformed/u.test(error && error.message || String(error));
}

async function pull() {
	await run('Pulling server changes', async () => {
		await pullWithTiming('manual pull');
  });
}

async function push() {
  await run('Pushing local changes', async () => {
    await db.syncClient.push();
    lastSync.value = new Date();
    await refreshLocal();
  });
}

async function syncBoth() {
  await push();
  await pull();
}

async function reloadLocal() {
  await run('Refreshing local data', async () => {
    await refreshLocal();
  });
}

async function previousProjectPage() {
  if (projectPage.value === 0)
    return;
  projectPage.value -= 1;
  await reloadLocal();
}

async function nextProjectPage() {
  if (projectPage.value + 1 >= projectPageCount.value)
    return;
  projectPage.value += 1;
  await reloadLocal();
}

async function seedBigLocalDatabase() {
  await run(`Seeding ${bigProjectCount.toLocaleString()} local projects`, async () => {
    await stopSyncClient();
    await syncOperation('seed local reset', () => db.syncClient.resetLocal({ force: true }));
    projects.value = [];
    people.value = [];
    selectedProjectId.value = null;
    projectPage.value = 0;
    await pullWithTiming('seed local schema pull');
    await seedBigRows(bigProjectCount, bigTasksPerProject);
    await pullWithTiming('seed local base pull');
    lastSync.value = new Date();
    await refreshLocal();
    await db.syncClient.start();
  });
}

async function seedBigServerDatabase() {
  await run(`Seeding ${serverBigProfile.value} server data`, async () => {
    const response = await fetch(`${serverUrl}/api/seed-big-server`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: serverBigProfile.value })
    });
    if (!response.ok)
      throw new Error(`Server big seed failed with status ${response.status}`);
    const result = await response.json();
    console.info('[timing] seedBigServerDatabase', result);
    await stopSyncClient();
    await syncOperation('seed server reset', () => db.syncClient.resetLocal({ force: true }));
    projects.value = [];
    people.value = [];
    selectedProjectId.value = null;
    projectPage.value = 0;
    await pullWithTiming('seed server pull');
    lastSync.value = new Date();
    await refreshLocal();
    await db.syncClient.start();
  });
}

function setServerBigProfile(profile) {
  serverBigProfile.value = profile;
}

async function seedBigRows(projectCount, tasksPerProject) {
  const startedAt = performance.now();
  const teamCount = 20;
  const personCount = 200;
  await db.query('PRAGMA foreign_keys = ON');
  await db.query('BEGIN');
  try {
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
          `Big project ${index + 1}`,
          index % 3 === 0 ? 'active' : index % 3 === 1 ? 'planning' : 'paused',
          new Date(2026, 0, 1 + (index % 28), 9, index % 60, 0).toISOString()
        ];
      }));
      await insertValues('project_detail', ['id', 'projectId', 'summary', 'riskLevel'], Array.from({ length: size }, (_, localIndex) => {
        const index = offset + localIndex;
        return [
          bigId('detail', index),
          bigId('project', index),
          `Synthetic project detail for performance testing row ${index + 1}.`,
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
            `Big task ${taskIndex + 1} for project ${projectIndex + 1}`,
            taskIndex % 2 === 0 ? 0 : 1,
            taskIndex + 1
          ]);
        }
      }
      await insertValues('task', ['id', 'projectId', 'assigneeId', 'title', 'done', 'sortOrder'], taskRows);
    }
    await db.query('COMMIT');
  }
  catch (e) {
    await db.query('ROLLBACK');
    throw e;
  }
  console.info(`[timing] seedBigRows inserted ${projectCount} projects and ${projectCount * tasksPerProject} tasks in ${(performance.now() - startedAt).toFixed(1)} ms`);
}

async function insertValues(table, columns, rows) {
  if (rows.length === 0)
    return;
  const chunkSize = 250;
  const columnSql = columns.map(quoteIdent).join(',');
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const chunk = rows.slice(offset, offset + chunkSize);
    const valuesSql = chunk
      .map((row) => `(${row.map(sqlValue).join(',')})`)
      .join(',');
    await db.query(`INSERT OR REPLACE INTO ${quoteIdent(table)} (${columnSql}) VALUES ${valuesSql}`);
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

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function sqlValue(value) {
  if (value === null || value === undefined)
    return 'NULL';
  if (typeof value === 'number')
    return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean')
    return value ? '1' : '0';
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function resetLocalDatabase() {
  await run('Resetting local database', async () => {
    await stopSyncClient();
    await syncOperation('reset local database', () => db.syncClient.resetLocal({ force: true }));
    projects.value = [];
    people.value = [];
    selectedProjectId.value = null;
    await pullWithTiming('reset local pull');
    lastSync.value = new Date();
    await refreshLocal();
    await db.syncClient.start();
    localSchemaResetAttempted = false;
  });
}

async function createProject() {
  const owner = people.value[0];
  if (!owner)
    return;
  await run('Creating local project', async () => {
    const stamp = new Date().toLocaleTimeString();
    const projectId = crypto.randomUUID();
    const project = await db.project.insert({
      id: projectId,
      ownerId: owner.id,
      title: `Local sync test ${stamp}`,
      status: 'draft',
      updatedAt: new Date(),
      detail: {
        id: crypto.randomUUID(),
        projectId,
        summary: 'Created locally. Push sends the patch transaction to Postgres.',
        riskLevel: 'low'
      },
      tasks: [
        {
          id: crypto.randomUUID(),
          projectId,
          assigneeId: owner.id,
          title: 'Push this local task',
          done: false,
          sortOrder: 1
        }
      ]
    });
    selectedProjectId.value = project.id;
    await refreshLocal();
  });
}

async function toggleTask(task) {
  const startedAt = performance.now();
  try {
    await run('Saving local task change', async () => {
      const mutateStartedAt = performance.now();
      task.done = !task.done;
      console.info(`[timing] toggleTask mutate row took ${(performance.now() - mutateStartedAt).toFixed(1)} ms`);

      const saveStartedAt = performance.now();
      await projects.value.saveChanges({});
      console.info(`[timing] toggleTask saveChanges took ${(performance.now() - saveStartedAt).toFixed(1)} ms`);

      // const row = await db.task.getById(task.id);
      // row.done = !row.done;
      // await row.saveChanges();
      // await refreshLocal();
    });
  }
  catch(e) {
    console.dir(e);
  }
  finally {
    const elapsedMs = performance.now() - startedAt;
    console.log(`[timing] toggleTask took ${elapsedMs.toFixed(1)} ms`);
  }
}

async function addTask() {
  const project = selectedProject.value;
  if (!project || !newTaskTitle.value.trim())
    return;
  await run('Adding local task', async () => {
    await db.task.insert({
      id: crypto.randomUUID(),
      projectId: project.id,
      assigneeId: project.ownerId,
      title: newTaskTitle.value.trim(),
      done: false,
      sortOrder: (project.tasks || []).length + 1
    });
    newTaskTitle.value = '';
    await refreshLocal();
  });
}

async function addServerTaskCommand() {
  const p = selectedProject.value;
  if (!p)
    return;
  await run('Running server commands', async () => {
    const stamp = new Date().toLocaleTimeString();
    await db.transaction(async (tx) => {
      await tx.commands.addServerTask({
        projectId: p.id,
        title: `Server command A ${stamp}`
      });
      await tx.commands.addServerTask({
        projectId: p.id,
        title: `Server command B ${stamp}`
      });
    
    const projectId = crypto.randomUUID();
    const owner = people.value[0];
    await tx.project.insert({
      id: projectId,
      ownerId: owner.id,
      title: `Local sync test ${stamp}`,
      status: 'draft',
      updatedAt: new Date(),
      detail: {
        id: crypto.randomUUID(),
        projectId,
        summary: 'Created locally. Push sends the patch transaction to Postgres.',
        riskLevel: 'low'
      },
      tasks: [
        {
          id: crypto.randomUUID(),
          projectId,
          assigneeId: owner.id,
          title: 'Push this local task',
          done: false,
          sortOrder: 1
        }
      ]
    });



    });




    await db.syncClient.push();
    lastSync.value = new Date();
    await pullWithTiming('server command pull');
  });
}

async function flipStatus() {
  const project = selectedProject.value;
  if (!project)
    return;
  await run('Saving local project change', async () => {
    project.status = project.status === 'active' ? 'paused' : 'active';
    project.updatedAt = new Date();
    await projects.value.saveChanges({});
  });
}

async function createServerChange() {
  await run('Creating server-side change', async () => {
    await fetch(`${serverUrl}/api/seed-server-change`, { method: 'POST' });
    await pull();
  });
}

async function pullWithTiming(label) {
  const startedAt = performance.now();
  try {
    return await syncOperation(label, () => db.syncClient.pull({ timeoutMs: syncOperationTimeoutMs }));
  }
  finally {
    console.info(`[timing] ${label} took ${(performance.now() - startedAt).toFixed(1)} ms`);
  }
}

async function syncOperation(label, fn) {
  return await withTimeout(fn(), syncOperationTimeoutMs, label);
}

async function stopSyncClient() {
  if (typeof db.syncClient.stop === 'function')
    await db.syncClient.stop();
}

function withTimeout(promise, timeoutMs, label) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} did not finish within ${Math.round(timeoutMs / 1000)} seconds. Check the browser console for the last [sync-fetch] or [sync-sqlite] line; sqliteOPFS may be blocked by a stuck worker/tab.`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout])
    .finally(() => clearTimeout(timeoutId));
}

async function run(message, fn) {
  busy.value = true;
  status.value = message;
  try {
    await fn();
    status.value = 'Idle';
  }
  catch (e) {
    console.dir(e);
    if (await recoverLocalSyncSchemaMismatch(e))
      return;
    if (recoverLocalSqliteCorruption(e))
      return;
    status.value = e.message || String(e);
  }
  finally {
    busy.value = false;
  }
}
</script>

<template>
  <main class="shell">
    <aside class="sidebar">
      <div class="brand">
        <span class="mark">OS</span>
        <div>
          <h1>Orange Sync</h1>
          <p>Vue + sqliteOPFS + Postgres</p>
        </div>
      </div>

      <section class="status-panel">
        <div class="status-line">
          <span class="icon">~</span>
          <span>{{ status }}</span>
        </div>
        <p v-if="lastSync">Last sync {{ lastSync.toLocaleTimeString() }}</p>
        <p v-else>Waiting for first pull</p>
        <p>{{ localDbName }}</p>
      </section>

      <div class="actions">
        <button @click="syncBoth" :disabled="busy"><span class="icon">R</span> Sync</button>
        <button @click="push" :disabled="busy"><span class="icon">U</span> Push</button>
        <button @click="pull" :disabled="busy"><span class="icon">D</span> Pull</button>
        <button @click="reloadLocal" :disabled="busy"><span class="icon">L</span> Refresh UI</button>
        <button v-if="bigMode" @click="seedBigLocalDatabase" :disabled="busy"><span class="icon">B</span> Seed local big DB</button>
        <div v-if="bigMode" class="segmented">
          <button :class="{ active: serverBigProfile === 'many' }" @click="setServerBigProfile('many')" :disabled="busy">Many</button>
          <button :class="{ active: serverBigProfile === 'wide' }" @click="setServerBigProfile('wide')" :disabled="busy">Wide</button>
          <button :class="{ active: serverBigProfile === 'mixed' }" @click="setServerBigProfile('mixed')" :disabled="busy">Mixed</button>
        </div>
        <button v-if="bigMode" @click="seedBigServerDatabase" :disabled="busy"><span class="icon">P</span> Seed server + pull</button>
        <button @click="createServerChange" :disabled="busy"><span class="icon">S</span> Server edit</button>
        <button @click="resetLocalDatabase" :disabled="busy"><span class="icon">X</span> Reset local DB</button>
      </div>
    </aside>

    <section class="content">
      <header class="toolbar">
        <div>
          <p class="eyebrow">Projects</p>
          <h2>Two-way sync workspace</h2>
        </div>
        <button class="primary" @click="createProject" :disabled="busy"><span class="icon">+</span> New local project</button>
      </header>

      <div class="grid">
        <nav class="project-list">
          <div class="pager">
            <button @click="previousProjectPage" :disabled="busy || projectPage === 0">Prev</button>
            <span>{{ projectPageStart }}-{{ projectPageEnd }} / {{ projectTotal }}</span>
            <button @click="nextProjectPage" :disabled="busy || projectPage + 1 >= projectPageCount">Next</button>
          </div>

          <button
            v-for="project in projects"
            :key="project.id"
            :class="{ active: selectedProject?.id === project.id }"
            @click="selectedProjectId = project.id"
          >
            <strong>{{ project.title }}</strong>
            <span>{{ project.owner?.name || 'No owner' }} · {{ project.status }}</span>
          </button>
        </nav>

        <article v-if="selectedProject" class="detail">
          <div class="detail-head">
            <div>
              <p class="eyebrow">{{ selectedProject.owner?.team?.name || 'Team' }}</p>
              <h3>{{ selectedProject.title }}</h3>
            </div>
            <div class="detail-actions">
              <button @click="flipStatus" :disabled="busy">Toggle status</button>
              <button @click="addServerTaskCommand" :disabled="busy">Server commands</button>
            </div>
          </div>

          <dl class="facts">
            <div>
              <dt>Owner</dt>
              <dd>{{ selectedProject.owner?.name }}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{{ selectedProject.status }}</dd>
            </div>
            <div>
              <dt>Risk</dt>
              <dd>{{ selectedProject.detail?.riskLevel || 'none' }}</dd>
            </div>
          </dl>

          <p class="summary">{{ selectedProject.detail?.summary }}</p>

          <section class="tasks">
            <div class="task-input">
              <input v-model="newTaskTitle" placeholder="Add a local task" @keydown.enter="addTask" />
              <button @click="addTask" :disabled="busy || !newTaskTitle.trim()">+</button>
            </div>

            <button
              v-for="task in selectedProject.tasks || []"
              :key="task.id"
              class="task"
              @click="toggleTask(task)"
            >
              <span class="check" :class="{ done: task.done }">✓</span>
              <span>
                <strong>{{ task.title }}</strong>
                <small>{{ task.assignee?.name || 'Unassigned' }}</small>
              </span>
            </button>
          </section>
        </article>

        <article v-else class="empty">
          Pull from server to load demo data.
        </article>
      </div>
    </section>
  </main>
</template>
