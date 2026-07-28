<script setup lang="ts">
import rdb from 'orange-orm';
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef } from 'vue';
import { bigMode, db, localDbName, syncOperationTimeoutMs } from './db.js';
import {
  sqlDiagnosticsEnabled,
  sqlDiagnosticsSlowMs,
  syncDiagnosticsEnabled,
  syncPullApplyMaxRowsPerTransaction,
  syncPullApplyYieldMs,
  syncPullMaxConcurrentRowRequests,
  syncPullMaxKeysPerBatch,
  syncPullMaxRowsPerBatch
} from './dbConfig.js';
db.reactive(reactive);

type ActiveOperation = {
  id: number;
  key: string;
  message: string;
};

type SyncPhase = 'keys' | 'rows' | 'push' | 'unknown';

type SyncDiagnosticsRequest = {
  id: number;
  phase: SyncPhase;
  itemCount: number;
  startedAt: number;
};

type SyncDiagnosticsSummary = {
  label: string;
  totalMs: number;
  networkWallMs: number;
  nonNetworkMs: number;
  maxActiveRows: number;
  keysRequests: number;
  rowsRequests: number;
  rowItems: number;
  keyItems: number;
};

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


const projects = shallowRef(db.project.proxify([], projectsStrategy));
const people = shallowRef(db.person.proxify([], personStrategy));
const selectedProjectId = ref(null);
const status = ref('Booting local database');
const activeOperations = ref<ActiveOperation[]>([]);
const lastSync = ref(null);
const lastBootstrapSyncMs = ref<number | null>(null);
const lastBootstrapDiagnostics = ref<SyncDiagnosticsSummary | null>(null);
const newTaskTitle = ref('');
const serverUrl = 'http://localhost:8080';
const projectTotal = ref(0);
const serverBigProfile = ref(import.meta.env.VITE_BIG_SERVER_PROFILE || 'many');
let stopSyncEventListeners = () => {};
let nextOperationId = 1;
let syncDiagnosticsRequestId = 1;
let currentSyncDiagnostics: ReturnType<typeof beginSyncDiagnostics> | null = null;

const selectedProject = computed(() =>
  projects.value.find((project) => project.id === selectedProjectId.value) || projects.value[0]
);
const projectPageCount = computed(() => Math.max(1, Math.ceil(projectTotal.value / projectPageSize.value)));
const projectPageStart = computed(() => projectTotal.value === 0 ? 0 : projectPage.value * projectPageSize.value + 1);
const projectPageEnd = computed(() => Math.min(projectTotal.value, (projectPage.value + 1) * projectPageSize.value));
const runningOperationCount = computed(() => activeOperations.value.length);

onMounted(() => {
  const stopDiagnostics = installSyncDiagnostics();
  const stopSqlDiagnostics = installLocalSqlDiagnostics();
  const offSync = db.syncClient.on('sync', (event) => {
    console.info('[sync-event] sync', event);
    void refreshAfterSync();
  });
  const offError = db.syncClient.on('error', (event) => {
    console.error('[sync-event] error', event);
    setErrorStatus(event && event.error || event);
  });
  stopSyncEventListeners = () => {
    stopSqlDiagnostics();
    stopDiagnostics();
    offSync();
    offError();
    stopSyncEventListeners = () => {};
  };
  void run('prepare-local', 'Preparing local database', async () => {
    await db.syncClient.ensureLocalSchema({ timeoutMs: syncOperationTimeoutMs });
    await refreshLocal();
  });
});

onBeforeUnmount(() => {
  stopSyncEventListeners();
  void stopSyncClient();
});

async function refreshAfterSync() {
  lastSync.value = new Date();
  try {
    await refreshLocal();
    setIdleStatus();
  }
  catch (e) {
    console.error('[sync-event] refresh failed', e);
    setErrorStatus(e);
  }
}

function setErrorStatus(error) {
  status.value = errorMessage(error);
}

function errorMessage(error) {
  return error && error.message || String(error);
}

