export const syncUrl = 'http://localhost:8080/rdb';
export const normalLocalDbName = 'orange-sync-demo_vfs2.sqlite3';
export const bigLocalDbName = 'orange-sync-demo-big2.sqlite3';
export const bigMode = import.meta.env.VITE_BIG_MODE === '1';
export const localDbName = bigMode ? bigLocalDbName : normalLocalDbName;
export const sqliteBusyTimeoutMs = parsePositiveInteger(import.meta.env.VITE_SQLITE_BUSY_TIMEOUT_MS, 5000);
export const syncOperationTimeoutMs = parsePositiveInteger(import.meta.env.VITE_SYNC_OPERATION_TIMEOUT_MS, 300000);
export const syncAutoIntervalMs = parseNonNegativeInteger(import.meta.env.VITE_SYNC_AUTO_INTERVAL_MS, 1000);
export const syncPullMaxConcurrentRowRequests = parseOptionalPositiveInteger(import.meta.env.VITE_SYNC_PULL_MAX_CONCURRENT_ROW_REQUESTS);
export const syncPullMaxKeysPerBatch = parseOptionalPositiveInteger(import.meta.env.VITE_SYNC_PULL_MAX_KEYS_PER_BATCH);
export const syncPullMaxRowsPerBatch = parseOptionalPositiveInteger(import.meta.env.VITE_SYNC_PULL_MAX_ROWS_PER_BATCH);
export const syncPullApplyMaxRowsPerTransaction = parseOptionalPositiveInteger(import.meta.env.VITE_SYNC_PULL_APPLY_MAX_ROWS_PER_TRANSACTION);
export const syncPullApplyYieldMs = parseNonNegativeInteger(import.meta.env.VITE_SYNC_PULL_APPLY_YIELD_MS, 0);
export const syncDiagnosticsEnabled = import.meta.env.VITE_SYNC_DIAGNOSTICS !== '0';
export const sqlDiagnosticsEnabled = import.meta.env.VITE_SQL_DIAGNOSTICS !== '0';
export const sqlDiagnosticsSlowMs = parseNonNegativeInteger(import.meta.env.VITE_SQL_DIAGNOSTICS_SLOW_MS, 50);

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseOptionalPositiveInteger(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseNonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
