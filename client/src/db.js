import rdb from 'orange-orm';
import { createDemoMap, demoCommands } from '../../shared/schema.js';

const syncUrl = 'http://localhost:8080/rdb';
const normalLocalDbName = 'orange-sync-demo_vfs2.sqlite3';
const bigLocalDbName = 'orange-sync-demo-big2.sqlite3';
const bigModeEnabled = import.meta.env.VITE_BIG_MODE === '1';
const sqliteBusyTimeoutMs = parsePositiveInteger(import.meta.env.VITE_SQLITE_BUSY_TIMEOUT_MS, 5000);
export const localDbName = bigModeEnabled ? bigLocalDbName : normalLocalDbName;
export const bigMode = bigModeEnabled;
export const syncOperationTimeoutMs = parsePositiveInteger(import.meta.env.VITE_SYNC_OPERATION_TIMEOUT_MS, 300000);
const sahPoolRecoveryKey = `orange-sync-demo.clearSahPool.${localDbName}`;
const clearSahPoolOnOpen = consumeSessionFlag(sahPoolRecoveryKey);
const map = createDemoMap(rdb);

console.info('[local-db] using main-thread ORM sqliteOPFS', {
  localDbName,
  syncUrl,
  sqliteBusyTimeoutMs,
  sqliteWorker: 'dedicated',
  clearSahPoolOnOpen
});

const sqliteOptions = {
  busyTimeoutMs: sqliteBusyTimeoutMs,
  sync: {
    url: syncUrl,
    auto: false
  }
};
if (clearSahPoolOnOpen)
  sqliteOptions.opfsSahPool = { clearOnInit: true };

export const db = map({
  db: (con) => con.sqliteOPFS(localDbName, sqliteOptions),
  commands: demoCommands
});

if (typeof globalThis.addEventListener === 'function') {
  globalThis.addEventListener('pagehide', () => {
    if (db && typeof db.close === 'function')
      void db.close();
  }, { once: true });
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
    const payload = {
      label,
      elapsedMs: Math.round(performance.now() - startedAt),
      error: e
    };
    if (isLocalSqliteCorruption(e))
      console.warn('[sync-trace] local SQLite corruption detected', payload);
    else
      console.error('[sync-trace] failed', payload);
    throw e;
  }
}

function isLocalSqliteCorruption(error) {
  return /SQLITE_CORRUPT|database disk image is malformed/u.test(error && error.message || String(error));
}

export function requestSahPoolRecovery() {
  if (typeof globalThis.sessionStorage !== 'undefined')
    sessionStorage.setItem(sahPoolRecoveryKey, '1');
}

function consumeSessionFlag(key) {
  if (typeof globalThis.sessionStorage === 'undefined')
    return false;
  const enabled = sessionStorage.getItem(key) === '1';
  if (enabled)
    sessionStorage.removeItem(key);
  return enabled;
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
