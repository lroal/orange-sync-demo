import rdb from 'orange-orm';

import { createDemoMap, demoCommands } from '../../shared/schema.js';
import {
  bigMode,
  localDbName,
  sqliteBusyTimeoutMs,
  syncAutoIntervalMs,
  syncOperationTimeoutMs,
  syncPullApplyMaxRowsPerTransaction,
  syncPullApplyYieldMs,
  syncPullMaxConcurrentRowRequests,
  syncPullMaxKeysPerBatch,
  syncPullMaxRowsPerBatch,
  syncUrl
} from './dbConfig.js';

console.dir({
  bigMode,
  localDbName,
  sqliteVfs: 'opfs-wl',
  sqliteSingleWorker: true,
  syncWorkerSqliteSingleWorker: true,
  sqliteBusyTimeoutMs,
  syncAutoIntervalMs,
  syncOperationTimeoutMs,
  syncPullApplyMaxRowsPerTransaction,
  syncPullApplyYieldMs,
  syncPullMaxConcurrentRowRequests,
  syncPullMaxKeysPerBatch,
  syncPullMaxRowsPerBatch,
  syncUrl
})


const map = createDemoMap(rdb);

const syncPullApply = syncPullApplyMaxRowsPerTransaction
  ? {
      apply: {
        maxRowsPerTransaction: syncPullApplyMaxRowsPerTransaction,
        yieldMs: syncPullApplyYieldMs
      }
    }
  : {};

const sqliteWorkerOptions = {
  busyTimeoutMs: sqliteBusyTimeoutMs,
  singleWorker: true,
  vfs: 'opfs-wl',
  sync: {
    url: syncUrl,
    auto: {
      enabled: true,
      intervalMs: syncAutoIntervalMs
    },

    push: {
      maxMutationsPerBatch: 50
    },

    pull: {
      ...(syncPullMaxConcurrentRowRequests ? { maxConcurrentRowRequests: syncPullMaxConcurrentRowRequests } : {}),
      ...(syncPullMaxKeysPerBatch ? { maxKeysPerBatch: syncPullMaxKeysPerBatch } : {}),
      ...(syncPullMaxRowsPerBatch ? { maxRowsPerBatch: syncPullMaxRowsPerBatch } : {}),
      ...syncPullApply
    }
  }
};

const localDbConnectionStrings = [
  localDbName,
  appendDualDbSuffix(localDbName, 'b'),
  appendDualDbSuffix(localDbName, 'delta')
];
const sqliteWorkerByConnectionString = new Map(
  localDbConnectionStrings.map((connectionString) => [
    connectionString,
    rdb.createSqliteOPFSWorker({
      connectionString,
      ...sqliteWorkerOptions
    })
  ])
);
for (const connectionString of localDbConnectionStrings) {
  console.info(
    '[sqlite-worker]',
    connectionString,
    'vfs=opfs-wl'
  );
}
const sqliteOptions = {
  ...sqliteWorkerOptions,
  createWorker: getSqliteWorker
};
const syncWorkerSqliteOptions = {
  ...sqliteWorkerOptions,
  singleWorker: true
};

const syncSqlConnections = localDbConnectionStrings.map((connectionString) => ({
  connectionString,
  port: rdb.connectSqliteOPFSWorker(getSqliteWorker(connectionString))
}));
const syncWorker = new Worker(new URL('./sync.worker.js', import.meta.url), { type: 'module' });
syncWorker.postMessage({
  type: 'orange-sync-demo-init',
  localDbName,
  sqliteOptions: syncWorkerSqliteOptions,
  sqlConnections: syncSqlConnections
}, syncSqlConnections.map(({ port }) => port));
const syncClient = rdb.createSyncWorkerClient(syncWorker);


export { bigMode, localDbName, syncOperationTimeoutMs };

export const db = map({
  db: (con) => con.sqliteOPFS(localDbName, {
    ...sqliteOptions
  }),
  syncClient,
  commands: demoCommands
});

let closePromise;

export function closeDemoDatabase() {
  if (closePromise)
    return closePromise;
  closePromise = (async () => {
    try {
      await syncClient.stop();
    }
    catch (_error) {
      // Continue closing the workers even if an active sync did not stop cleanly.
    }
    syncClient.close();
    try {
      await db.close();
    }
    finally {
      for (const worker of sqliteWorkerByConnectionString.values())
        worker.terminate();
    }
  })();
  return closePromise;
}

const onPageHide = () => {
  void closeDemoDatabase();
};
const onPageShow = (event) => {
  if (event.persisted)
    globalThis.location?.reload();
};
globalThis.addEventListener?.('pagehide', onPageHide, { once: true });
globalThis.addEventListener?.('pageshow', onPageShow);

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    globalThis.removeEventListener?.('pagehide', onPageHide);
    globalThis.removeEventListener?.('pageshow', onPageShow);
    void closeDemoDatabase();
  });
}

function getSqliteWorker(connectionString) {
  const worker = sqliteWorkerByConnectionString.get(connectionString);
  if (!worker)
    throw new Error(`No shared sqliteOPFS worker configured for "${connectionString}".`);
  return worker;
}

function appendDualDbSuffix(connectionString, suffix) {
  const value = String(connectionString);
  if (value.endsWith('.sqlite3'))
    return value.slice(0, -8) + `.__orange_sync_${suffix}.sqlite3`;
  if (value.endsWith('.db'))
    return value.slice(0, -3) + `.__orange_sync_${suffix}.db`;
  return `${value}.__orange_sync_${suffix}.sqlite3`;
}
