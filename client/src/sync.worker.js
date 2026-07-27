import rdb from 'orange-orm';

import { createDemoMap, demoCommands } from '../../shared/schema.js';
import { sqlDiagnosticsEnabled, sqlDiagnosticsSlowMs, syncDiagnosticsEnabled } from './dbConfig.js';

let handler;
let nextSyncRequestId = 1;
const pendingEvents = [];

installSyncSqlDiagnostics();

self.onmessage = (event) => {
  const message = event && event.data;
  if (message && message.type === 'orange-sync-demo-init') {
    initialize(message);
    return;
  }
  if (!handler) {
    pendingEvents.push(event);
    return;
  }
  void handler.handleMessage(event);
};

function initialize(message) {
  const map = createDemoMap(rdb);
  const db = map({
    db: (con) => con.sqliteOPFS(message.localDbName, {
      ...message.sqliteOptions,
      worker: message.sqlPort,
      closeDbOnClose: false
    }),
    commands: demoCommands
  });

  installSyncHttpDiagnostics(db.syncClient);
  handler = rdb.createSyncWorkerHandler(db.syncClient);
  console.info('[sync-worker]', 'initialized', message.localDbName, {
    apply: message.sqliteOptions?.sync?.pull?.apply
  });
  while (pendingEvents.length > 0)
    void handler.handleMessage(pendingEvents.shift());
}

function installSyncSqlDiagnostics() {
  if (!sqlDiagnosticsEnabled)
    return;
  rdb.on('queryComplete', (entry) => {
    if (!entry || Number(entry.elapsedMs || 0) < sqlDiagnosticsSlowMs)
      return;
    console.info(
      '[sync-sql]',
      `${Math.round(entry.elapsedMs)}ms`,
      entry.workerElapsedMs === undefined ? '' : `worker=${Math.round(entry.workerElapsedMs)}ms`,
      entry.lane || '',
      entry.connectionString || '',
      summarizeSql(entry.sql)
    );
  });
}

function installSyncHttpDiagnostics(syncClient) {
  if (!syncDiagnosticsEnabled || !syncClient || !syncClient.interceptors)
    return;
  syncClient.interceptors.request.use((config) => {
    const body = config?.data;
    const phase = syncPhase(body?.phase || body?.action);
    if (phase === 'unknown')
      return config;
    config.__orangeSyncWorkerDiagnostics = {
      id: nextSyncRequestId++,
      phase,
      itemCount: Array.isArray(body?.items)
        ? body.items.length
        : Array.isArray(body?.mutations)
          ? body.mutations.length
          : 0,
      startedAt: performance.now()
    };
    return config;
  });
  syncClient.interceptors.response.use(
    (response) => {
      logSyncHttpDiagnostics(response?.config?.__orangeSyncWorkerDiagnostics, response?.data, false);
      return response;
    },
    (error) => {
      logSyncHttpDiagnostics(error?.config?.__orangeSyncWorkerDiagnostics, undefined, true);
      throw error;
    }
  );
}

function logSyncHttpDiagnostics(request, payload, failed) {
  if (!request)
    return;
  const elapsedMs = Math.round(performance.now() - request.startedAt);
  const returnedItems = Array.isArray(payload?.items) ? payload.items.length : 0;
  console.info(
    '[sync-http]',
    request.phase,
    failed ? 'failed' : 'ok',
    `${elapsedMs}ms`,
    `items=${request.itemCount}`,
    `returned=${returnedItems}`
  );
}

function syncPhase(value) {
  if (value === 'keys' || value === 'rows' || value === 'push')
    return value;
  return 'unknown';
}

function summarizeSql(sql) {
  return String(sql || '').replace(/\s+/g, ' ').trim().slice(0, 180);
}
