<script setup>
import { computed, onMounted, reactive, ref, shallowRef } from 'vue';
import { db } from './db.js';
import rdb from 'orange-orm';
db.reactive(reactive);

rdb.on('queryComplete', ({ sql, parameters, elapsedMs, workerElapsedMs, error }) => {
	const workerPart = typeof workerElapsedMs === 'number'
		? `, worker ${workerElapsedMs.toFixed(1)} ms`
		: '';
	console.info(`[sql] ${elapsedMs.toFixed(1)} ms${workerPart}${error ? ' failed' : ''}`, { sql, parameters });
});

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
const serverUrl = import.meta.env.VITE_SERVER_URL || 'http://localhost:3055';

const selectedProject = computed(() =>
  projects.value.find((project) => project.id === selectedProjectId.value) || projects.value[0]
);

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
    status.value = error.message || String(error);
  });
  await run('Starting auto sync', async () => {
    await db.syncClient.start();
  });
});

async function refreshLocal() {
	const startedAt = performance.now();
	try {
		const fetchStartedAt = performance.now();
		const [fetchedProjectRows, personRows] = await Promise.all([
			time('db.project.getAll with relations', () => db.project.getAll({
				owner: { team: {} },
				detail: {},
				tasks: { assignee: {}, orderBy: 'sortOrder' },
				orderBy: 'id'
			})),
			time('db.person.getAll with team', () => db.person.getAll({ team: {}, orderBy: 'name' }))
		]);
		console.info(`[timing] project/person Promise.all getAll took ${(performance.now() - fetchStartedAt).toFixed(1)} ms`);

    const viewStartedAt = performance.now();
    projects.value = fetchedProjectRows;
    people.value = personRows;
    if (!selectedProjectId.value && projects.value.length > 0)
      selectedProjectId.value = projects.value[0].id;
    console.info(`[timing] refreshLocal view assignment took ${(performance.now() - viewStartedAt).toFixed(1)} ms`);
  }
  finally {
    const elapsedMs = performance.now() - startedAt;
    console.info(`[timing] refreshLocal took ${elapsedMs.toFixed(1)} ms`);
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

async function pull() {
	await run('Pulling server changes', async () => {
		await db.syncClient.pull();
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

async function createProject() {
  const owner = people.value[0];
  if (!owner)
    return;
  await run('Creating local project', async () => {
    const stamp = new Date().toLocaleTimeString();
    const project = await db.project.insert({
      ownerId: owner.id,
      title: `Local sync test ${stamp}`,
      status: 'draft',
      updatedAt: new Date(),
      detail: {
        summary: 'Created locally. Push sends the patch transaction to Postgres.',
        riskLevel: 'low'
      },
      tasks: [
        {
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

async function run(message, fn) {
  busy.value = true;
  status.value = message;
  try {
    await fn();
    status.value = 'Idle';
  }
  catch (e) {
    console.dir(e);
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
      </section>

      <div class="actions">
        <button @click="syncBoth" :disabled="busy"><span class="icon">R</span> Sync</button>
        <button @click="push" :disabled="busy"><span class="icon">U</span> Push</button>
        <button @click="pull" :disabled="busy"><span class="icon">D</span> Pull</button>
        <button @click="createServerChange" :disabled="busy"><span class="icon">S</span> Server edit</button>
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
            <button @click="flipStatus" :disabled="busy">Toggle status</button>
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
