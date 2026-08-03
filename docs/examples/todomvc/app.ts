import {
  Interocitor,
  MemoryAdapter,
  MemoryLocalStore,
  types,
  type DatabaseSchemaDefinition,
} from "../../../packages/core/src/index.ts";

type Todo = {
  id: string;
  title: string;
  done: boolean;
  createdAt: number;
};

type DB = { todos: Todo };
type Filter = "all" | "active" | "completed";
type ClientId = "client-1" | "client-2" | "client-3";

const schema = {
  tables: {
    todos: {
      fields: {
        id: types.string,
        title: types.string,
        done: types.boolean,
        createdAt: types.index(types.number),
      },
    },
  },
} satisfies DatabaseSchemaDefinition<DB>;

function required<T extends Element>(selector: string, root: ParentNode = document): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`Missing required element: ${selector}`);
  return found;
}

const memory = new MemoryAdapter();

function createDatabase(id: ClientId): Interocitor<DB> {
  return new Interocitor<DB>(memory, {
    dbName: `interocitor-public-todomvc-${id}`,
    remotePath: "/TodoMVC",
    localStore: new MemoryLocalStore(),
    keySource: null,
    schema,
    batchWindowMs: 0,
    flushDebounce: 3_600_000,
    pollInterval: 3_600_000,
    autoCompact: false,
  });
}

type Client = {
  id: ClientId;
  label: string;
  root: HTMLElement;
  db: Interocitor<DB>;
  todos: ReturnType<Interocitor<DB>["table"]>;
  filter: Filter;
  connected: boolean;
};

function createClient(id: ClientId, label: string): Client {
  const db = createDatabase(id);
  return {
    id,
    label,
    root: required<HTMLElement>(`[data-client="${id}"]`),
    db,
    todos: db.table("todos"),
    filter: "all",
    connected: false,
  };
}

const client1 = createClient("client-1", "Client 1");
const client2 = createClient("client-2", "Client 2");
const clients: Client[] = [client1, client2];
let client3: Client | undefined;

const meshStatus = required<HTMLElement>("#mesh-status");
const filesystemTree = required<HTMLElement>("#filesystem-tree");
const selectedFileLabel = required<HTMLElement>("#selected-file-path");
const filePreview = required<HTMLPreElement>("#file-preview");
const compactButton = required<HTMLButtonElement>("#compact-demo");
const addClientControl = required<HTMLElement>("#add-client-control");
const addClientButton = required<HTMLButtonElement>("#add-client-demo");
const resetButton = required<HTMLButtonElement>("#reset-demo");

let mutationQueue = Promise.resolve();
let selectedFilePath: string | null = null;
let compacting = false;

function getClient(id: ClientId): Client {
  const client = clients.find((candidate) => candidate.id === id);
  if (!client) throw new Error(`${id} has not been added to the demo`);
  return client;
}

function connectionButton(client: Client): HTMLButtonElement {
  return required<HTMLButtonElement>("[data-connection-toggle]", client.root);
}

function updateConnectionUi(client: Client): void {
  const button = connectionButton(client);
  const status = required<HTMLElement>("[data-client-status]", client.root);
  client.root.classList.toggle("is-disconnected", !client.connected);
  status.textContent = client.connected ? "Ready" : "Offline (simulated)";
  button.textContent = client.connected ? "Disconnect" : "Reconnect";
  button.setAttribute("aria-pressed", String(!client.connected));
  button.setAttribute(
    "aria-label",
    `${client.connected ? "Simulate disconnect for" : "Reconnect"} ${client.label}`,
  );
  button.disabled = false;
  updateCompactAvailability();
}

function updateCompactAvailability(): void {
  const allConnected = clients.every((client) => client.connected);
  compactButton.disabled = compacting || !allConnected;
  compactButton.title = allConnected
    ? "Publish a snapshot and remove the change files it covers"
    : "Reconnect every client before compacting";
}

function visibleTodos(client: Client, all: Todo[]): Todo[] {
  if (client.filter === "active") return all.filter((todo) => !todo.done);
  if (client.filter === "completed") return all.filter((todo) => todo.done);
  return all;
}

type FilesystemNode = {
  directories: Map<string, FilesystemNode>;
  files: string[];
};

function newFilesystemNode(): FilesystemNode {
  return { directories: new Map(), files: [] };
}

function formatFile(contents: string): string {
  const trimmed = contents.trim();
  if (!trimmed) return "(empty file)";

  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    const formattedLines = trimmed.split("\n").map((line) => {
      try {
        return JSON.stringify(JSON.parse(line), null, 2);
      } catch {
        return line;
      }
    });
    return formattedLines.join("\n").slice(0, 12_000);
  }
}

