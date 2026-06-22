import rdb from 'orange-orm';
import { createDemoMap, demoCommands } from '../../shared/schema.js';

const syncUrl = import.meta.env.VITE_SYNC_URL || 'http://localhost:3055/rdb';
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
  db: (con) => con.sqliteOPFS('orange-sync-demo_vfs2.sqlite3', {
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
