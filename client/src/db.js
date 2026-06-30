import rdb from 'orange-orm';
import { createDemoMap, demoCommands } from '../../shared/schema.js';

const syncUrl = resolveDevServerUrl(import.meta.env.VITE_SYNC_URL || '/rdb', '/rdb');
const localDbNameOverrideKey = 'orange-sync-demo.localDbNameOverride';
const configuredLocalDbName = import.meta.env.VITE_SQLITE_DB_NAME || 'orange-sync-demo_vfs2.sqlite3';
export const localDbName = readLocalDbNameOverride() || configuredLocalDbName;
export const bigMode = import.meta.env.VITE_BIG_MODE === '1' || localDbName.includes('big');
export const syncOperationTimeoutMs = parsePositiveInteger(import.meta.env.VITE_SYNC_OPERATION_TIMEOUT_MS, 300000);
const map = createDemoMap(rdb);
const sharedDbWorker = createSharedDbWorker();
const sharedDbWorkerPort = sharedDbWorker && sharedDbWorker.port;
let dbWorker = null;
if (sharedDbWorkerPort && typeof sharedDbWorkerPort.addEventListener === 'function')
  sharedDbWorkerPort.addEventListener('message', handleSharedDbWorkerMessage);
const dbWorkerClient = rdb.createSharedDbWorkerClient(sharedDbWorker);

if (typeof globalThis.addEventListener === 'function') {
  globalThis.addEventListener('pagehide', () => {
    closeDbWorkers(sharedDbWorker, dbWorkerClient);
  }, { once: true });
}

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

function resolveDevServerUrl(value, path) {
  if (value && value !== path)
    return value;
  if (typeof globalThis.location === 'undefined')
    return value || path;
  const { protocol, hostname, port } = globalThis.location;
  if (port === '5173')
    return `${protocol}//${hostname}:8080${path}`;
  return value || path;
}

export const db = map({
  db: dbWorkerClient,
  commands: demoCommands
});

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function createDedicatedDbWorker() {
  const workerUrl = new URL('./db.worker.js', import.meta.url);
  workerUrl.searchParams.set('db', localDbName);
  workerUrl.searchParams.set('syncUrl', syncUrl);
  workerUrl.searchParams.set('busyTimeoutMs', '5000');
  return new Worker(workerUrl, {
    type: 'module',
    name: 'orange-sync-demo:' + localDbName + ':opfs-db-worker'
  });
}

function createSharedDbWorker() {
  const workerUrl = new URL('./db.shared.worker.js', import.meta.url);
  return new SharedWorker(workerUrl, {
    type: 'module',
    name: 'orange-sync-demo:' + localDbName + ':db-coordinator'
  });
}

function registerDedicatedDbWorker(sharedWorker, dedicatedWorker) {
  const port = sharedWorker && sharedWorker.port;
  if (!port || typeof port.postMessage !== 'function')
    return;
  if (typeof port.start === 'function')
    port.start();
  const channel = new MessageChannel();
  port.postMessage({ type: 'orange-demo-register-db-port' }, [channel.port1]);
  dedicatedWorker.postMessage({ type: 'orange-demo-connect-db-port' }, [channel.port2]);
}

function handleSharedDbWorkerMessage(event) {
  const message = event && event.data;
  if (!message)
    return;
  if (message.type === 'orange-demo-start-db-worker') {
    startDedicatedDbWorker();
    return;
  }
  if (message.type === 'orange-demo-stop-db-worker') {
    stopDedicatedDbWorker();
    return;
  }
  if (message.type === 'orange-demo-diagnostic') {
    console.info('[db-worker]', message.event, message.payload);
  }
}

function startDedicatedDbWorker() {
  if (dbWorker)
    return;
  dbWorker = createDedicatedDbWorker();
  if (dbWorker && typeof dbWorker.addEventListener === 'function') {
    dbWorker.addEventListener('message', (event) => {
      const message = event && event.data;
      if (!message || message.type !== 'orange-demo-diagnostic')
        return;
      console.info('[db-worker]', message.event, message.payload);
    });
  }
  registerDedicatedDbWorker(sharedDbWorker, dbWorker);
}

function stopDedicatedDbWorker() {
  if (!dbWorker)
    return;
  if (typeof dbWorker.postMessage === 'function') {
    try {
      dbWorker.postMessage({ type: 'orange-demo-db-port-close' });
    }
    catch (_e) {}
  }
  if (typeof dbWorker.terminate === 'function')
    dbWorker.terminate();
  dbWorker = null;
}

function closeDbWorkers(sharedWorker, workerClient) {
  const port = sharedWorker && sharedWorker.port;
  if (port && typeof port.postMessage === 'function') {
    try {
      port.postMessage({ type: 'orange-demo-db-port-close' });
    }
    catch (_e) {}
  }
  workerClient.close();
  stopDedicatedDbWorker();
}
