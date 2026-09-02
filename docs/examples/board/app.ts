import {
  Interocitor,
  MemoryLocalStore,
  PortablePassphraseKeySource,
  types,
  type DatabaseSchemaDefinition,
} from "../../../packages/core/src/index.ts";
import { MemoryAdapter } from "../../../packages/core/src/adapters/memory.ts";
import { generateKey, keyToPassphrase } from "../../../packages/core/src/crypto/keys.ts";

type Column = "ideas" | "doing" | "done";
type ClientId = "maya" | "noah";
type BoardCard = {
  id: string;
  title: string;
  column: Column;
  rank: number;
  updatedBy: string;
};
type BoardDB = { cards: BoardCard };

const columns: Column[] = ["ideas", "doing", "done"];
const schema = {
  tables: {
    cards: {
      fields: {
        id: types.string,
        title: types.string,
        column: types.string,
        rank: types.index(types.number),
        updatedBy: types.string,
      },
    },
  },
} satisfies DatabaseSchemaDefinition<BoardDB>;

function required<T extends Element>(selector: string, root: ParentNode = document): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}

const mailbox = new MemoryAdapter();
const portableKey = await keyToPassphrase(await generateKey());

function createDatabase(id: ClientId): Interocitor<BoardDB> {
  return new Interocitor<BoardDB>(mailbox, {
    dbName: `interocitor-board-${id}`,
    deviceId: `board_${id}`,
    remotePath: "/ProductBoard",
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
  db: Interocitor<BoardDB>;
  cards: ReturnType<Interocitor<BoardDB>["table"]>;
  root: HTMLElement;
};

function createClient(id: ClientId, label: string): Client {
  const db = createDatabase(id);
  return {
    id,
    label,
    db,
    cards: db.table("cards"),
    root: required<HTMLElement>(`[data-client="${id}"]`),
  };
}

const maya = createClient("maya", "Maya");
const noah = createClient("noah", "Noah");
const clients = [maya, noah];
const mailboxStatus = required<HTMLElement>("#mailbox-status");
const mailboxPath = required<HTMLElement>("#mailbox-path");
const mailboxPreview = required<HTMLPreElement>("#mailbox-preview");
const syncStatus = required<HTMLElement>("#sync-status");
let operationQueue = Promise.resolve();
let nextRank = Date.now();

function sortedCards(cards: BoardCard[]): BoardCard[] {
  return cards.toSorted((left, right) => left.rank - right.rank || left.id.localeCompare(right.id));
}

async function readCards(client: Client): Promise<BoardCard[]> {
  return sortedCards(await client.cards.query());
}

function cardElement(card: BoardCard): HTMLLIElement {
  const item = document.createElement("li");
  item.className = "board-card";
  item.dataset.cardId = card.id;

  const title = document.createElement("strong");
  title.textContent = card.title;
  const owner = document.createElement("small");
  owner.textContent = `last changed by ${card.updatedBy}`;
  const controls = document.createElement("div");
  controls.className = "card-controls";
  const columnIndex = columns.indexOf(card.column);

  for (const [direction, label, disabled] of [
    [-1, "Move left", columnIndex === 0],
    [1, "Move right", columnIndex === columns.length - 1],
  ] as const) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.direction = String(direction);
    button.disabled = disabled;
    button.textContent = direction < 0 ? "←" : "→";
    button.setAttribute("aria-label", `${label}: ${card.title}`);
    controls.append(button);
  }

  item.append(title, owner, controls);
  return item;
}

async function renderClient(client: Client): Promise<void> {
  const cards = await readCards(client);
  required<HTMLElement>("[data-local-count]", client.root).textContent =
    `${cards.length} local cards`;
  for (const column of columns) {
    const list = required<HTMLUListElement>(`[data-column="${column}"]`, client.root);
    list.replaceChildren(
      ...cards.filter((card) => card.column === column).map((card) => cardElement(card)),
    );
  }
}

async function renderAll(): Promise<void> {
  await Promise.all(clients.map((client) => renderClient(client)));
}

function renderMailbox(): void {
  const files = mailbox.dump();
  const paths = Object.keys(files).toSorted();
  const selectedPath = paths.filter((path) => path.includes("-chg_")).at(-1) ?? paths.at(-1);
  const contents = selectedPath ? (files[selectedPath] ?? "") : "";
  const encrypted = clients.every((client) => client.db.isEncrypted());
  mailboxStatus.textContent = encrypted
    ? `${paths.length} encrypted mesh ${paths.length === 1 ? "file" : "files"}`
    : "Encryption is not active";
  mailboxStatus.dataset.safe = String(encrypted);
  mailboxPath.textContent = selectedPath ?? "Waiting for a board change";
  mailboxPreview.textContent = contents
    ? contents.slice(0, 560)
    : "Change either local board, then sync to inspect its encrypted envelope.";
}

function enqueue(operation: () => Promise<void>): Promise<void> {
  operationQueue = operationQueue.then(operation);
  return operationQueue;
}

function addCard(client: Client, title: string): Promise<void> {
  const clean = title.trim();
  if (!clean) return operationQueue;
  return enqueue(async () => {
    const id = `card_${crypto.randomUUID()}`;
    await client.cards.put(id, {
      id,
      title: clean,
      column: "ideas",
      rank: ++nextRank,
      updatedBy: client.label,
    });
    await renderClient(client);
    syncStatus.textContent = `${client.label} has an unsynced local change.`;
  });
}

function moveCard(client: Client, cardId: string, direction: number): Promise<void> {
  return enqueue(async () => {
    const card = (await readCards(client)).find((candidate) => candidate.id === cardId);
    if (!card) return;
    const nextColumn =
      columns[Math.max(0, Math.min(columns.length - 1, columns.indexOf(card.column) + direction))]!;
    await client.cards.put(card.id, { ...card, column: nextColumn, updatedBy: client.label });
    await renderClient(client);
    syncStatus.textContent = `${client.label} moved “${card.title}” locally.`;
  });
}

function synchronize(): Promise<void> {
  return enqueue(async () => {
    syncStatus.textContent = "Exchanging encrypted changes…";
    for (const client of clients) await client.db.flush();
    for (const client of clients) await client.db.pull();
    await renderAll();
    renderMailbox();
    syncStatus.textContent = "Both local boards have converged.";
  });
}

function reloadBoard(client: Client): Promise<void> {
  return enqueue(async () => {
    const button = required<HTMLButtonElement>("[data-reload-board]", client.root);
    button.disabled = true;
    syncStatus.textContent = `Reloading ${client.label}’s board…`;
    try {
      await client.db.flush();
      await client.db.pull();
      await renderClient(client);
      renderMailbox();
      syncStatus.textContent = `${client.label}’s board reloaded from the encrypted mesh.`;
    } finally {
      button.disabled = false;
    }
  });
}

function bindClient(client: Client): void {
  const form = required<HTMLFormElement>("form", client.root);
  const input = required<HTMLInputElement>("input", form);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const title = input.value;
    input.value = "";
    void addCard(client, title);
  });
  required<HTMLButtonElement>("[data-reload-board]", client.root).addEventListener("click", () => {
    void reloadBoard(client);
  });
  client.root.addEventListener("click", (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>("[data-direction]");
    const cardId = button?.closest<HTMLElement>("[data-card-id]")?.dataset.cardId;
    if (!button || !cardId) return;
    void moveCard(client, cardId, Number(button.dataset.direction));
  });
}

