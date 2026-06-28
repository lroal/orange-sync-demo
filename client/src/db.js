import rdb from 'orange-orm';
import { createDemoMap, demoCommands } from '../../shared/schema.js';

const syncUrl = import.meta.env.VITE_SYNC_URL || '/rdb';
const localDbNameOverrideKey = 'orange-sync-demo.localDbNameOverride';
const configuredLocalDbName = import.meta.env.VITE_SQLITE_DB_NAME || 'orange-sync-demo_vfs2.sqlite3';
export const localDbName = readLocalDbNameOverride() || configuredLocalDbName;
export const bigMode = import.meta.env.VITE_BIG_MODE === '1' || localDbName.includes('big');
export const syncOperationTimeoutMs = parsePositiveInteger(import.meta.env.VITE_SYNC_OPERATION_TIMEOUT_MS, 300000);
const traceApplySqlDefault = parseBooleanEnv(import.meta.env.VITE_TRACE_APPLY_SQL, bigMode);
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
const syncTimingProbeVersion = 2;
let activeSyncOperations = 0;
let traceApplySqlOverride;
const syncTraceStack = [];

export function rotateLocalDbNameForRecovery() {
  if (typeof localStorage === 'undefined')
    return null;

  const nextName = addRecoverySuffix(configuredLocalDbName);
  localStorage.setItem(localDbNameOverrideKey, nextName);
  return nextName;
}

