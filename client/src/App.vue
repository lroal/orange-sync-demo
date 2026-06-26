<script setup>
import { computed, onMounted, reactive, ref, shallowRef } from 'vue';
import { bigMode, db, localDbName, rotateLocalDbNameForRecovery, syncOperationTimeoutMs, traceSyncOperation } from './db.js';
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
  await run('Recovering local sync schema', async () => {
    await resetAndBootstrapFromServer({
      resetLabel: 'schema recovery local reset',
      syncLabel: 'schema recovery bootstrap sync'
    });
    localSchemaResetAttempted = false;
  });
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

async function syncNow() {
  await run('Syncing changes', async () => {
    await syncWithTiming('manual sync');
    lastSync.value = new Date();
    await refreshLocal();
  });
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

async function seedBigServerDatabase() {
  await run(`Seeding ${serverBigProfile.value} server data and bootstrapping`, async () => {
    const response = await fetch(`${serverUrl}/api/seed-big-server`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: serverBigProfile.value })
    });
    if (!response.ok)
      throw new Error(`Server big seed failed with status ${response.status}`);
    const result = await response.json();
    console.info('[timing] seedBigServerDatabase', result);
    await resetAndBootstrapFromServer({
      resetLabel: 'seed server local reset',
      syncLabel: 'seeded server bootstrap sync'
    });
  });
}

function setServerBigProfile(profile) {
  serverBigProfile.value = profile;
}

async function bootstrapSyncFromServer() {
  await run('Bootstrapping local database from existing server data', async () => {
    await resetAndBootstrapFromServer({
      resetLabel: 'bootstrap local reset',
      syncLabel: 'bootstrap sync'
    });
  });
}

async function resetAndBootstrapFromServer({ resetLabel, syncLabel }) {
  await stopSyncClient();
  await syncOperation(resetLabel, () => db.syncClient.resetLocal({ force: true }));
  clearLocalView();
  await syncWithTiming(syncLabel);
  lastSync.value = new Date();
  await refreshLocal();
  await db.syncClient.start();
}

async function resetLocalDatabase() {
  await run('Resetting local database only', async () => {
    await stopSyncClient();
    await syncOperation('reset local database', () => db.syncClient.resetLocal({ force: true }));
    clearLocalView();
    lastSync.value = null;
    localSchemaResetAttempted = false;
  });
}

function clearLocalView() {
  projects.value = [];
  people.value = [];
  selectedProjectId.value = null;
  projectPage.value = 0;
  projectTotal.value = 0;
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




    lastSync.value = new Date();
    await syncWithTiming('server command sync');
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
    await syncWithTiming('server change sync');
  });
}

async function syncWithTiming(label) {
  const startedAt = performance.now();
  try {
    return await syncOperation(label, () => db.syncClient.sync({ timeoutMs: syncOperationTimeoutMs }));
  }
  finally {
    console.info(`[timing] ${label} took ${(performance.now() - startedAt).toFixed(1)} ms`);
  }
}

async function syncOperation(label, fn) {
  return await withTimeout(traceSyncOperation(label, fn), syncOperationTimeoutMs, label);
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
        <p v-else>Waiting for first sync</p>
        <p>{{ localDbName }}</p>
      </section>

      <div class="actions">
        <button @click="syncNow" :disabled="busy"><span class="icon">R</span> Sync</button>
        <button @click="reloadLocal" :disabled="busy"><span class="icon">L</span> Refresh UI</button>
        <div v-if="bigMode" class="segmented">
          <button :class="{ active: serverBigProfile === 'many' }" @click="setServerBigProfile('many')" :disabled="busy">Many</button>
          <button :class="{ active: serverBigProfile === 'wide' }" @click="setServerBigProfile('wide')" :disabled="busy">Wide</button>
          <button :class="{ active: serverBigProfile === 'mixed' }" @click="setServerBigProfile('mixed')" :disabled="busy">Mixed</button>
        </div>
        <button v-if="bigMode" @click="seedBigServerDatabase" :disabled="busy"><span class="icon">B</span> Seed server + bootstrap sync</button>
        <button v-if="bigMode" @click="bootstrapSyncFromServer" :disabled="busy"><span class="icon">P</span> Bootstrap sync</button>
        <button @click="createServerChange" :disabled="busy"><span class="icon">S</span> Server edit</button>
        <button @click="resetLocalDatabase" :disabled="busy"><span class="icon">X</span> Reset local only</button>
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