for (const client of clients) bindClient(client);

try {
  await maya.db.connect();
  for (const card of [
    { id: "card_research", title: "Interview three users", column: "ideas" as const },
    { id: "card_copy", title: "Rewrite onboarding", column: "doing" as const },
    { id: "card_release", title: "Ship private beta", column: "done" as const },
  ]) {
    await maya.cards.put(card.id, { ...card, rank: ++nextRank, updatedBy: "Maya" });
  }
  await maya.db.flush();
  await noah.db.connect();
  await renderAll();
  renderMailbox();
  document.documentElement.dataset.ready = "true";
} catch (error) {
  mailboxStatus.textContent = "The encrypted board demo could not start";
  mailboxStatus.dataset.safe = "false";
  document
    .querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input")
    .forEach((control) => {
      control.disabled = true;
    });
  console.error(error);
}

Object.assign(window, {
  __boardDemo: {
    ready: () => document.documentElement.dataset.ready === "true",
    addCard: (clientId: ClientId, title: string) =>
      addCard(clientId === "maya" ? maya : noah, title),
    moveCard: (clientId: ClientId, cardId: string, direction: number) =>
      moveCard(clientId === "maya" ? maya : noah, cardId, direction),
    sync: synchronize,
    getCards: (clientId: ClientId) => readCards(clientId === "maya" ? maya : noah),
    getMailbox: () => mailbox.dump(),
  },
});

declare global {
  interface Window {
    __boardDemo: {
      ready: () => boolean;
      addCard: (clientId: ClientId, title: string) => Promise<void>;
      moveCard: (clientId: ClientId, cardId: string, direction: number) => Promise<void>;
      sync: () => Promise<void>;
      getCards: (clientId: ClientId) => Promise<BoardCard[]>;
      getMailbox: () => Record<string, string>;
    };
  }
}
