<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef } from 'vue';
import { bigMode, db, localDbName, syncOperationTimeoutMs, traceSyncOperation } from './db.js';
import rdb from 'orange-orm';
db.reactive(reactive);

rdb.on('sqliteOpen', ({ connectionString, filename, requestedVfs, vfs, fallback, readonly }) => {
  console.info('[sqliteOPFS] open', {
    connectionString,
    filename,
    requestedVfs,
    vfs,
    fallback,
    readonly,
    localDbName
  });
});

const projectPage = ref(0);
const projectPageSize = ref(25);
const projectsStrategy = {
  owner: {
    team: {}
  },
  detail: {},
  tasks: {
    assignee: {}
  },
};

const personStrategy = {
  team: {}
};

type Projects = Awaited<ReturnType<typeof db.project.proxify>>;
const projects = shallowRef(db.project.proxify([], projectsStrategy) as unknown as Projects);
type People = Awaited<ReturnType<typeof db.person.proxify>>;
const people = shallowRef(db.person.proxify([], personStrategy) as unknown as People);
const selectedProjectId = ref(null);
const status = ref('Booting local database');
const busy = ref(false);
const lastSync = ref(null);
const newTaskTitle = ref('');
const serverUrl = 'http://localhost:8080';
const projectTotal = ref(0);
const serverBigProfile = ref(import.meta.env.VITE_BIG_SERVER_PROFILE || 'many');
let localSchemaResetAttempted = false;
let mounted = false;
let autoSyncStarted = false;

const selectedProject = computed(() =>
  projects.value.find((project) => project.id === selectedProjectId.value) || projects.value[0]
);
const projectPageCount = computed(() => Math.max(1, Math.ceil(projectTotal.value / projectPageSize.value)));
const projectPageStart = computed(() => projectTotal.value === 0 ? 0 : projectPage.value * projectPageSize.value + 1);
const projectPageEnd = computed(() => Math.min(projectTotal.value, (projectPage.value + 1) * projectPageSize.value));

onMounted(() => {
  mounted = true;
  db.syncClient.on('sync', async () => {
    lastSync.value = new Date();
    await refreshLocal();
  });
  db.syncClient.on('error', ({ error }) => {
    void handleSyncError(error);
  });
  status.value = 'Preparing local database';
  busy.value = true;
  void prepareLocalDatabaseAndStartSync();
});

onBeforeUnmount(() => {
  mounted = false;
  void stopSyncClient();
});

async function refreshLocal() {
  const { total, missingLocalSchema } = await readProjectTotal();
  if (missingLocalSchema) {
    clearLocalView();
    return;
  }

  projectTotal.value = total;
  const maxPage = Math.max(0, Math.ceil(total / projectPageSize.value) - 1);
  if (projectPage.value > maxPage)
    projectPage.value = maxPage;
  const [fetchedProjectRows, personRows] = await Promise.all([
    db.project.getMany({
      ...projectsStrategy,
      tasks: { ...projectsStrategy.tasks, orderBy: 'sortOrder' },
      orderBy: 'id',
      limit: projectPageSize.value,
      offset: projectPage.value * projectPageSize.value
    }),
    db.person.getMany({ ...personStrategy, orderBy: 'name' })
  ]);

  projects.value = fetchedProjectRows;
  people.value = personRows;
  if (!projects.value.some((project) => project.id === selectedProjectId.value))
    selectedProjectId.value = null;
  if (!selectedProjectId.value && projects.value.length > 0)
    selectedProjectId.value = projects.value[0].id;
}

async function readProjectTotal() {
  try {
    const total = await db.project.count();
    console.info('[local-db] project count', { total, localDbName });
    return { total, missingLocalSchema: false };
  }
  catch (e) {
    if (/no such table/u.test(e && e.message || String(e))) {
      console.info('[local-db] project table missing', { localDbName, error: e && e.message || String(e) });
      return { total: 0, missingLocalSchema: true };
    }
    throw e;
  }
}

async function prepareLocalDatabaseAndStartSync() {
  try {
    if (typeof db.syncClient.ensureLocalSchema === 'function') {
      await syncOperation('prepare local schema', () =>
        db.syncClient.ensureLocalSchema({ timeoutMs: syncOperationTimeoutMs })
      );
    }
    if (!mounted)
      return;
    status.value = 'Starting sync';
  }
  catch (e) {
    if (mounted)
      await handleSyncError(e);
    return;
  }
  finally {
    if (mounted)
      busy.value = false;
  }
  if (mounted)
    void startSyncClient('auto sync start');
}