function showFile(path: string, files: Record<string, string>): void {
  selectedFilePath = path;
  selectedFileLabel.textContent = path;
  filePreview.textContent = formatFile(files[path] ?? "");

  filesystemTree.querySelectorAll<HTMLButtonElement>("[data-file-path]").forEach((button) => {
    button.setAttribute("aria-current", String(button.dataset.filePath === path));
  });
}

function renderFilesystem(preferredPath?: string, newPaths = new Set<string>()): void {
  const files = memory.dump();
  const paths = Object.keys(files).toSorted();
  const root = newFilesystemNode();

  for (const path of paths) {
    const parts = path.split("/").filter(Boolean);
    const filename = parts.pop();
    if (!filename) continue;

    let node = root;
    for (const directory of parts) {
      let child = node.directories.get(directory);
      if (!child) {
        child = newFilesystemNode();
        node.directories.set(directory, child);
      }
      node = child;
    }
    node.files.push(filename);
  }

  function nodeList(node: FilesystemNode, parentPath: string): HTMLUListElement {
    const list = document.createElement("ul");

    for (const [name, child] of [...node.directories].toSorted(([a], [b]) => a.localeCompare(b))) {
      const item = document.createElement("li");
      const label = document.createElement("span");
      const path = `${parentPath}/${name}`;
      label.className = "filesystem-directory";
      label.textContent = name;
      item.append(label, nodeList(child, path));
      list.append(item);
    }

    for (const name of node.files.toSorted()) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      const path = `${parentPath}/${name}`;
      button.className = `filesystem-file${newPaths.has(path) ? " is-new" : ""}`;
      button.type = "button";
      button.textContent = name;
      button.dataset.filePath = path;
      button.title = path;
      button.addEventListener("click", () => showFile(path, files));
      item.append(button);
      list.append(item);
    }

    return list;
  }

  filesystemTree.replaceChildren(nodeList(root, ""));

  const nextSelection =
    (preferredPath && files[preferredPath] !== undefined && preferredPath) ||
    (selectedFilePath && files[selectedFilePath] !== undefined && selectedFilePath) ||
    (files["/TodoMVC/manifest.json"] !== undefined && "/TodoMVC/manifest.json") ||
    paths[0];

  if (nextSelection) showFile(nextSelection, files);
  meshStatus.textContent = `${paths.length} ${paths.length === 1 ? "file" : "files"} in this tab`;
}

function taskElement(client: Client, todo: Todo): HTMLLIElement {
  const item = document.createElement("li");
  item.className = `todo-item${todo.done ? " completed" : ""}`;

  const toggle = document.createElement("input");
  toggle.className = "todo-toggle";
  toggle.type = "checkbox";
  toggle.checked = todo.done;
  toggle.setAttribute(
    "aria-label",
    `${todo.done ? "Mark active" : "Mark complete"}: ${todo.title}`,
  );
  toggle.addEventListener("change", () => {
    runMutation(client, `${toggle.checked ? "completed" : "reopened"} “${todo.title}”`, () =>
      client.todos.patch(todo.id, { done: toggle.checked }),
    );
  });

  const title = document.createElement("span");
  title.className = "todo-title";
  title.textContent = todo.title;
  title.title = "Double-click to edit";
  title.addEventListener("dblclick", () => beginEdit(client, todo, title));

  const destroy = document.createElement("button");
  destroy.className = "destroy";
  destroy.type = "button";
  destroy.textContent = "×";
  destroy.setAttribute("aria-label", `Delete ${todo.title}`);
  destroy.addEventListener("click", () => {
    runMutation(client, `deleted “${todo.title}”`, () => client.todos.delete(todo.id));
  });

  item.append(toggle, title, destroy);
  return item;
}

function beginEdit(client: Client, todo: Todo, title: HTMLSpanElement): void {
  const editor = document.createElement("input");
  editor.className = "edit-input";
  editor.type = "text";
  editor.value = todo.title;
  editor.maxLength = 240;
  editor.setAttribute("aria-label", `Edit ${todo.title}`);
  title.replaceWith(editor);
  editor.focus();
  editor.select();

  let settled = false;
  const finish = (save: boolean) => {
    if (settled) return;
    settled = true;
    const nextTitle = editor.value.trim();
    if (save && nextTitle && nextTitle !== todo.title) {
      runMutation(client, `renamed “${todo.title}”`, () =>
        client.todos.patch(todo.id, { title: nextTitle }),
      );
      return;
    }
    void renderClient(client);
  };

  editor.addEventListener("blur", () => finish(true));
  editor.addEventListener("keydown", (event) => {
    if (event.key === "Enter") editor.blur();
    if (event.key === "Escape") finish(false);
  });
}