export async function traceSyncOperation(labelOrFn, maybeFn) {
  const label = typeof labelOrFn === 'string' ? labelOrFn : 'sync operation';
  const fn = typeof labelOrFn === 'function' ? labelOrFn : maybeFn;
  activeSyncOperations += 1;
  const trace = startSyncTrace(label);
  try {
    return await fn();
  }
  finally {
    finishSyncTrace(trace);
    activeSyncOperations = Math.max(0, activeSyncOperations - 1);
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

export const db = map({
  db: (con) => con.sqliteOPFS(localDbName, {
    busyTimeoutMs: 5000,
    ...(sqliteOpfsVfs ? { vfs: sqliteOpfsVfs } : {}),
    ...(sqliteOpfsSahPool ? { sahPool: sqliteOpfsSahPool } : {}),
    sync: {
      url: syncUrl,
      auto: false
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

function parseBooleanEnv(value, fallback) {
  if (value === '1' || value === 'true')
    return true;
  if (value === '0' || value === 'false')
    return false;
  return fallback;
}

function installSyncTimingProbe() {
  if (typeof window === 'undefined' || typeof window.fetch !== 'function')
    return;
  const legacyProbeInstalled = window.__orangeSyncTimingProbeInstalled && !window.__orangeSyncTimingProbe;
  const probe = window.__orangeSyncTimingProbe || {};
  if (probe.queryHandler)
    rdb.off('query', probe.queryHandler);
  if (probe.queryCompleteHandler)
    rdb.off('queryComplete', probe.queryCompleteHandler);
  probe.version = syncTimingProbeVersion;
  probe.activePulls = Number(probe.activePulls || 0);
  probe.logFetch = !legacyProbeInstalled;
  probe.logSqlite = !legacyProbeInstalled;
  window.__orangeSyncTimingProbe = probe;
  window.__orangeSyncTimingProbeInstalled = true;
  installSyncTraceControls(window);

  if (probe.fetchVersion !== syncTimingProbeVersion) {
    const originalFetch = probe.originalFetch || window.fetch.bind(window);
    probe.originalFetch = originalFetch;
    probe.fetchVersion = syncTimingProbeVersion;
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
          probe.activePulls += 1;
        if (probe.logFetch)
          console.info('[sync-fetch] start phase=' + (phase || 'unknown') + ' requestItems=' + itemCount);
      }

      try {
        const response = await originalFetch(input, init);
        if (isSyncRequest) {
          const elapsedMs = performance.now() - startedAt;
          recordSyncFetch(currentSyncTrace(), phase, elapsedMs, itemCount, response.status);
          if (probe.logFetch)
            console.info('[sync-fetch] response phase=' + (phase || 'unknown') + ' status=' + response.status + ' elapsed=' + elapsedMs.toFixed(1) + ' ms requestItems=' + itemCount);
        }
        return response;
      }
      catch (error) {
        if (isSyncRequest) {
          const elapsedMs = performance.now() - startedAt;
          recordSyncFetch(currentSyncTrace(), phase, elapsedMs, itemCount, 'error');
          if (probe.logFetch)
            console.info('[sync-fetch] error phase=' + (phase || 'unknown') + ' elapsed=' + elapsedMs.toFixed(1) + ' ms');
        }
        throw error;
      }
      finally {
        if (isSyncRequest && phase === 'keys')
          probe.activePulls = Math.max(0, probe.activePulls - 1);
      }
    };
  }

  probe.queryHandler = ({ sql, lane, readonly }) => {
    if (!probe.logSqlite || !shouldTraceSyncSql(probe.activePulls))
      return;
    const compactSql = compactSqlText(sql);
    if (!shouldLogSyncSqlStart(compactSql))
      return;
    console.info('[sync-sqlite] start' + lanePart(lane, readonly) + ' sql=' + compactSql);
  };
  rdb.on('query', probe.queryHandler);

  probe.queryCompleteHandler = ({ sql, elapsedMs, workerElapsedMs, error, lane, readonly }) => {
    const trace = currentSyncTrace();
    const sqlPhase = recordSyncSql(trace, sql, elapsedMs, workerElapsedMs, error);
    if (trace && sqlPhase === 'apply' && isTraceApplySqlEnabled()) {
      const applySql = compactSqlText(sql, 360);
      if (shouldLogSyncSqlStart(applySql))
        console.info('[sync-apply-sql] elapsed=' + Number(elapsedMs || 0).toFixed(1) + ' ms' + workerPartText(workerElapsedMs) + lanePart(lane, readonly) + errorPartText(error) + ' sql=' + applySql);
    }
    if (!probe.logSqlite || !shouldTraceSyncSql(probe.activePulls))
      return;
    const compactSql = compactSqlText(sql);
    if (!shouldLogSyncSql(compactSql, error))
      return;
    console.info('[sync-sqlite] elapsed=' + Number(elapsedMs || 0).toFixed(1) + ' ms' + workerPartText(workerElapsedMs) + lanePart(lane, readonly) + errorPartText(error) + ' sql=' + compactSql);
  };
  rdb.on('queryComplete', probe.queryCompleteHandler);
}

function installSyncTraceControls(windowRef) {
  windowRef.orangeSyncTrace = {
    setApplySql(enabled) {
      traceApplySqlOverride = Boolean(enabled);
      console.info('[sync-trace] apply SQL logging ' + (traceApplySqlOverride ? 'enabled' : 'disabled'));
    },
    getApplySql() {
      return isTraceApplySqlEnabled();
    }
  };
}

function startSyncTrace(label) {
  const trace = {
    label,
    startedAt: performance.now(),
    fetch: newMetricGroups(['keys', 'rows', 'push', 'api', 'unknown']),
    sqlite: newMetricGroups(['stage', 'apply', 'base', 'other']),
    state: {
      phase: 'stage',
      applyCleanupStarted: false
    }
  };
  syncTraceStack.push(trace);
  return trace;
}

function finishSyncTrace(trace) {
  const index = syncTraceStack.lastIndexOf(trace);
  if (index !== -1)
    syncTraceStack.splice(index, 1);
  const elapsedMs = performance.now() - trace.startedAt;
  console.info('[sync-trace] ' + trace.label + ' total=' + formatMs(elapsedMs));
  logMetricGroups(trace.label, 'fetch', trace.fetch, ['keys', 'rows', 'push', 'api', 'unknown']);
  logMetricGroups(trace.label, 'sqlite', trace.sqlite, ['stage', 'apply', 'base', 'other']);
}

function currentSyncTrace() {
  return syncTraceStack[syncTraceStack.length - 1] || null;
}

function newMetricGroups(names) {
  const groups = {};
  for (let i = 0; i < names.length; i++)
    groups[names[i]] = {
      count: 0,
      totalMs: 0,
      workerMs: 0,
      requestItems: 0,
      errors: 0
    };
  return groups;
}

function recordSyncFetch(trace, phase, elapsedMs, requestItems, status) {
  if (!trace)
    return;
  const group = trace.fetch[normalizeFetchPhase(phase)] || trace.fetch.unknown;
  group.count += 1;
  group.totalMs += Number(elapsedMs || 0);
  group.requestItems += Number(requestItems || 0);
  if (status === 'error' || Number(status) >= 400)
    group.errors += 1;
}

function recordSyncSql(trace, sql, elapsedMs, workerElapsedMs, error) {
  if (!trace)
    return null;
  const phase = classifySyncSqlPhase(trace, sql);
  const group = trace.sqlite[phase] || trace.sqlite.other;
  group.count += 1;
  group.totalMs += Number(elapsedMs || 0);
  if (typeof workerElapsedMs === 'number')
    group.workerMs += workerElapsedMs;
  if (error)
    group.errors += 1;
  updateSyncSqlPhaseState(trace, sql, phase);
  return phase;
}

function classifySyncSqlPhase(trace, sql) {
  const normalized = compactSqlText(sql, 1000);
  if (isBaseSql(normalized))
    return 'base';
  if (isApplyStartSql(normalized))
    return 'apply';
  if (trace.state.phase === 'apply')
    return 'apply';
  if (isStageSql(normalized))
    return 'stage';
  return 'other';
}

function updateSyncSqlPhaseState(trace, sql, phase) {
  const normalized = compactSqlText(sql, 1000);
  if (phase === 'apply')
    trace.state.phase = 'apply';
  if (phase === 'apply' && /DELETE FROM "orange_sync_pull_(item|session)"/iu.test(normalized))
    trace.state.applyCleanupStarted = true;
  if (trace.state.phase === 'apply' && trace.state.applyCleanupStarted && /^COMMIT\b/iu.test(normalized)) {
    trace.state.phase = 'afterApply';
    trace.state.applyCleanupStarted = false;
  }
}

function normalizeFetchPhase(phase) {
  if (phase === 'keys' || phase === 'rows' || phase === 'push')
    return phase;
  if (phase)
    return 'api';
  return 'unknown';
}

function isBaseSql(sql) {
  return /orange_sync_base_tables|orange_sync_base_data_/iu.test(sql);
}

function isStageSql(sql) {
  return /orange_sync_pull_item|orange_sync_pull_session/iu.test(sql);
}

function isApplyStartSql(sql) {
  return /^SELECT "batch_no", "seq", "table_name"/iu.test(sql) && /orange_sync_pull_item/iu.test(sql);
}

function logMetricGroups(label, type, groups, names) {
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const group = groups[name];
    if (!group || group.count === 0)
      continue;
    const requestPart = group.requestItems > 0 ? ' requestItems=' + group.requestItems : '';
    const workerPart = group.workerMs > 0 ? ' worker=' + formatMs(group.workerMs) : '';
    const errorPart = group.errors > 0 ? ' errors=' + group.errors : '';
    console.info('[sync-trace] ' + label + ' ' + type + ' phase=' + name + ' count=' + group.count + ' total=' + formatMs(group.totalMs) + ' avg=' + formatMs(group.totalMs / group.count) + workerPart + requestPart + errorPart);
  }
}

function isTraceApplySqlEnabled() {
  return traceApplySqlOverride === undefined ? traceApplySqlDefault : traceApplySqlOverride;
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

function shouldTraceSyncSql(activePulls) {
  return activePulls > 0 || activeSyncOperations > 0;
}

function shouldLogSyncSqlStart(sql) {
  return /^(SELECT|INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|COMMIT|BEGIN|ROLLBACK|PRAGMA)/iu.test(sql);
}

function compactSqlText(sql, maxLength = 180) {
  return typeof sql === 'string'
    ? sql.replace(/\s+/g, ' ').trim().slice(0, maxLength)
    : '';
}

function workerPartText(workerElapsedMs) {
  return typeof workerElapsedMs === 'number'
    ? ' worker=' + workerElapsedMs.toFixed(1) + ' ms'
    : '';
}

function errorPartText(error) {
  return error ? ' error=' + (error.message || String(error)) : '';
}

function formatMs(value) {
  return Number(value || 0).toFixed(1) + ' ms';
}

function lanePart(lane, readonly) {
  if (lane)
    return ' lane=' + lane;
  if (readonly === true)
    return ' lane=reader';
  if (readonly === false)
    return ' lane=writer';
  return '';
}