async function handleSyncError(error) {
  if (await recoverLocalSyncSchemaMismatch(error))
    return;
  if (await recoverLocalSqliteCorruption(error))
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

async function recoverLocalSqliteCorruption(error) {
  if (!isLocalSqliteCorruption(error))
    return false;

  status.value = 'Local SQLite database is corrupt. Recreating local database.';
  try {
    await stopSyncClient();
    if (db && typeof db.close === 'function')
      await db.close();
    await deleteLocalOpfsDatabase(localDbName);
    setTimeout(() => window.location.reload(), 250);
  }
  catch (e) {
    console.error('[local-db] failed to delete corrupt SQLite database', {
      localDbName,
      error: e
    });
    status.value = 'Local SQLite database is corrupt. Clear site data for this origin, then reload.';
  }
  return true;
}

function isLocalSqliteCorruption(error) {
  return /SQLITE_CORRUPT|database disk image is malformed/u.test(error && error.message || String(error));
}

async function deleteLocalOpfsDatabase(name) {
  if (!globalThis.navigator || !navigator.storage || typeof navigator.storage.getDirectory !== 'function')
    throw new Error('OPFS is not available.');
  const root = await navigator.storage.getDirectory();
  await removeOpfsEntry(root, '.opfs-sahpool', { recursive: true });
  const names = [
    name,
    `${name}-journal`,
    `${name}-wal`,
    `${name}-shm`
  ];
  for (const entryName of names) {
    await removeOpfsEntry(root, entryName);
  }
}

async function removeOpfsEntry(root, name, options) {
  try {
    await root.removeEntry(name, options);
  }
  catch (e) {
    const errorName = e && typeof e === 'object' && 'name' in e ? e.name : undefined;
    if (errorName !== 'NotFoundError')
      throw e;
  }
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
    await response.json();
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
  await startSyncClient('post-bootstrap sync start');
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
  projects.value.splice(0, projects.value.length);
  people.value.splice(0, people.value.length);
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
  try {
    await run('Saving local task change', async () => {
      task.done = !task.done;
      await projects.value.saveChanges({});
    });
  }
  catch (e) {
    status.value = e.message || String(e);
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

async function startSyncClient(label) {
  if (autoSyncStarted)
    return;
  autoSyncStarted = true;
  try {
    await withTimeout(db.syncClient.start(), Math.min(syncOperationTimeoutMs, 15000), label);
    if (mounted)
      status.value = 'Idle';
  }
  catch (e) {
    autoSyncStarted = false;
    if (mounted)
      await handleSyncError(e);
  }
}

async function stopSyncClient() {
  autoSyncStarted = false;
  if (typeof db.syncClient.stop === 'function')
    await db.syncClient.stop();
}

function withTimeout(promise, timeoutMs, label) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} did not finish within ${Math.round(timeoutMs / 1000)} seconds.`));
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
    if (await recoverLocalSyncSchemaMismatch(e))
      return;
    if (await recoverLocalSqliteCorruption(e))
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
          <button :class="{ active: serverBigProfile === 'many' }" @click="setServerBigProfile('many')"
            :disabled="busy">Many</button>
          <button :class="{ active: serverBigProfile === 'wide' }" @click="setServerBigProfile('wide')"
            :disabled="busy">Wide</button>
          <button :class="{ active: serverBigProfile === 'mixed' }" @click="setServerBigProfile('mixed')"
            :disabled="busy">Mixed</button>
        </div>
        <button v-if="bigMode" @click="seedBigServerDatabase" :disabled="busy"><span class="icon">B</span> Seed server +
          bootstrap sync</button>
        <button v-if="bigMode" @click="bootstrapSyncFromServer" :disabled="busy"><span class="icon">P</span> Bootstrap
          sync</button>
        <button @click="resetLocalDatabase" :disabled="busy"><span class="icon">X</span> Reset local only</button>
      </div>
    </aside>

    <section class="content">
      <header class="toolbar">
        <div>
          <p class="eyebrow">Projects</p>
          <h2>Two-way sync workspace</h2>
        </div>
        <button class="primary" @click="createProject" :disabled="busy"><span class="icon">+</span> New local
          project</button>
      </header>

      <div class="grid">
        <nav class="project-list">
          <div class="pager">
            <button @click="previousProjectPage" :disabled="busy || projectPage === 0">Prev</button>
            <span>{{ projectPageStart }}-{{ projectPageEnd }} / {{ projectTotal }}</span>
            <button @click="nextProjectPage" :disabled="busy || projectPage + 1 >= projectPageCount">Next</button>
          </div>

          <button v-for="project in projects" :key="project.id" :class="{ active: selectedProject?.id === project.id }"
            @click="selectedProjectId = project.id">
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

            <button v-for="task in selectedProject.tasks || []" :key="task.id" class="task" @click="toggleTask(task)">
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