async function renderClient(client: Client): Promise<void> {
  const all = (await client.todos.query()).toSorted((a, b) => a.createdAt - b.createdAt);
  const visible = visibleTodos(client, all);
  const active = all.filter((todo) => !todo.done).length;
  const main = required<HTMLElement>("[data-todo-main]", client.root);
  const footer = required<HTMLElement>("[data-todo-footer]", client.root);
  const list = required<HTMLUListElement>("[data-todo-list]", client.root);
  const count = required<HTMLElement>("[data-todo-count]", client.root);
  const toggleAll = required<HTMLButtonElement>("[data-toggle-all]", client.root);
  const clearCompleted = required<HTMLButtonElement>("[data-clear-completed]", client.root);

  list.replaceChildren(...visible.map((todo) => taskElement(client, todo)));
  main.hidden = all.length === 0;
  footer.hidden = all.length === 0;
  count.innerHTML = `<strong>${active}</strong> ${active === 1 ? "item" : "items"} left`;
  toggleAll.classList.toggle("complete", all.length > 0 && active === 0);
  clearCompleted.hidden = !all.some((todo) => todo.done);
}

async function renderAll(): Promise<void> {
  await Promise.all(clients.map((client) => renderClient(client)));
}

function runMutation(client: Client, description: string, mutate: () => Promise<unknown>): void {
  mutationQueue = mutationQueue
    .then(async () => {
      const beforePaths = new Set(Object.keys(memory.dump()));
      meshStatus.textContent = `${client.label} ${description}`;

      await mutate();
      await renderClient(client);

      if (!client.connected) {
        meshStatus.textContent = `${client.label} offline · change queued locally`;
        return;
      }

      await client.db.flush();
      const afterPaths = Object.keys(memory.dump());
      const newPaths = new Set(afterPaths.filter((path) => !beforePaths.has(path)));
      const latestChange =
        [...newPaths].find((path) => path.includes("-chg_")) ??
        [...newPaths].at(-1) ??
        "/TodoMVC/changes/head.json";
      renderFilesystem(latestChange, newPaths);

      const peers = clients.filter((peer) => peer !== client && peer.connected);
      for (const peer of peers) await peer.db.pull();
      await renderAll();
      renderFilesystem(latestChange);
      const offlinePeers = clients.filter((peer) => peer !== client && !peer.connected);
      if (offlinePeers.length > 0) {
        meshStatus.textContent = `${offlinePeers.map((peer) => peer.label).join(" and ")} offline · file waiting`;
      }
    })
    .catch((error) => {
      meshStatus.textContent = "The local demo hit an error";
      console.error(error);
    });
}

function toggleConnection(client: Client): void {
  const button = connectionButton(client);
  button.disabled = true;

  mutationQueue = mutationQueue
    .then(async () => {
      if (client.connected) {
        client.connected = false;
        updateConnectionUi(client);
        meshStatus.textContent = `${client.label} disconnected · local writes still work`;
        return;
      }

      const status = required<HTMLElement>("[data-client-status]", client.root);
      status.textContent = "Reconnecting…";
      const beforePaths = new Set(Object.keys(memory.dump()));

      await client.db.pull();
      await client.db.flush();
      client.connected = true;

      const peers = clients.filter((peer) => peer !== client && peer.connected);
      for (const peer of peers) await peer.db.pull();
      await renderAll();

      const afterPaths = Object.keys(memory.dump());
      const newPaths = new Set(afterPaths.filter((path) => !beforePaths.has(path)));
      const latestChange =
        [...newPaths].find((path) => path.includes("-chg_")) ??
        selectedFilePath ??
        "/TodoMVC/manifest.json";
      renderFilesystem(latestChange, newPaths);
      updateConnectionUi(client);
      meshStatus.textContent = `${client.label} reconnected · connected clients caught up`;
    })
    .catch((error) => {
      button.disabled = false;
      meshStatus.textContent = `${client.label} could not reconnect`;
      console.error(error);
    });
}

