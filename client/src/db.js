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
  sqliteSingleWorker: false,
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

const sqliteOptions = {
  busyTimeoutMs: sqliteBusyTimeoutMs,
  singleWorker: false,
  sync: {
    url: syncUrl,
    auto: false,

    pull: {
      ...(syncPullMaxConcurrentRowRequests ? { maxConcurrentRowRequests: syncPullMaxConcurrentRowRequests } : {}),
      ...(syncPullMaxKeysPerBatch ? { maxKeysPerBatch: syncPullMaxKeysPerBatch } : {}),
      ...(syncPullMaxRowsPerBatch ? { maxRowsPerBatch: syncPullMaxRowsPerBatch } : {}),
      apply: {
        maxRowsPerTransaction: syncPullApplyMaxRowsPerTransaction,
        yieldMs: syncPullApplyYieldMs
      }
    }
  }
};

const syncWorkerSqliteOptions = {
  ...sqliteOptions,
  singleWorker: true
};

const sqliteWorker = rdb.createSqliteOPFSWorker({
  connectionString: localDbName,
  ...sqliteOptions
});
const syncSqlPort = rdb.connectSqliteOPFSWorker(sqliteWorker);
const syncWorker = new Worker(new URL('./sync.worker.js', import.meta.url), { type: 'module' });
syncWorker.postMessage({
  type: 'orange-sync-demo-init',
  localDbName,
  sqliteOptions: syncWorkerSqliteOptions,
  sqlPort: syncSqlPort
}, [syncSqlPort]);
const syncClient = rdb.createSyncWorkerClient(syncWorker);


export { bigMode, localDbName, syncOperationTimeoutMs };

export const db = map({
  db: (con) => con.sqliteOPFS(localDbName, {
    ...sqliteOptions,
    worker: sqliteWorker
  }),
  syncClient,
  commands: demoCommands
});
