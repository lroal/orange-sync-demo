import rdb from 'orange-orm';
import { createDemoMap, demoCommands } from '../../shared/schema.js';

const syncUrl = import.meta.env.VITE_SYNC_URL || '/rdb';
const localDbNameOverrideKey = 'orange-sync-demo.localDbNameOverride';
const configuredLocalDbName = import.meta.env.VITE_SQLITE_DB_NAME || 'orange-sync-demo_vfs2.sqlite3';
export const localDbName = readLocalDbNameOverride() || configuredLocalDbName;
export const bigMode = import.meta.env.VITE_BIG_MODE === '1' || localDbName.includes('big');
export const syncOperationTimeoutMs = parsePositiveInteger(import.meta.env.VITE_SYNC_OPERATION_TIMEOUT_MS, 300000);
const sqliteOpfsVfs = import.meta.env.VITE_SQLITE_OPFS_VFS === 'opfs'
  ? 'opfs'
  : import.meta.env.VITE_SQLITE_OPFS_VFS === 'opfs-sahpool'
    ? 'opfs-sahpool'
    : undefined;
const sqliteOpfsSahPool = sqliteOpfsVfs === 'opfs-sahpool'
  ? {
      fallbackToOpfs: import.meta.env.VITE_SQLITE_OPFS_SAH_FALLBACK === '1'
    }
  : undefined;
const map = createDemoMap(rdb);

export function rotateLocalDbNameForRecovery() {
  if (typeof localStorage === 'undefined')
    return null;

  const nextName = addRecoverySuffix(configuredLocalDbName);
  localStorage.setItem(localDbNameOverrideKey, nextName);
  return nextName;
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
  db: (con) => con.sqliteOPFS(localDbName, {
    busyTimeoutMs: 5000,
    ...(sqliteOpfsVfs ? { vfs: sqliteOpfsVfs } : {}),
    ...(sqliteOpfsSahPool ? { sahPool: sqliteOpfsSahPool } : {}),
    sync: {
      url: syncUrl,
      auto: false,
      pull: {
        maxKeysPerBatch: 1000,
        maxRowsPerBatch: 500
      }
      //  {
      //   intervalMs: 8000,
      //   push: true,
      //   pull: true
      // }
    }
  }),
  commands: demoCommands
});

installSyncTimingProbe();

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function installSyncTimingProbe() {
  if (typeof window === 'undefined' || typeof window.fetch !== 'function')
    return;
  if (window.__orangeSyncTimingProbeInstalled)
    return;
  window.__orangeSyncTimingProbeInstalled = true;

  let activePulls = 0;
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const request = normalizeFetchRequest(input, init);
    const body = parseJsonBody(request.init && request.init.body);
    const isSyncRequest = request.url.includes('/rdb') && request.url.includes('sync=');
    const phase = body && (body.phase || body.action);
    const itemCount = Array.isArray(body && body.items)
      ? body.items.length
      : Array.isArray(body && body.mutations)
        ? body.mutations.length
        : 0;
    const startedAt = performance.now();

    if (isSyncRequest) {
      if (phase === 'keys')
        activePulls += 1;
      console.info('[sync-fetch] start phase=' + (phase || 'unknown') + ' items=' + itemCount);
    }

    try {
      const response = await originalFetch(input, init);
      if (isSyncRequest) {
        console.info('[sync-fetch] response phase=' + (phase || 'unknown') + ' status=' + response.status + ' elapsed=' + (performance.now() - startedAt).toFixed(1) + ' ms items=' + itemCount);
      }
      return response;
    }
    catch (error) {
      if (isSyncRequest) {
        console.info('[sync-fetch] error phase=' + (phase || 'unknown') + ' elapsed=' + (performance.now() - startedAt).toFixed(1) + ' ms');
      }
      throw error;
    }
    finally {
      if (isSyncRequest && phase === 'keys' && body && body.token === null)
        activePulls = Math.max(0, activePulls - 1);
    }
  };

  rdb.on('queryComplete', ({ sql, elapsedMs, workerElapsedMs, error }) => {
    if (activePulls <= 0)
      return;
    const compactSql = typeof sql === 'string'
      ? sql.replace(/\s+/g, ' ').trim().slice(0, 140)
      : '';
    if (!shouldLogSyncSql(compactSql, error))
      return;
    const workerPart = typeof workerElapsedMs === 'number'
      ? ' worker=' + workerElapsedMs.toFixed(1) + ' ms'
      : '';
    const errorPart = error ? ' error=' + (error.message || String(error)) : '';
    console.info('[sync-sqlite] elapsed=' + Number(elapsedMs || 0).toFixed(1) + ' ms' + workerPart + errorPart + ' sql=' + compactSql);
  });
}

function normalizeFetchRequest(input, init) {
  if (typeof input === 'string')
    return { url: input, init: init || {} };
  if (input && typeof input.url === 'string')
    return { url: input.url, init: init || input };
  return { url: '', init: init || {} };
}

function parseJsonBody(body) {
  if (typeof body !== 'string')
    return null;
  try {
    return JSON.parse(body);
  }
  catch (_error) {
    return null;
  }
}

function shouldLogSyncSql(sql, error) {
  if (error)
    return true;
  if (!sql)
    return false;
  return /^(INSERT|UPDATE|DELETE|REPLACE|COMMIT|BEGIN|ROLLBACK|PRAGMA foreign_key_check|PRAGMA defer_foreign_keys)/iu.test(sql);
}