function bindClient(client: Client): void {
  const form = required<HTMLFormElement>("[data-new-todo-form]", client.root);
  const input = required<HTMLInputElement>("[data-new-todo]", client.root);
  const toggleAll = required<HTMLButtonElement>("[data-toggle-all]", client.root);
  const clearCompleted = required<HTMLButtonElement>("[data-clear-completed]", client.root);
  const toggleConnectionButton = connectionButton(client);
  const filterButtons = [...client.root.querySelectorAll<HTMLButtonElement>("[data-filter]")];

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const title = input.value.trim();
    if (!title) return;
    input.value = "";
    const id = `todo_${crypto.randomUUID()}`;
    runMutation(client, `added “${title}”`, () =>
      client.todos.put(id, { id, title, done: false, createdAt: Date.now() }),
    );
    input.focus();
  });

  toggleAll.addEventListener("click", () => {
    runMutation(client, "toggled every task", async () => {
      const all = await client.todos.query();
      const done = all.some((todo) => !todo.done);
      await client.db.batch(async () => {
        for (const todo of all) await client.todos.patch(todo.id, { done });
      });
    });
  });

  clearCompleted.addEventListener("click", () => {
    runMutation(client, "cleared completed tasks", async () => {
      const completed = (await client.todos.query()).filter((todo) => todo.done);
      await client.db.batch(async () => {
        for (const todo of completed) await client.todos.delete(todo.id);
      });
    });
  });

  for (const button of filterButtons) {
    button.addEventListener("click", () => {
      client.filter = button.dataset.filter as Filter;
      for (const peer of filterButtons) {
        peer.setAttribute("aria-pressed", String(peer === button));
      }
      void renderClient(client);
    });
  }

  toggleConnectionButton.addEventListener("click", () => toggleConnection(client));
}

for (const client of clients) bindClient(client);

addClientButton.addEventListener("click", () => {
  addClientButton.disabled = true;
  meshStatus.textContent = "Adding Client 3 to the mesh…";

  mutationQueue = mutationQueue
    .then(async () => {
      const root = required<HTMLElement>('[data-client="client-3"]');
      root.hidden = false;
      required<HTMLElement>("#demo").classList.add("has-third-client");

      client3 = createClient("client-3", "Client 3");
      clients.push(client3);
      bindClient(client3);
      client3.todos.subscribe(() => void renderClient(client3!));

      await client3.db.connect();
      client3.connected = true;
      updateConnectionUi(client3);
      await renderAll();
      renderFilesystem();

      addClientControl.hidden = true;
      meshStatus.textContent = "Client 3 joined · three clients caught up";
    })
    .catch((error) => {
      addClientButton.disabled = false;
      meshStatus.textContent = "Client 3 could not join the mesh";
      console.error(error);
    });
});

compactButton.addEventListener("click", () => {
  compacting = true;
  updateCompactAvailability();

  mutationQueue = mutationQueue
    .then(async () => {
      if (!clients.every((client) => client.connected)) {
        meshStatus.textContent = "Reconnect every client before compacting";
        return;
      }

      const before = memory.dump();
      meshStatus.textContent = "Publishing a snapshot with exact change-file coverage…";

      await client1.db.compact();
      for (const client of clients) {
        if (client !== client1) await client.db.pull();
      }
      await renderAll();

      const after = memory.dump();
      const changedPaths = new Set(
        Object.keys(after).filter((path) => before[path] !== after[path]),
      );
      const snapshotPath = [...changedPaths].find((path) => path.includes("/mainline/snapshot-"));
      const afterChangeCount = Object.keys(after).filter((path) => path.includes("-chg_")).length;

      renderFilesystem(snapshotPath ?? "/TodoMVC/manifest.json", changedPaths);
      meshStatus.textContent = `Snapshot published · ${afterChangeCount} uncovered change files remain`;
    })
    .catch((error) => {
      meshStatus.textContent = "The filesystem could not be compacted";
      console.error(error);
    })
    .finally(() => {
      compacting = false;
      updateCompactAvailability();
    });
});

resetButton.addEventListener("click", () => {
  runMutation(client1, "reset the demo", async () => {
    const all = await client1.todos.query();
    await client1.db.batch(async () => {
      for (const todo of all) await client1.todos.delete(todo.id);
    });
  });
});

try {
  await client1.db.connect();
  await client2.db.connect();

  for (const client of clients) {
    client.todos.subscribe(() => void renderClient(client));
    client.connected = true;
    updateConnectionUi(client);
  }

  await renderAll();
  renderFilesystem("/TodoMVC/manifest.json");
  document.documentElement.dataset.ready = "true";
} catch (error) {
  meshStatus.textContent = "The local demo could not start";
  for (const client of clients) {
    required<HTMLElement>("[data-client-status]", client.root).textContent = "Unavailable";
    client.root.querySelectorAll("input, button").forEach((control) => {
      (control as HTMLInputElement | HTMLButtonElement).disabled = true;
    });
  }
  console.error(error);
}

Object.assign(window, {
  __todoMvcDemo: {
    ready: () => document.documentElement.dataset.ready === "true",
    getFilesystem: () => memory.dump(),
    getTodos: async (id: ClientId) =>
      (await getClient(id).todos.query()).toSorted((a, b) => a.createdAt - b.createdAt),
  },
});

window.addEventListener("beforeunload", () => {
  for (const client of clients) void client.db.disconnect();
});
