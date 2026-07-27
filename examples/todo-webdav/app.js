const els = {
  baseUrl: document.querySelector('#baseUrl'),
  remotePath: document.querySelector('#remotePath'),
  key: document.querySelector('#key'),
  shareToken: document.querySelector('#shareToken'),
  joinTokenInput: document.querySelector('#joinTokenInput'),
  status: document.querySelector('#status'),
  taskInput: document.querySelector('#taskInput'),
  tasks: document.querySelector('#tasks'),
  newSessionBtn: document.querySelector('#newSessionBtn'),
  connectBtn: document.querySelector('#connectBtn'),
  disconnectBtn: document.querySelector('#disconnectBtn'),
  addTaskBtn: document.querySelector('#addTaskBtn'),
  refreshBtn: document.querySelector('#refreshBtn'),
  applyTokenBtn: document.querySelector('#applyTokenBtn'),
  copyTokenBtn: document.querySelector('#copyTokenBtn'),
  compactBtn: document.querySelector('#compactBtn'),
  compactStatus: document.querySelector('#compactStatus'),
};

// Active page-session handles are installed together after connect and cleared
// together after disconnect.
let runtime = {
  engine: null,
  tasks: null,
  disconnectListener: null,
};

const DEFAULT_BASE_URL = `${location.origin}/__webdav__`;
const credentialEnvelopeRecords = new Map();

async function createTodoCredentialStore(dbName) {
  const mode = new URLSearchParams(location.search).get('credentials') || 'session';
  const {
    MemoryCredentialEnvelopeStore,
    StaticEnvelopeKeyProvider,
    createWebCredentialStore,
  } = await import('/packages/web/dist/index.js');

  if (mode === 'memory') return createWebCredentialStore(dbName, { storage: 'memory' });
  if (mode === 'local') return createWebCredentialStore(dbName, { storage: 'localStorage' });
  if (mode === 'passkey') return createWebCredentialStore(dbName, { storage: 'passkey', displayName: 'Interocitor TODO WebDAV' });
  if (mode === 'memory-envelope') {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    return createWebCredentialStore(dbName, {
      envelope: {
        store: new MemoryCredentialEnvelopeStore(dbName, credentialEnvelopeRecords),
        keyProvider: new StaticEnvelopeKeyProvider(key),
      },
    });
  }

  return createWebCredentialStore(dbName, { storage: 'sessionStorage' });
}

function randomSuffix() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeRemotePath() {
  return `/Interocitor/todo-${randomSuffix()}`;
}

function makeJoinToken(baseUrl, remotePath, keyPassphrase) {
  return JSON.stringify({
    v: 1,
    baseUrl,
    remotePath,
    key: keyPassphrase,
  });
}

function parseJoinToken(raw) {
  const data = JSON.parse(raw);
  if (!data || typeof data !== 'object') throw new Error('Token must be a JSON object');
  if (typeof data.baseUrl !== 'string' || !data.baseUrl) throw new Error('Token missing baseUrl');
  if (typeof data.remotePath !== 'string' || !data.remotePath.startsWith('/')) {
    throw new Error('Token remotePath must start with /');
  }
  if (typeof data.key !== 'string' || !data.key) throw new Error('Token missing key');
  return { baseUrl: data.baseUrl, remotePath: data.remotePath, key: data.key };
}

function setStatus(message) {
  els.status.textContent = message;
}

function applySessionToUi(session) {
  els.baseUrl.value = session.baseUrl;
  els.remotePath.value = session.remotePath;
  els.key.value = session.key;
  els.shareToken.value = makeJoinToken(session.baseUrl, session.remotePath, session.key);

  const encoded = encodeURIComponent(els.shareToken.value);
  history.replaceState(null, '', `${location.pathname}#join=${encoded}`);
}

function readSessionFromUi() {
  const baseUrl = els.baseUrl.value.trim();
  const remotePath = els.remotePath.value.trim();
  const key = els.key.value.trim();

  if (!baseUrl) throw new Error('WebDAV URL is required');
  if (!remotePath.startsWith('/')) throw new Error('Remote path must start with /');
  if (!key) throw new Error('Key passphrase is required');

  return { baseUrl, remotePath, key };
}

