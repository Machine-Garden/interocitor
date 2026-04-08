const els = {
  workerBaseUrl: document.getElementById('workerBaseUrl'),
  namespace: document.getElementById('namespace'),
  remotePath: document.getElementById('remotePath'),
  token: document.getElementById('token'),
  key: document.getElementById('key'),
  shareToken: document.getElementById('shareToken'),
  joinTokenInput: document.getElementById('joinTokenInput'),
  status: document.getElementById('status'),
  taskInput: document.getElementById('taskInput'),
  tasks: document.getElementById('tasks'),
  newSessionBtn: document.getElementById('newSessionBtn'),
  connectBtn: document.getElementById('connectBtn'),
  disconnectBtn: document.getElementById('disconnectBtn'),
  addTaskBtn: document.getElementById('addTaskBtn'),
  refreshBtn: document.getElementById('refreshBtn'),
  applyTokenBtn: document.getElementById('applyTokenBtn'),
  copyTokenBtn: document.getElementById('copyTokenBtn'),
  compactBtn: document.getElementById('compactBtn'),
  compactStatus: document.getElementById('compactStatus'),
};

let runtime = {
  engine: null,
  tasks: null,
  unsubEngine: null,
  unsubSse: null,
  sseReady: Promise.resolve(false),
  eventLog: [],
};

let runtimeOptions = {
  pollInterval: 15000,
};

function setStatus(message) {
  els.status.textContent = message;
}

function randomSuffix() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeJoinToken(session) {
  return JSON.stringify({ v: 1, ...session });
}

function parseJoinToken(raw) {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') throw new Error('Token must be a JSON object');
  if (typeof parsed.workerBaseUrl !== 'string' || !parsed.workerBaseUrl) throw new Error('Token missing workerBaseUrl');
  if (typeof parsed.namespace !== 'string' || !parsed.namespace) throw new Error('Token missing namespace');
  if (typeof parsed.remotePath !== 'string' || !parsed.remotePath.startsWith('/')) throw new Error('Token invalid remotePath');
  if (typeof parsed.key !== 'string' || !parsed.key) throw new Error('Token missing key');
  return {
    workerBaseUrl: parsed.workerBaseUrl,
    namespace: parsed.namespace,
    remotePath: parsed.remotePath,
    token: typeof parsed.token === 'string' ? parsed.token : '',
    key: parsed.key,
  };
}

function applySessionToUi(session) {
  els.workerBaseUrl.value = session.workerBaseUrl;
  els.namespace.value = session.namespace;
  els.remotePath.value = session.remotePath;
  els.token.value = session.token || '';
  els.key.value = session.key;
  els.shareToken.value = makeJoinToken(session);
}

function readSessionFromUi() {
  const workerBaseUrl = els.workerBaseUrl.value.trim().replace(/\/$/, '');
  const namespace = els.namespace.value.trim();
  const remotePath = els.remotePath.value.trim();
  const token = els.token.value.trim();
  const key = els.key.value.trim();

  if (!workerBaseUrl) throw new Error('Worker URL is required');
  if (!namespace) throw new Error('Namespace is required');
  if (!remotePath.startsWith('/')) throw new Error('Remote path must start with /');
  if (!key) throw new Error('Key passphrase is required');

  return { workerBaseUrl, namespace, remotePath, token, key };
}

