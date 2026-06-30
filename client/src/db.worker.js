import rdb from 'orange-orm';
import { createDemoMap, demoCommands } from '../../shared/schema.js';

const params = new URL(globalThis.location.href).searchParams;
const localDbName = params.get('db') || 'orange-sync-demo_vfs2.sqlite3';
const syncUrl = params.get('syncUrl') || '/rdb';
const busyTimeoutMs = parsePositiveInteger(params.get('busyTimeoutMs'), 5000);
const map = createDemoMap(rdb);

const db = map({
  db: (con) => con.sqliteOPFS(localDbName, {
    busyTimeoutMs,
    inlineWorker: true,
    sync: {
      url: syncUrl,
      auto: false
    }
  }),
  commands: demoCommands
});

const handler = rdb.createDbWorkerHandler(db, { autoStart: false });

rdb.on('sqliteOpen', (payload) => {
  safePostDiagnostic('sqliteOpen', {
    ...payload,
    localDbName,
    ...environmentDiagnostics()
  });
});

safePostDiagnostic('environment', {
  localDbName,
  ...environmentDiagnostics()
});

globalThis.addEventListener('message', (event) => {
  void handler.handleMessage(event);
});

function environmentDiagnostics() {
  return {
    workerSupport: typeof Worker !== 'undefined',
    sharedArrayBufferSupport: typeof SharedArrayBuffer !== 'undefined',
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    opfsApiSupport: hasOpfsApiSupport()
  };
}

function hasOpfsApiSupport() {
  return !!(
    globalThis.FileSystemHandle
    && globalThis.FileSystemDirectoryHandle
    && globalThis.FileSystemFileHandle
    && globalThis.FileSystemFileHandle.prototype.createSyncAccessHandle
    && globalThis.navigator
    && globalThis.navigator.storage
    && globalThis.navigator.storage.getDirectory
  );
}

function safePostDiagnostic(event, payload) {
  try {
    globalThis.postMessage({
      type: 'orange-demo-diagnostic',
      event,
      payload
    });
  }
  catch (_e) {
    // The page may have gone away while the worker is still shutting down.
  }
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
