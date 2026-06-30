import rdb from 'orange-orm';
import { createDemoMap, demoCommands } from '../../shared/schema.js';

const params = new URL(globalThis.location.href).searchParams;
const localDbName = params.get('db') || 'orange-sync-demo_vfs2.sqlite3';
const syncUrl = params.get('syncUrl') || ('http://' + globalThis.location.hostname + ':8080/rdb');
const busyTimeoutMs = parsePositiveInteger(params.get('busyTimeoutMs'), 5000);
const map = createDemoMap(rdb);
const ports = new Set();

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

const handler = rdb.createSharedDbWorkerHandler(() => db, { autoConnect: false });

rdb.on('sqliteOpen', (payload) => {
  broadcastDiagnostic('sqliteOpen', {
    ...payload,
    localDbName,
    workerSupport: typeof Worker !== 'undefined',
    sharedArrayBufferSupport: typeof SharedArrayBuffer !== 'undefined',
    crossOriginIsolated: globalThis.crossOriginIsolated === true
  });
});

globalThis.addEventListener('connect', (event) => {
  const port = event.ports && event.ports[0];
  if (port) {
    ports.add(port);
    port.addEventListener('message', (messageEvent) => {
      if (messageEvent.data && messageEvent.data.type === 'orange-shared-db-port-close')
        ports.delete(port);
    });
  }
  handler.handleConnect(event);
});

function broadcastDiagnostic(event, payload) {
  for (const port of Array.from(ports)) {
    try {
      port.postMessage({
        type: 'orange-demo-diagnostic',
        event,
        payload
      });
    }
    catch (_e) {
      ports.delete(port);
    }
  }
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