function taskRowId() {
  return `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

async function buildSession(overrides = {}) {
  const { generateKey, keyToPassphrase } = await import('../../packages/interocitor/dist/crypto/keys.js');
  const key = await generateKey();
  const passphrase = await keyToPassphrase(key);

  return {
    workerBaseUrl: overrides.workerBaseUrl || els.workerBaseUrl.value.trim() || 'http://127.0.0.1:8787',
    namespace: overrides.namespace || els.namespace.value.trim() || 'team-a',
    remotePath: overrides.remotePath || els.remotePath.value.trim() || '/todo-app',
    token: overrides.token ?? els.token.value.trim(),
    key: passphrase,
  };
}

async function createSession(overrides = {}) {
  const session = await buildSession(overrides);
  applySessionToUi(session);
  setStatus('New session created. Copy token to another tab, then connect.');
  return session;
}

async function autoCreateSession() {
  const snapshot = {
    workerBaseUrl: els.workerBaseUrl.value,
    namespace: els.namespace.value,
    remotePath: els.remotePath.value,
    token: els.token.value,
    key: els.key.value,
    shareToken: els.shareToken.value,
    joinTokenInput: els.joinTokenInput.value,
  };

  const session = await buildSession();
  const unchanged =
    els.workerBaseUrl.value === snapshot.workerBaseUrl &&
    els.namespace.value === snapshot.namespace &&
    els.remotePath.value === snapshot.remotePath &&
    els.token.value === snapshot.token &&
    els.key.value === snapshot.key &&
    els.shareToken.value === snapshot.shareToken &&
    els.joinTokenInput.value === snapshot.joinTokenInput;

  if (!unchanged) return null;

  applySessionToUi(session);
  setStatus('New session created. Copy token to another tab, then connect.');
  return session;
}

async function connect() {
  const { SyncEngine } = await import('../../packages/interocitor/dist/index.js');
  const { CloudflareAdapter } = await import('../../packages/interocitor/dist/adapters/cloudflare.js');
  const { passphraseToKey } = await import('../../packages/interocitor/dist/crypto/keys.js');

  const session = readSessionFromUi();
  await disconnect();

  const adapter = new CloudflareAdapter({
    baseUrl: `${session.workerBaseUrl}/io/${encodeURIComponent(session.namespace)}`,
    token: session.token || undefined,
  });

  const tabDeviceId = sessionStorage.getItem('todo-cf-device-id') || `tab-${randomSuffix()}`;
  sessionStorage.setItem('todo-cf-device-id', tabDeviceId);
  localStorage.setItem('interocitor-device-id', tabDeviceId);

  const engine = new SyncEngine(adapter, {
    remotePath: session.remotePath,
    dbName: `interocitor-cf-${tabDeviceId}`,
    pollInterval: runtimeOptions.pollInterval,
    flushDebounce: 200,
    flushThreshold: 1,
  });

  engine.setEncryptionKey(await passphraseToKey(session.key));

  const eventLog = [];
  const unsubEngine = engine.on((event) => {
    eventLog.push({ type: event.type, ts: Date.now() });
    if (event.type === 'change' || event.type === 'delete' || event.type === 'sync:complete') {
      void refreshTasks();
    }
  });

  await engine.init();
  await engine.connect();

  let unsubSse = null;
  let sseReadyResolve;
  const sseReady = new Promise((resolve) => {
    sseReadyResolve = resolve;
  });
  if (typeof adapter.subscribeToInvalidations === 'function') {
    unsubSse = adapter.subscribeToInvalidations(() => {
      void engine.pull().then(() => refreshTasks()).catch(() => {});
    }, {
      onReady: () => {
        eventLog.push({ type: 'sse:ready', ts: Date.now() });
        sseReadyResolve?.(true);
      },
      onError: () => {
        eventLog.push({ type: 'sse:error', ts: Date.now() });
      },
    });
  } else {
    sseReadyResolve?.(false);
  }

  runtime = {
    engine,
    tasks: engine.table('tasks'),
    unsubEngine,
    unsubSse,
    sseReady,
    eventLog,
  };

  await refreshTasks();
  setStatus(`Connected: ${session.namespace}${session.remotePath} as ${tabDeviceId}`);
}

async function disconnect() {
  if (runtime.unsubEngine) runtime.unsubEngine();
  if (runtime.unsubSse) runtime.unsubSse();
  if (runtime.engine) await runtime.engine.disconnect();
  runtime = { engine: null, tasks: null, unsubEngine: null, unsubSse: null, sseReady: Promise.resolve(false), eventLog: [] };
}

async function addTask(title) {
  if (!runtime.tasks) throw new Error('Connect first');
  const cleanTitle = title.trim();
  if (!cleanTitle) return;

  const id = taskRowId();
  await runtime.tasks.put(id, {
    id,
    title: cleanTitle,
    done: false,
    createdAt: Date.now(),
  });

  if (runtime.engine) await runtime.engine.flush();
  els.taskInput.value = '';
  await refreshTasks();
}

async function toggleTask(id, done) {
  if (!runtime.tasks) throw new Error('Connect first');
  await runtime.tasks.put(id, { done: !done });
  if (runtime.engine) await runtime.engine.flush();
  await refreshTasks();
}

async function removeTask(id) {
  if (!runtime.tasks) throw new Error('Connect first');
  await runtime.tasks.delete(id);
  if (runtime.engine) await runtime.engine.flush();
  await refreshTasks();
}

async function refreshTasks() {
  if (!runtime.tasks) {
    els.tasks.innerHTML = '';
    return [];
  }

  const all = await runtime.tasks.query();
  const sorted = [...all].sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));

  els.tasks.innerHTML = '';
  for (const item of sorted) {
    const li = document.createElement('li');

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = Boolean(item.done);
    checkbox.addEventListener('change', () => {
      void toggleTask(String(item.id || ''), Boolean(item.done));
    });

    const span = document.createElement('span');
    span.textContent = ` ${String(item.title || '(untitled)')} `;
    span.style.textDecoration = item.done ? 'line-through' : 'none';

    const del = document.createElement('button');
    del.textContent = 'Delete';
    del.addEventListener('click', () => {
      void removeTask(String(item.id || ''));
    });

    li.appendChild(checkbox);
    li.appendChild(span);
    li.appendChild(del);
    els.tasks.appendChild(li);
  }

  return sorted;
}

async function compact() {
  if (!runtime.engine) throw new Error('Connect first');
  els.compactStatus.textContent = 'Compacting...';
  await runtime.engine.compact();
  const manifest = runtime.engine.getManifest();
  const gen = manifest?.generation ?? '?';
  els.compactStatus.textContent = `Mainline set at generation ${gen}.`;
}

function applyTokenFromInput() {
  const parsed = parseJoinToken(els.joinTokenInput.value.trim());
  applySessionToUi(parsed);
  setStatus('Token applied. Click Connect.');
}

async function copyToken() {
  const token = els.shareToken.value;
  if (!token) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(token);
    setStatus('Token copied to clipboard.');
    return;
  }
  setStatus('Clipboard API unavailable. Copy token manually.');
}

els.newSessionBtn.addEventListener('click', () => {
  void createSession().catch((e) => setStatus(`New session failed: ${e.message}`));
});
els.connectBtn.addEventListener('click', () => {
  void connect().catch((e) => setStatus(`Connect failed: ${e.message}`));
});
els.disconnectBtn.addEventListener('click', () => {
  void disconnect().then(() => setStatus('Disconnected.')).catch((e) => setStatus(`Disconnect failed: ${e.message}`));
});
els.addTaskBtn.addEventListener('click', () => {
  void addTask(els.taskInput.value).catch((e) => setStatus(`Add failed: ${e.message}`));
});
els.refreshBtn.addEventListener('click', () => {
  void refreshTasks().catch((e) => setStatus(`Refresh failed: ${e.message}`));
});
els.applyTokenBtn.addEventListener('click', () => {
  try {
    applyTokenFromInput();
  } catch (e) {
    setStatus(`Apply token failed: ${e.message}`);
  }
});
els.copyTokenBtn.addEventListener('click', () => {
  void copyToken().catch((e) => setStatus(`Copy failed: ${e.message}`));
});
els.compactBtn.addEventListener('click', () => {
  void compact().catch((e) => setStatus(`Compact failed: ${e.message}`));
});

window.__todoDemo = {
  createSession,
  applyToken(raw) {
    const parsed = parseJoinToken(raw);
    applySessionToUi(parsed);
    return parsed;
  },
  connect,
  disconnect,
  addTask,
  refreshTasks,
  compact,
  configure(options = {}) {
    if (typeof options.pollInterval === 'number' && Number.isFinite(options.pollInterval) && options.pollInterval > 0) {
      runtimeOptions.pollInterval = options.pollInterval;
    }
    return { ...runtimeOptions };
  },
  getShareToken() {
    return els.shareToken.value;
  },
  getSession() {
    return readSessionFromUi();
  },
  getStatus() {
    return els.status.textContent || '';
  },
  async waitForSseReady(timeoutMs = 3000) {
    return await Promise.race([
      runtime.sseReady,
      new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
  },
  getEventTypes() {
    return runtime.eventLog.map((event) => event.type);
  },
  clearEvents() {
    runtime.eventLog.length = 0;
  },
  async waitForEvent(type, timeoutMs = 3000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (runtime.eventLog.some((event) => event.type === type)) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return runtime.eventLog.some((event) => event.type === type);
  },
};

window.addEventListener('beforeunload', () => {
  void disconnect();
});

void autoCreateSession().catch((e) => setStatus(`Init failed: ${e.message}`));

``
