import rdb from 'orange-orm';

import { createDemoMap, demoCommands } from '../../shared/schema.js';
import {
  bigMode,
  localDbName,
  sqliteBusyTimeoutMs,
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
  sqliteSingleWorker: true,
  syncWorkerSqliteSingleWorker: true,
  sqliteBusyTimeoutMs,
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
  sync: {
    url: syncUrl,
    auto: false,

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
