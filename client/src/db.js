import { createDemoMap } from '../../shared/schema.js';

const syncUrl = import.meta.env.VITE_SYNC_URL || 'http://localhost:3055/rdb';
const map = createDemoMap();
export const db = map.sqliteOPFS('orange-sync-demo.sqlite3', {
  busyTimeoutMs: 5000,
  sync: {
    url: syncUrl,
    auto: false
    //  {
    //   intervalMs: 8000,
    //   push: true,
    //   pull: true
    // }
  }
});
