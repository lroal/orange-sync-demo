import rdb from 'orange-orm';
import { createDemoMap, demoCommands } from '../../shared/schema.js';

const syncUrl = resolveDevServerUrl(import.meta.env.VITE_SYNC_URL || '/rdb', '/rdb');
const localDbNameOverrideKey = 'orange-sync-demo.localDbNameOverride';
const configuredLocalDbName = import.meta.env.VITE_SQLITE_DB_NAME || 'orange-sync-demo_vfs2.sqlite3';
const sqliteBusyTimeoutMs = parsePositiveInteger(import.meta.env.VITE_SQLITE_BUSY_TIMEOUT_MS, 5000);
export const localDbName = readLocalDbNameOverride() || configuredLocalDbName;
export const bigMode = import.meta.env.VITE_BIG_MODE === '1' || localDbName.includes('big');
export const syncOperationTimeoutMs = parsePositiveInteger(import.meta.env.VITE_SYNC_OPERATION_TIMEOUT_MS, 300000);
const map = createDemoMap(rdb);

console.info('[local-db] using main-thread ORM sqliteOPFS', {
  localDbName,
  syncUrl,
  sqliteBusyTimeoutMs,
  sqliteWorker: 'dedicated',
  stableBase: false
});

export const db = map({
  db: (con) => con.sqliteOPFS(localDbName, {
    busyTimeoutMs: sqliteBusyTimeoutMs,
    sync: {
      url: syncUrl,
      auto: false,
      stableBase: false
    }
  }),
  commands: demoCommands
});

if (typeof globalThis.addEventListener === 'function') {
  globalThis.addEventListener('pagehide', () => {
    if (db && typeof db.close === 'function')
      void db.close();
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
  const label = typeof labelOrFn === 'function' ? 'sync operation' : labelOrFn;
  const fn = typeof labelOrFn === 'function' ? labelOrFn : maybeFn;
  const startedAt = performance.now();
  console.info('[sync-trace] start', { label });
  try {
    const result = await fn();
    console.info('[sync-trace] done', {
      label,
      elapsedMs: Math.round(performance.now() - startedAt)
    });
    return result;
  }
  catch (e) {
    console.error('[sync-trace] failed', {
      label,
      elapsedMs: Math.round(performance.now() - startedAt),
      error: e
    });
    throw e;
  }
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

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
