import {
  Interocitor,
  MemoryLocalStore,
  PortablePassphraseKeySource,
  types,
  type DatabaseSchemaDefinition,
} from "../../../packages/core/src/index.ts";
import { MemoryAdapter } from "../../../packages/core/src/adapters/memory.ts";
import { generateKey, keyToPassphrase } from "../../../packages/core/src/crypto/keys.ts";

const MESSAGE_LIMIT = 15;

type ChatMessage = {
  id: string;
  sender: string;
  body: string;
  createdAt: number;
};

type ChatDB = { messages: ChatMessage };
type ClientId = "alice" | "bob";

const schema = {
  tables: {
    messages: {
      fields: {
        id: types.string,
        sender: types.string,
        body: types.string,
        createdAt: types.index(types.number),
      },
    },
  },
} satisfies DatabaseSchemaDefinition<ChatDB>;

function required<T extends Element>(selector: string, root: ParentNode = document): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`Missing required element: ${selector}`);
  return found;
}

const mailbox = new MemoryAdapter();
const portableKey = await keyToPassphrase(await generateKey());

function createDatabase(id: ClientId): Interocitor<ChatDB> {
  return new Interocitor<ChatDB>(mailbox, {
    dbName: `interocitor-public-chat-${id}`,
    deviceId: `chat_${id}`,
    remotePath: "/EncryptedChat",
    localStore: new MemoryLocalStore(),
    keySource: new PortablePassphraseKeySource({ portableKey }),
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
  db: Interocitor<ChatDB>;
  messages: ReturnType<Interocitor<ChatDB>["table"]>;
  root: HTMLElement;
};

function createClient(id: ClientId, label: string): Client {
  const db = createDatabase(id);
  return {
    id,
    label,
    db,
    messages: db.table("messages"),
    root: required<HTMLElement>(`[data-client="${id}"]`),
  };
}

const alice = createClient("alice", "Alice");
const bob = createClient("bob", "Bob");
const clients = [alice, bob];
const mailboxStatus = required<HTMLElement>("#mailbox-status");
const mailboxPath = required<HTMLElement>("#mailbox-path");
const mailboxPreview = required<HTMLPreElement>("#mailbox-preview");
const retentionStatus = required<HTMLElement>("#retention-status");
let operationQueue = Promise.resolve();
let lastCreatedAt = 0;

function sortedMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.toSorted(
    (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
  );
}

async function readMessages(client: Client): Promise<ChatMessage[]> {
  return sortedMessages(await client.messages.query());
}

function messageElement(message: ChatMessage, client: Client): HTMLLIElement {
  const item = document.createElement("li");
  item.className = message.sender === client.label ? "message is-own" : "message";

  const sender = document.createElement("strong");
  sender.textContent = message.sender;
  const body = document.createElement("span");
  body.textContent = message.body;
  item.append(sender, body);
  return item;
}

async function renderClient(client: Client): Promise<void> {
  const messages = await readMessages(client);
  const list = required<HTMLUListElement>("[data-message-list]", client.root);
  const count = required<HTMLElement>("[data-message-count]", client.root);
  list.replaceChildren(...messages.map((message) => messageElement(message, client)));
  count.textContent = `${messages.length} / ${MESSAGE_LIMIT}`;
  list.scrollTop = list.scrollHeight;
}

async function renderAll(): Promise<void> {
  await Promise.all(clients.map((client) => renderClient(client)));
}

function renderMailbox(): void {
  const files = mailbox.dump();
  const paths = Object.keys(files).toSorted();
  const encryptedPaths = paths.filter(
    (path) => path.includes("-chg_") || path.includes("snapshot-"),
  );
  const selectedPath = encryptedPaths.at(-1) ?? paths.at(-1);
  const contents = selectedPath ? (files[selectedPath] ?? "") : "";
  const encrypted = clients.every((client) => client.db.isEncrypted());

  mailboxStatus.textContent = encrypted
    ? `${paths.length} encrypted mesh ${paths.length === 1 ? "file" : "files"} · AES-GCM envelopes`
    : "Encryption is not active";
  mailboxStatus.dataset.safe = String(encrypted);
  mailboxPath.textContent = selectedPath ?? "Waiting for the first message";
  mailboxPreview.textContent = contents
    ? contents.slice(0, 720)
    : "Send a message to inspect the encrypted envelope stored by the mailbox.";
}

async function pruneToLimit(client: Client): Promise<number> {
  const messages = await readMessages(client);
  const expired = messages.slice(0, Math.max(0, messages.length - MESSAGE_LIMIT));
  if (expired.length === 0) return 0;

  await client.db.batch(async () => {
    for (const message of expired) await client.messages.delete(message.id);
  });
  return expired.length;
}

function sendMessage(client: Client, body: string): Promise<void> {
  const text = body.trim();
  if (!text) return operationQueue;

  operationQueue = operationQueue.then(async () => {
    await client.db.pull();
    const id = `message_${crypto.randomUUID()}`;
    const createdAt = Math.max(Date.now(), lastCreatedAt + 1);
    lastCreatedAt = createdAt;
    await client.messages.put(id, {
      id,
      sender: client.label,
      body: text,
      createdAt,
    });

    const pruned = await pruneToLimit(client);
    await client.db.flush();
    const peer = clients.find((candidate) => candidate !== client)!;
    await peer.db.pull();

    if (pruned > 0) {
      await client.db.compact();
      await peer.db.pull();
    }

    await renderAll();
    retentionStatus.textContent =
      pruned > 0
        ? `Removed ${pruned} oldest ${pruned === 1 ? "message" : "messages"}; both clients keep the newest ${MESSAGE_LIMIT}.`
        : `Both clients keep at most ${MESSAGE_LIMIT} messages.`;
    renderMailbox();
  });

  return operationQueue;
}

function bindClient(client: Client): void {
  const form = required<HTMLFormElement>("form", client.root);
  const input = required<HTMLInputElement>("input", form);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const body = input.value.trim();
    if (!body) return;
    input.value = "";
    void sendMessage(client, body).catch((error) => {
      mailboxStatus.textContent = "The chat demo hit an error";
      mailboxStatus.dataset.safe = "false";
      console.error(error);
    });
    input.focus();
  });
}

for (const client of clients) bindClient(client);

try {
  await alice.db.connect();
  await bob.db.connect();
  await renderAll();
  renderMailbox();
  document.documentElement.dataset.ready = "true";
} catch (error) {
  mailboxStatus.textContent = "The encrypted chat demo could not start";
  mailboxStatus.dataset.safe = "false";
  document
    .querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button")
    .forEach((control) => {
      control.disabled = true;
    });
  console.error(error);
}

Object.assign(window, {
  __chatDemo: {
    ready: () => document.documentElement.dataset.ready === "true",
    send: (clientId: ClientId, body: string) =>
      sendMessage(clientId === "alice" ? alice : bob, body),
    getMessages: (clientId: ClientId) => readMessages(clientId === "alice" ? alice : bob),
    getMailbox: () => mailbox.dump(),
    messageLimit: MESSAGE_LIMIT,
  },
});

window.addEventListener("beforeunload", () => {
  for (const client of clients) void client.db.disconnect();
});

declare global {
  interface Window {
    __chatDemo: {
      ready: () => boolean;
      send: (clientId: ClientId, body: string) => Promise<void>;
      getMessages: (clientId: ClientId) => Promise<ChatMessage[]>;
      getMailbox: () => Record<string, string>;
      messageLimit: number;
    };
  }
}
