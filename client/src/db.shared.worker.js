const states = new Map();
const pending = new Map();
const activationTimeoutMs = 8000;
let activeState = null;
let nextRelayId = 1;
let nextTransactionId = 1;

globalThis.addEventListener('connect', (event) => {
  const port = event.ports && event.ports[0];
  if (!port)
    return;

  const state = {
    port,
    dbPort: null,
    closed: false,
    backlog: [],
    transactions: new Map()
  };
  states.set(port, state);
  port.addEventListener('message', (messageEvent) => handlePageMessage(state, messageEvent));
  if (typeof port.start === 'function')
    port.start();
  requestActiveDbPort();
});

function handlePageMessage(state, event) {
  const message = event && event.data;
  if (!message)
    return;

  if (message.type === 'orange-demo-register-db-port') {
    attachDbPort(state, event.ports && event.ports[0]);
    return;
  }

  if (message.type === 'orange-demo-db-port-open-error') {
    failActivation(state, message.error || {
      name: 'Error',
      message: 'Dedicated DB worker failed to open.'
    });
    return;
  }

  if (message.type === 'orange-shared-db-port-close' || message.type === 'orange-demo-db-port-close') {
    closeState(state);
    return;
  }

  if (message.type !== 'orange-db-request')
    return;

  forwardRequest(state, message);
}

function attachDbPort(state, dbPort) {
  if (!dbPort || typeof dbPort.postMessage !== 'function')
    return;
  if (activeState && activeState !== state) {
    safePost(dbPort, { type: 'orange-demo-db-port-close' });
    if (typeof dbPort.close === 'function')
      dbPort.close();
    return;
  }
  clearActivationTimer(state);
  state.dbPort = dbPort;
  state.activationRequested = false;
  dbPort.addEventListener('message', (event) => handleDbMessage(state, event));
  if (typeof dbPort.start === 'function')
    dbPort.start();
  activeState = state;
  drainBacklog();
}

function forwardRequest(sourceState, message) {
  if (!activeState || !activeState.dbPort) {
    sourceState.backlog.push(message);
    requestActiveDbPort();
    return;
  }

  const relayId = nextRelayId++;
  const relayMessage = {
    ...message,
    id: relayId
  };

  if (message.transactionId !== undefined)
    relayMessage.transactionId = getRelayTransactionId(sourceState, message);

  pending.set(relayId, {
    sourceState,
    dbState: activeState,
    originalId: message.id,
    originalTransactionId: message.transactionId,
    method: message.method
  });

  activeState.dbPort.postMessage(relayMessage);
}

function getRelayTransactionId(state, message) {
  const key = String(message.transactionId);
  if (message.method === 'transaction.begin' && !state.transactions.has(key))
    state.transactions.set(key, nextTransactionId++);
  return state.transactions.get(key) || message.transactionId;
}

function handleDbMessage(dbState, event) {
  const message = event && event.data;
  if (!message)
    return;

  if (message.type === 'orange-db-event') {
    broadcast(message);
    return;
  }

  if (message.type !== 'orange-db-response')
    return;

  const entry = pending.get(message.id);
  if (!entry)
    return;
  pending.delete(message.id);

  if (entry.method === 'transaction.commit' || entry.method === 'transaction.rollback')
    entry.sourceState.transactions.delete(String(entry.originalTransactionId));

  safePost(entry.sourceState.port, {
    ...message,
    id: entry.originalId
  });
}

function closeState(state) {
  if (!state || state.closed)
    return;
  state.closed = true;
  states.delete(state.port);
  if (state.dbPort) {
    safePost(state.dbPort, { type: 'orange-demo-db-port-close' });
    if (typeof state.dbPort.close === 'function')
      state.dbPort.close();
  }
  clearActivationTimer(state);
  dropPendingForSource(state);
  rejectPendingForState(state);
  if (activeState === state)
    activeState = nextActiveState();
  if (!activeState)
    requestActiveDbPort();
  drainBacklog();
  if (typeof state.port.close === 'function')
    state.port.close();
}

function nextActiveState() {
  for (const state of states.values()) {
    if (!state.closed && state.dbPort)
      return state;
  }
  return null;
}

function dropPendingForSource(sourceState) {
  for (const [relayId, entry] of Array.from(pending)) {
    if (entry.sourceState === sourceState)
      pending.delete(relayId);
  }
}

function rejectPendingForState(dbState, error) {
  for (const [relayId, entry] of Array.from(pending)) {
    if (entry.dbState !== dbState)
      continue;
    pending.delete(relayId);
    safePost(entry.sourceState.port, {
      type: 'orange-db-response',
      id: entry.originalId,
      error: normalizeError(error || {
        name: 'Error',
        message: 'Shared DB worker lost its active DB port.'
      })
    });
  }
}

function failBacklog(state, error) {
  const backlog = state.backlog.splice(0);
  for (let i = 0; i < backlog.length; i++) {
    const message = backlog[i];
    if (!message || message.type !== 'orange-db-request')
      continue;
    safePost(state.port, {
      type: 'orange-db-response',
      id: message.id,
      error: normalizeError(error)
    });
  }
}

function drainBacklog() {
  if (!activeState || !activeState.dbPort)
    return;
  for (const state of states.values()) {
    const backlog = state.backlog.splice(0);
    for (const message of backlog)
      forwardRequest(state, message);
  }
}

function requestActiveDbPort() {
  if (activeState && activeState.dbPort)
    return;
  const state = nextActivatableState();
  if (!state || state.activationRequested)
    return;
  activeState = state;
  state.activationRequested = true;
  state.activationTimer = setTimeout(() => {
    failActivation(state, {
      name: 'Error',
      message: 'Dedicated DB worker did not register its DB port within 8 seconds.'
    });
  }, activationTimeoutMs);
  safePost(state.port, { type: 'orange-demo-start-db-worker' });
}

function failActivation(state, error) {
  if (!state || state.closed || state.dbPort)
    return;
  clearActivationTimer(state);
  state.activationRequested = false;
  if (activeState === state)
    activeState = null;
  failBacklog(state, error);
  rejectPendingForState(state, error);
}

function clearActivationTimer(state) {
  if (!state || !state.activationTimer)
    return;
  clearTimeout(state.activationTimer);
  state.activationTimer = null;
}

function nextActivatableState() {
  for (const state of states.values()) {
    if (!state.closed)
      return state;
  }
  return null;
}

function broadcast(message) {
  for (const state of states.values())
    safePost(state.port, message);
}

function safePost(port, message) {
  try {
    port.postMessage(message);
  }
  catch (_e) {}
}

function normalizeError(error) {
  return {
    name: error && error.name || 'Error',
    message: error && error.message ? error.message : String(error || 'Shared DB worker failed.'),
    stack: error && error.stack
  };
}