function formatElapsed(ms: number | null) {
  if (ms === null)
    return '';
  if (ms < 1000)
    return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

async function refreshLocal() {
  const refreshStartedAt = performance.now();
  const countStartedAt = performance.now();
  const total = await readProjectTotal();
  const countMs = Math.round(performance.now() - countStartedAt);
  projectTotal.value = total;
  const maxPage = Math.max(0, Math.ceil(total / projectPageSize.value) - 1);
  if (projectPage.value > maxPage)
    projectPage.value = maxPage;
  const projectStartedAt = performance.now();
  const projectRowsPromise = db.project.getMany({
      ...projectsStrategy,
      tasks: { ...projectsStrategy.tasks, orderBy: 'sortOrder' },
      orderBy: 'id',
      limit: projectPageSize.value,
      offset: projectPage.value * projectPageSize.value
    }).then((rows) => ({
      rows,
      elapsedMs: Math.round(performance.now() - projectStartedAt)
    }));
  const peopleStartedAt = performance.now();
  const personRowsPromise = db.person.getMany({ ...personStrategy, orderBy: 'name' })
    .then((rows) => ({
      rows,
      elapsedMs: Math.round(performance.now() - peopleStartedAt)
    }));
  const [projectResult, peopleResult] = await Promise.all([
    projectRowsPromise,
    personRowsPromise
  ]);
  const fetchedProjectRows = projectResult.rows;
  const personRows = peopleResult.rows;

  projects.value = fetchedProjectRows;
  people.value = personRows;
  if (!projects.value.some((project) => project.id === selectedProjectId.value))
    selectedProjectId.value = null;
  if (!selectedProjectId.value && projects.value.length > 0)
    selectedProjectId.value = projects.value[0].id;
  console.info(
    '[ui-refresh]',
    `totalMs=${Math.round(performance.now() - refreshStartedAt)}`,
    `countMs=${countMs}`,
    `projectsMs=${projectResult.elapsedMs}`,
    `peopleMs=${peopleResult.elapsedMs}`,
    `projects=${fetchedProjectRows.length}`,
    `people=${personRows.length}`,
    `total=${total}`,
    `page=${projectPage.value + 1}/${projectPageCount.value}`
  );
}

async function readProjectTotal() {
  return await db.project.count();
}

async function syncNow() {
  await run('sync-now', 'Syncing changes', async () => {
    await db.syncClient.sync({ timeoutMs: syncOperationTimeoutMs });
  });
}

async function reloadLocal() {
  await run('reload-local', 'Refreshing local data', async () => {
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
  const profile = serverBigProfile.value;
  await run('seed-big-server', `Seeding ${profile} server data and bootstrapping`, async () => {
    const response = await fetch(`${serverUrl}/api/seed-big-server`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile })
    });
    if (!response.ok)
      throw new Error(`Server big seed failed with status ${response.status}`);
    await response.json();
    await resetAndBootstrapFromServer();
  });
}

function setServerBigProfile(profile) {
  serverBigProfile.value = profile;
}

async function bootstrapSyncFromServer() {
  await run('bootstrap-sync', 'Bootstrapping local database from existing server data', async () => {
    await resetAndBootstrapFromServer();
  });
}

async function resetAndBootstrapFromServer() {
  await stopSyncClient();
  await db.syncClient.resetLocal();
  clearLocalView();
  const diagnostics = beginSyncDiagnostics('bootstrap');
  const bootstrapStartedAt = performance.now();
  try {
    await startSyncClient();
  }
  finally {
    lastBootstrapSyncMs.value = Math.round(performance.now() - bootstrapStartedAt);
    const summary = diagnostics.finish(lastBootstrapSyncMs.value);
    lastBootstrapDiagnostics.value = summary;
    console.info('[bootstrap-sync]', `${lastBootstrapSyncMs.value}ms`, summary);
  }
}