function taskRowId() {
  return `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

async function createSession() {
  const { generateKey, keyToPassphrase } = await import('/packages/core/dist/crypto/encryption.js');
  const key = await generateKey();
  const passphrase = await keyToPassphrase(key);

  const session = {
    baseUrl: els.baseUrl.value.trim() || DEFAULT_BASE_URL,
    remotePath: makeRemotePath(),
    key: passphrase,
  };
  applySessionToUi(session);
  setStatus('New session created. Copy token to another tab, then connect.');
  return session;
}

async function connect() {
  const { Interocitor } = await import('/packages/core/dist/index.js');
  const { WebDAVAdapter } = await import('/packages/core/dist/index.js');
  const { PortablePassphraseKeySource } = await import('/packages/core/dist/index.js');
  const { IndexedDbLocalStore } = await import('/packages/web/dist/index.js');

  const session = readSessionFromUi();
  await disconnect();

  const tabDeviceId = sessionStorage.getItem('todo-device-id') || `tab-${randomSuffix()}`;
  sessionStorage.setItem('todo-device-id', tabDeviceId);

  const dbName = `interocitor-todo-${tabDeviceId}`;
  const adapter = new WebDAVAdapter({
    baseUrl: session.baseUrl,
    auth: { username: 'demo', password: 'demo' },
  });

  const engine = new Interocitor(adapter, {
    remotePath: session.remotePath,
    dbName,
    localStore: new IndexedDbLocalStore(dbName),
    keySource: new PortablePassphraseKeySource({
      portableKey: session.key,
      credentialStore: await createTodoCredentialStore(dbName),
    }),
    deviceId: tabDeviceId,
    pollInterval: 5000,   // 5 s: reduces head.json 404 spam during idle periods
    flushDebounce: 200,
    flushThreshold: 50,
  });

  const unsub = engine.on((event) => {
    if (event.type === 'change' || event.type === 'delete' || event.type === 'sync:complete') {
      void refreshTasks();
    }
  });

  await engine.init();
  await engine.connect();

  runtime = {
    engine,
    tasks: engine.table('tasks'),
    disconnectListener: unsub,
  };

  await refreshTasks();
  setStatus(`Connected: ${session.remotePath} as ${tabDeviceId}`);
}

async function disconnect() {
  if (runtime.disconnectListener) {
    runtime.disconnectListener();
  }

  if (runtime.engine) {
    await runtime.engine.disconnect();
  }

  runtime = { engine: null, tasks: null, disconnectListener: null };
}

async function addTask(title) {
  if (!runtime.tasks) throw new Error('Connect first');

  const cleanTitle = title.trim();
  if (!cleanTitle) return;

  const rowId = taskRowId();
  await runtime.tasks.put(rowId, {
    id: rowId,
    title: cleanTitle,
    done: false,
    createdAt: Date.now(),
  });

  if (runtime.engine) {
    await runtime.engine.flush();
  }

  els.taskInput.value = '';
  await refreshTasks();
}

async function toggleTask(id, done) {
  if (!runtime.tasks) throw new Error('Connect first');

  await runtime.tasks.put(id, { done: !done });
  if (runtime.engine) {
    await runtime.engine.flush();
  }
  await refreshTasks();
}

async function removeTask(id) {
  if (!runtime.tasks) throw new Error('Connect first');

  await runtime.tasks.delete(id);
  if (runtime.engine) {
    await runtime.engine.flush();
  }
  await refreshTasks();
}

async function refreshTasks() {
  if (!runtime.tasks) {
    els.tasks.innerHTML = '';
    return [];
  }

  const all = await runtime.tasks.query();
  const sorted = [...all].toSorted((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));

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

    li.append(checkbox);
    li.append(span);
    li.append(del);
    els.tasks.append(li);
  }

  return sorted;
}

async function compact() {
  if (!runtime.engine) throw new Error('Connect first');

  els.compactStatus.textContent = 'Compacting…';
  try {
    await runtime.engine.compact();
    const manifest = runtime.engine.getManifest();
    const gen = manifest?.generation ?? '?';
    els.compactStatus.textContent = `Mainline set at generation ${gen}. New devices will rehydrate from this snapshot.`;
  } catch (err) {
    els.compactStatus.textContent = `Compact failed: ${err.message}`;
    throw err;
  }
}

function applyTokenFromInput() {
  const raw = els.joinTokenInput.value.trim();
  const parsed = parseJoinToken(raw);
  applySessionToUi(parsed);
  setStatus('Token applied. Click Connect.');
  return parsed;
}

async function copyToken() {
  const token = els.shareToken.value;
  if (!token) return false;

  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(token);
    setStatus('Token copied to clipboard.');
    return true;
  }

  setStatus('Clipboard API unavailable. Copy token manually.');
  return false;
}

function tryApplyTokenFromHash() {
  const hash = location.hash.startsWith('#') ? location.hash.slice(1) : '';
  const params = new URLSearchParams(hash);
  const joined = params.get('join');
  if (!joined) return false;

  try {
    const parsed = parseJoinToken(joined);
    applySessionToUi(parsed);
    setStatus('Session loaded from URL hash. Click Connect.');
    return true;
  } catch (error) {
    setStatus(`Invalid URL token: ${error.message}`);
    return false;
  }
}

els.baseUrl.value = DEFAULT_BASE_URL;

els.newSessionBtn.addEventListener('click', () => {
  void createSession().catch((error) => setStatus(`New session failed: ${error.message}`));
});
els.connectBtn.addEventListener('click', () => {
  void connect().catch((error) => setStatus(`Connect failed: ${error.message}`));
});
els.disconnectBtn.addEventListener('click', () => {
  void disconnect().then(() => setStatus('Disconnected.')).catch((error) => setStatus(`Disconnect failed: ${error.message}`));
});
els.addTaskBtn.addEventListener('click', () => {
  void addTask(els.taskInput.value).catch((error) => setStatus(`Add failed: ${error.message}`));
});
els.refreshBtn.addEventListener('click', () => {
  void refreshTasks().catch((error) => setStatus(`Refresh failed: ${error.message}`));
});
els.applyTokenBtn.addEventListener('click', () => {
  try {
    applyTokenFromInput();
  } catch (error) {
    setStatus(`Apply token failed: ${error.message}`);
  }
});
els.copyTokenBtn.addEventListener('click', () => {
  void copyToken().catch((error) => setStatus(`Copy failed: ${error.message}`));
});
els.compactBtn.addEventListener('click', () => {
  void compact().catch((error) => setStatus(`Compact failed: ${error.message}`));
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
  getShareToken() {
    return els.shareToken.value;
  },
  getSession() {
    return readSessionFromUi();
  },
};

if (!tryApplyTokenFromHash()) {
  void createSession().catch((error) => setStatus(`Init failed: ${error.message}`));
}

window.addEventListener('beforeunload', () => {
  void disconnect();
});
