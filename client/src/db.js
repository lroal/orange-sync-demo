import rdb from 'orange-orm';
import { createDemoMap, demoCommands } from '../../shared/schema.js';

const syncUrl = import.meta.env.VITE_SYNC_URL || '/rdb';
export const localDbName = import.meta.env.VITE_SQLITE_DB_NAME || 'orange-sync-demo_vfs2.sqlite3';
export const bigMode = import.meta.env.VITE_BIG_MODE === '1' || localDbName.includes('big');
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
        maxRowsPerBatch: 50
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
