import rdb from 'orange-orm';
import { createDemoMap, demoCommands } from '../../shared/schema.js';

const params = new URL(globalThis.location.href).searchParams;
const localDbName = params.get('db') || 'orange-sync-demo_vfs2.sqlite3';
const syncUrl = params.get('syncUrl') || '/rdb';
const busyTimeoutMs = parsePositiveInteger(params.get('busyTimeoutMs'), 5000);
const map = createDemoMap(rdb);

safePostDiagnostic('worker-script-start', {
  localDbName,
  syncUrl,
  busyTimeoutMs
});

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

const globalHandler = rdb.createDbWorkerHandler(db, { autoStart: false });

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
  const message = event && event.data;
  if (message && message.type === 'orange-demo-connect-db-port') {
    connectPort(event.ports && event.ports[0]);
    return;
  }
  if (message && message.type === 'orange-demo-db-port-close') {
    globalHandler.stop();
    return;
  }
  void globalHandler.handleMessage(event);
});

function connectPort(port) {
  if (!port)
    return;
  const handler = rdb.createDbWorkerHandler(db, {
    autoStart: false,
    postMessage: (message) => safePostPort(port, message)
  });
  port.addEventListener('message', (messageEvent) => {
    const message = messageEvent && messageEvent.data;
    if (message && message.type === 'orange-demo-db-port-close') {
      handler.stop();
      if (typeof port.close === 'function')
        port.close();
      return;
    }
    void handler.handleMessage(messageEvent);
  });
  if (typeof port.start === 'function')
    port.start();
}

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
  globalThis.postMessage({
    type: 'orange-demo-diagnostic',
    event,
    payload
  });
}

function safePostPort(port, message) {
  try {
    port.postMessage(message);
  }
  catch (_e) {}
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
