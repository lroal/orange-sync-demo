import rdb from 'orange-orm';
import { createDemoMap, demoCommands } from '../../shared/schema.js';

const syncUrl = import.meta.env.VITE_SYNC_URL || '/rdb';
const localDbNameOverrideKey = 'orange-sync-demo.localDbNameOverride';
const configuredLocalDbName = import.meta.env.VITE_SQLITE_DB_NAME || 'orange-sync-demo_vfs2.sqlite3';
export const localDbName = readLocalDbNameOverride() || configuredLocalDbName;
export const bigMode = import.meta.env.VITE_BIG_MODE === '1' || localDbName.includes('big');
export const syncOperationTimeoutMs = parsePositiveInteger(import.meta.env.VITE_SYNC_OPERATION_TIMEOUT_MS, 300000);
const map = createDemoMap(rdb);
const dbWorker = createDbWorker();
if (dbWorker && typeof dbWorker.addEventListener === 'function') {
  dbWorker.addEventListener('message', (event) => {
    const message = event && event.data;
    if (!message || message.type !== 'orange-demo-diagnostic')
      return;
    console.info('[db-worker]', message.event, message.payload);
  });
}
const dbWorkerClient = rdb.createDbWorkerClient(dbWorker);

if (typeof globalThis.addEventListener === 'function')
  globalThis.addEventListener('pagehide', () => dbWorkerClient.close(), { once: true });

export function rotateLocalDbNameForRecovery() {
  if (typeof localStorage === 'undefined')
    return null;

  const nextName = addRecoverySuffix(configuredLocalDbName);
  localStorage.setItem(localDbNameOverrideKey, nextName);
  return nextName;
}

export async function traceSyncOperation(labelOrFn, maybeFn) {
  const fn = typeof labelOrFn === 'function' ? labelOrFn : maybeFn;
  return await fn();
}

function readLocalDbNameOverride() {
  if (typeof localStorage === 'undefined')
    return null;
  return localStorage.getItem(localDbNameOverrideKey);
}

function addRecoverySuffix(dbName) {
  const suffix = '-recovered-' + Date.now();
  return String(dbName).replace(/(\.sqlite3)?$/u, suffix + '$1');
}

export const db = map({
  db: dbWorkerClient,
  commands: demoCommands
});

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function createDbWorker() {
  const workerUrl = new URL('./db.worker.js', import.meta.url);
  workerUrl.searchParams.set('db', localDbName);
  workerUrl.searchParams.set('syncUrl', syncUrl);
  workerUrl.searchParams.set('busyTimeoutMs', '5000');
  return new Worker(workerUrl, {
    type: 'module',
    name: 'orange-sync-demo:' + localDbName + ':opfs-db-worker'
  });
}