async function resetLocalDatabase() {
  await run('reset-local', 'Resetting local database only', async () => {
    await stopSyncClient();
    await db.syncClient.resetLocal();
    clearLocalView();
    lastSync.value = null;
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
  await run('create-project', 'Creating local project', async () => {
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
  await run(taskToggleKey(task), 'Saving local task change', async () => {
    task.done = !task.done;
    await projects.value.saveChanges({});
  });
}

async function deleteTask(task) {
  await run(taskDeleteKey(task), 'Deleting local task', async () => {
    const project = selectedProject.value;
    const tasks = project?.tasks || [];
    const index = tasks.findIndex((row) => row.id === task.id);
    if (index === -1)
      return;
    tasks.splice(index, 1);
    await projects.value.saveChanges({});
  });
}

async function addTask() {
  const project = selectedProject.value;
  if (!project || !newTaskTitle.value.trim())
    return;
  await run('add-task', 'Adding local task', async () => {
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
  if (!p || !people.value[0])
    return;
  await run('server-commands', 'Running server commands', async () => {
    const stamp = new Date().toLocaleTimeString();
    await db.transaction(async (tx, ct) => {
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
      const pr = await tx.project.insert({
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
      ct.memory = pr;
      ct.context.row = pr;
      ct.context.operation = 'foo';
      ct.context.bar = {bar: 1};
    });
    db.syncClient.once('operation:foo', (e) => {
      console.dir('operation')
      console.dir(e);
    });
    lastSync.value = new Date();
    await db.syncClient.sync({ timeoutMs: syncOperationTimeoutMs });
  });
}

async function flipStatus() {
  const project = selectedProject.value;
  if (!project)
    return;
  await run('flip-status', 'Saving local project change', async () => {
    project.status = project.status === 'active' ? 'paused' : 'active';
    project.updatedAt = new Date();
    await projects.value.saveChanges({});
  });
}

async function startSyncClient() {
  await db.syncClient.sync({ timeoutMs: syncOperationTimeoutMs });
  setIdleStatus();
}

async function stopSyncClient() {
  await db.syncClient.stop();
}

function installSyncDiagnostics() {
  if (!syncDiagnosticsEnabled)
    return () => {};

  const requestId = db.syncClient.interceptors.request.use((config) => {
    const body = config?.data;
    const phase = syncPhase(body?.phase || body?.action);
    if (phase === 'unknown')
      return config;

    const request: SyncDiagnosticsRequest = {
      id: syncDiagnosticsRequestId++,
      phase,
      itemCount: Array.isArray(body?.items)
        ? body.items.length
        : Array.isArray(body?.mutations)
          ? body.mutations.length
          : 0,
      startedAt: performance.now()
    };

    config.__orangeSyncDiagnostics = request;
    currentSyncDiagnostics?.startRequest(request);
    return config;
  });

  const responseId = db.syncClient.interceptors.response.use(
    (response) => {
      finishDiagnosticsRequest(response?.config?.__orangeSyncDiagnostics, response?.data, false);
      return response;
    },
    (error) => {
      finishDiagnosticsRequest(error?.config?.__orangeSyncDiagnostics, undefined, true);
      throw error;
    }
  );

  return () => {
    db.syncClient.interceptors.request.eject(requestId);
    db.syncClient.interceptors.response.eject(responseId);
  };
}

function installLocalSqlDiagnostics() {
  if (!sqlDiagnosticsEnabled)
    return () => {};
  const onQueryComplete = (entry) => {
    if (!entry || Number(entry.elapsedMs || 0) < sqlDiagnosticsSlowMs)
      return;
    console.info(
      '[ui-sql]',
      `${Math.round(entry.elapsedMs)}ms`,
      entry.workerElapsedMs === undefined ? '' : `worker=${Math.round(entry.workerElapsedMs)}ms`,
      entry.lane || '',
      entry.connectionString || '',
      summarizeSql(entry.sql)
    );
  };
  rdb.on('queryComplete', onQueryComplete);
  return () => rdb.off('queryComplete', onQueryComplete);
}

function summarizeSql(sql) {
  return String(sql || '').replace(/\s+/g, ' ').trim().slice(0, 180);
}

function finishDiagnosticsRequest(request: SyncDiagnosticsRequest | undefined, payload, failed: boolean) {
  if (!request)
    return;
  currentSyncDiagnostics?.finishRequest(request, payload, failed);
}

function beginSyncDiagnostics(label: string) {
  const startedAt = performance.now();
  let activeRows = 0;
  let maxActiveRows = 0;
  let firstNetworkStartedAt: number | null = null;
  let lastNetworkEndedAt: number | null = null;
  let keysRequests = 0;
  let rowsRequests = 0;
  let keyItems = 0;
  let rowItems = 0;
  let finished = false;

  const diagnostics = {
    startRequest(request: SyncDiagnosticsRequest) {
      if (finished)
        return;
      if (firstNetworkStartedAt === null || request.startedAt < firstNetworkStartedAt)
        firstNetworkStartedAt = request.startedAt;
      if (request.phase === 'rows') {
        activeRows += 1;
        maxActiveRows = Math.max(maxActiveRows, activeRows);
      }
    },
    finishRequest(request: SyncDiagnosticsRequest, payload, failed: boolean) {
      if (finished)
        return;
      const endedAt = performance.now();
      lastNetworkEndedAt = Math.max(lastNetworkEndedAt || endedAt, endedAt);
      const elapsedMs = Math.round(endedAt - request.startedAt);
      const responseItems = Array.isArray(payload?.items) ? payload.items.length : 0;

      if (request.phase === 'keys') {
        keysRequests += 1;
        keyItems += responseItems;
      }
      else if (request.phase === 'rows') {
        rowsRequests += 1;
        rowItems += request.itemCount;
        activeRows = Math.max(0, activeRows - 1);
      }

      console.info(
        '[sync-request]',
        label,
        request.phase,
        failed ? 'failed' : 'ok',
        `${elapsedMs}ms`,
        `items=${request.itemCount}`,
        `returned=${responseItems}`,
        `activeRows=${activeRows}`,
        `maxActiveRows=${maxActiveRows}`
      );
    },
    finish(totalMs?: number): SyncDiagnosticsSummary {
      finished = true;
      if (currentSyncDiagnostics === diagnostics)
        currentSyncDiagnostics = null;
      const finalTotalMs = totalMs ?? Math.round(performance.now() - startedAt);
      const networkWallMs = firstNetworkStartedAt === null || lastNetworkEndedAt === null
        ? 0
        : Math.round(lastNetworkEndedAt - firstNetworkStartedAt);
      return {
        label,
        totalMs: finalTotalMs,
        networkWallMs,
        nonNetworkMs: Math.max(0, finalTotalMs - networkWallMs),
        maxActiveRows,
        keysRequests,
        rowsRequests,
        rowItems,
        keyItems
      };
    }
  };

  currentSyncDiagnostics = diagnostics;
  console.info('[sync-diagnostics]', label, {
    maxConcurrentRowRequests: formatConfigValue(syncPullMaxConcurrentRowRequests),
    maxKeysPerBatch: formatConfigValue(syncPullMaxKeysPerBatch),
    maxRowsPerBatch: formatConfigValue(syncPullMaxRowsPerBatch),
    apply: formatApplyConfig()
  });
  return diagnostics;
}

function syncPhase(value): SyncPhase {
  if (value === 'keys' || value === 'rows' || value === 'push')
    return value;
  return 'unknown';
}

function formatConfigValue(value: number | undefined) {
  return value || 'default';
}

function formatApplyConfig() {
  return syncPullApplyMaxRowsPerTransaction
    ? `${syncPullApplyMaxRowsPerTransaction} rows/tx · yield ${syncPullApplyYieldMs}ms`
    : 'single transaction';
}

function taskToggleKey(task) {
  return `toggle-task-${task.id}`;
}

function taskDeleteKey(task) {
  return `delete-task-${task.id}`;
}

function setIdleStatus() {
  if (activeOperations.value.length === 0)
    status.value = 'Idle';
}

function updateStatusFromActiveOperations() {
  const activeOperation = activeOperations.value[activeOperations.value.length - 1];
  if (activeOperation)
    status.value = activeOperation.message;
}

async function run(key, message, fn) {
  const id = nextOperationId++;
  const startedAt = performance.now();
  activeOperations.value = [...activeOperations.value, { id, key, message }];
  status.value = message;
  let failed = false;
  try {
    await fn();
  }
  catch (e) {
    failed = true;
    setErrorStatus(e);
  }
  finally {
    const elapsedMs = Math.round(performance.now() - startedAt);
    console.info('[operation]', key, failed ? 'failed' : 'completed', `${elapsedMs}ms`);
    activeOperations.value = activeOperations.value.filter((operation) => operation.id !== id);
    if (activeOperations.value.length > 0)
      updateStatusFromActiveOperations();
    else if (!failed)
      status.value = 'Idle';
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
        <p v-if="lastBootstrapSyncMs !== null">Last bootstrap {{ formatElapsed(lastBootstrapSyncMs) }}</p>
        <p v-if="lastBootstrapDiagnostics">
          rows max {{ lastBootstrapDiagnostics.maxActiveRows }} · rows req {{ lastBootstrapDiagnostics.rowsRequests }} · net {{ formatElapsed(lastBootstrapDiagnostics.networkWallMs) }} · other {{ formatElapsed(lastBootstrapDiagnostics.nonNetworkMs) }}
        </p>
        <p v-if="runningOperationCount">
          {{ runningOperationCount }} operation{{ runningOperationCount === 1 ? '' : 's' }} running
        </p>
        <p>{{ localDbName }}</p>
        <p v-if="bigMode">
          rows concurrency {{ formatConfigValue(syncPullMaxConcurrentRowRequests) }} · keys batch {{ formatConfigValue(syncPullMaxKeysPerBatch) }} · rows batch {{ formatConfigValue(syncPullMaxRowsPerBatch) }}
        </p>
        <p v-if="bigMode">
          apply {{ formatApplyConfig() }}
        </p>
      </section>

      <div class="actions">
        <button @click="syncNow">
          <span class="icon">R</span> Sync
        </button>
        <button @click="reloadLocal">
          <span class="icon">L</span> Refresh UI
        </button>
        <div v-if="bigMode" class="segmented">
          <button :class="{ active: serverBigProfile === 'many' }" @click="setServerBigProfile('many')">Many</button>
          <button :class="{ active: serverBigProfile === 'wide' }" @click="setServerBigProfile('wide')">Wide</button>
          <button :class="{ active: serverBigProfile === 'mixed' }" @click="setServerBigProfile('mixed')">Mixed</button>
        </div>
        <button v-if="bigMode" @click="seedBigServerDatabase">
          <span class="icon">B</span> Seed server + bootstrap sync
        </button>
        <button v-if="bigMode" @click="bootstrapSyncFromServer">
          <span class="icon">P</span> Bootstrap sync
        </button>
        <button @click="resetLocalDatabase">
          <span class="icon">X</span> Reset local only
        </button>
      </div>
    </aside>

    <section class="content">
      <header class="toolbar">
        <div>
          <p class="eyebrow">Projects</p>
          <h2>Two-way sync workspace</h2>
        </div>
        <button
          class="primary"
          @click="createProject"
        >
          <span class="icon">+</span> New local project
        </button>
      </header>

      <div class="grid">
        <nav class="project-list">
          <div class="pager">
            <button
              @click="previousProjectPage"
            >
              Prev
            </button>
            <span>{{ projectPageStart }}-{{ projectPageEnd }} / {{ projectTotal }}</span>
            <button
              @click="nextProjectPage"
            >
              Next
            </button>
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
              <button @click="flipStatus">
                Toggle status
              </button>
              <button
                @click="addServerTaskCommand"
              >
                Server commands
              </button>
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
              <button
                @click="addTask"
              >
                +
              </button>
            </div>

            <div
              v-for="task in selectedProject.tasks || []"
              :key="task.id"
              class="task"
            >
              <button class="task-toggle" @click="toggleTask(task)">
                <span class="check" :class="{ done: task.done }">✓</span>
                <span>
                  <strong>{{ task.title }}</strong>
                  <small>{{ task.assignee?.name || 'Unassigned' }}</small>
                </span>
              </button>
              <button class="danger icon-button" title="Delete row" aria-label="Delete row" @click="deleteTask(task)">
                X
              </button>
            </div>
          </section>
        </article>

        <article v-else class="empty">
          Pull from server to load demo data.
        </article>
      </div>
    </section>
  </main>
</template>
