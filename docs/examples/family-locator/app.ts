import {
  Interocitor,
  MemoryLocalStore,
  PortablePassphraseKeySource,
  types,
  type DatabaseSchemaDefinition,
} from "../../../packages/core/src/index.ts";
import { MemoryAdapter } from "../../../packages/core/src/adapters/memory.ts";
import { generateKey, keyToPassphrase } from "../../../packages/core/src/crypto/keys.ts";

type ClientId = "alex" | "sam";
type FamilyLocation = {
  id: string;
  name: string;
  place: string;
  x: number;
  y: number;
  updatedAt: number;
};
type LocatorDB = { locations: FamilyLocation };
const AUTO_SYNC_MS = 5_000;

const places = {
  home: { place: "Home", x: 24, y: 70 },
  school: { place: "School", x: 67, y: 25 },
  park: { place: "Riverside Park", x: 72, y: 74 },
} as const;
type PlaceId = keyof typeof places;

const schema = {
  tables: {
    locations: {
      fields: {
        id: types.string,
        name: types.string,
        place: types.string,
        x: types.number,
        y: types.number,
        updatedAt: types.index(types.number),
      },
    },
  },
} satisfies DatabaseSchemaDefinition<LocatorDB>;

function required<T extends Element>(selector: string, root: ParentNode = document): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}

const mailbox = new MemoryAdapter();
const portableKey = await keyToPassphrase(await generateKey());

function createDatabase(id: ClientId): Interocitor<LocatorDB> {
  return new Interocitor<LocatorDB>(mailbox, {
    dbName: `interocitor-locator-${id}`,
    deviceId: `locator_${id}`,
    remotePath: "/FamilyLocations",
    localStore: new MemoryLocalStore(),
    keySource: new PortablePassphraseKeySource({ portableKey }),
    schema,
    batchWindowMs: 0,
    flushDebounce: AUTO_SYNC_MS,
    pollInterval: AUTO_SYNC_MS,
    autoCompact: false,
  });
}

type Client = {
  id: ClientId;
  label: string;
  db: Interocitor<LocatorDB>;
  locations: ReturnType<Interocitor<LocatorDB>["table"]>;
  root: HTMLElement;
};

function createClient(id: ClientId, label: string): Client {
  const db = createDatabase(id);
  return {
    id,
    label,
    db,
    locations: db.table("locations"),
    root: required<HTMLElement>(`[data-client="${id}"]`),
  };
}

const alex = createClient("alex", "Alex");
const sam = createClient("sam", "Sam");
const clients = [alex, sam];
const mailboxStatus = required<HTMLElement>("#mailbox-status");
const mailboxPath = required<HTMLElement>("#mailbox-path");
const mailboxPreview = required<HTMLPreElement>("#mailbox-preview");
const syncStatus = required<HTMLElement>("#sync-status");
const syncButton = required<HTMLButtonElement>("#sync-locations");
let operationQueue = Promise.resolve();
let lastUpdatedAt = Date.now();
let automaticSyncTimer: number | undefined;

async function readLocations(client: Client): Promise<FamilyLocation[]> {
  return (await client.locations.query()).toSorted((left, right) =>
    left.name.localeCompare(right.name),
  );
}

function locationMarker(location: FamilyLocation): HTMLDivElement {
  const marker = document.createElement("div");
  marker.className = `map-marker marker-${location.id}`;
  marker.style.left = `${location.x}%`;
  marker.style.top = `${location.y}%`;
  marker.innerHTML = `<strong>${location.name}</strong><span>${location.place}</span>`;
  return marker;
}

async function renderClient(client: Client): Promise<void> {
  const locations = await readLocations(client);
  const map = required<HTMLElement>("[data-map]", client.root);
  map.querySelectorAll(".map-marker").forEach((marker) => marker.remove());
  map.append(...locations.map((location) => locationMarker(location)));
  const list = required<HTMLUListElement>("[data-location-list]", client.root);
  list.replaceChildren(
    ...locations.map((location) => {
      const item = document.createElement("li");
      const age = Math.max(0, Math.round((Date.now() - location.updatedAt) / 1000));
      item.innerHTML = `<strong>${location.name}</strong><span>${location.place}</span><small>${age}s old</small>`;
      return item;
    }),
  );
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
    ? `${paths.length} protected mesh ${paths.length === 1 ? "file" : "files"}`
    : "Encryption is not active";
  mailboxStatus.dataset.safe = String(encrypted);
  mailboxPath.textContent = selectedPath ?? "Waiting for a location update";
  mailboxPreview.textContent = contents
    ? contents.slice(0, 560)
    : "Update a location, then sync to inspect its encrypted envelope.";
}

function enqueue(operation: () => Promise<void>): Promise<void> {
  operationQueue = operationQueue.then(operation);
  return operationQueue;
}

function updateLocation(client: Client, placeId: PlaceId): Promise<void> {
  return enqueue(async () => {
    const place = places[placeId];
    const updatedAt = Math.max(Date.now(), ++lastUpdatedAt);
    await client.locations.put(client.id, {
      id: client.id,
      name: client.label,
      ...place,
      updatedAt,
    });
    await renderClient(client);
    syncStatus.textContent = `${client.label} changed location locally. Auto-sync runs within five seconds.`;
  });
}

function synchronize(): Promise<void> {
  return enqueue(async () => {
    syncButton.disabled = true;
    syncStatus.textContent = "Exchanging protected location changes…";
    try {
      for (const client of clients) await client.db.flush();
      for (const client of clients) await client.db.pull();
      await renderAll();
      renderMailbox();
      syncStatus.textContent = "Both devices now show the same latest known locations.";
    } finally {
      syncButton.disabled = false;
    }
  });
}

async function refreshAfterAutomaticSync(client: Client): Promise<void> {
  await renderClient(client);
  renderMailbox();
  const [alexLocations, samLocations] = await Promise.all([
    readLocations(alex),
    readLocations(sam),
  ]);
  if (JSON.stringify(alexLocations) === JSON.stringify(samLocations)) {
    syncStatus.textContent = "Auto-sync complete. Both devices show the same locations.";
  }
}

for (const client of clients) {
  client.root.addEventListener("click", (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>("[data-place]");
    if (!button) return;
    void updateLocation(client, button.dataset.place as PlaceId);
  });
}
syncButton.addEventListener("click", () => void synchronize());

try {
  await alex.db.connect();
  await alex.locations.put("alex", {
    id: "alex",
    name: "Alex",
    ...places.home,
    updatedAt: ++lastUpdatedAt,
  });
  await alex.db.flush();
  await sam.db.connect();
  await sam.locations.put("sam", {
    id: "sam",
    name: "Sam",
    ...places.school,
    updatedAt: ++lastUpdatedAt,
  });
  await synchronize();
  for (const client of clients) {
    client.locations.subscribe(() => void refreshAfterAutomaticSync(client));
  }
  renderMailbox();
  document.documentElement.dataset.ready = "true";
  automaticSyncTimer = window.setInterval(() => void synchronize(), AUTO_SYNC_MS);
} catch (error) {
  mailboxStatus.textContent = "The protected locator demo could not start";
  mailboxStatus.dataset.safe = "false";
  document.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
    button.disabled = true;
  });
  console.error(error);
}

Object.assign(window, {
  __locatorDemo: {
    ready: () => document.documentElement.dataset.ready === "true",
    update: (clientId: ClientId, placeId: PlaceId) =>
      updateLocation(clientId === "alex" ? alex : sam, placeId),
    sync: synchronize,
    getLocations: (clientId: ClientId) => readLocations(clientId === "alex" ? alex : sam),
    getMailbox: () => mailbox.dump(),
  },
});

window.addEventListener("beforeunload", () => {
  if (automaticSyncTimer !== undefined) window.clearInterval(automaticSyncTimer);
  for (const client of clients) void client.db.disconnect();
});

declare global {
  interface Window {
    __locatorDemo: {
      ready: () => boolean;
      update: (clientId: ClientId, placeId: PlaceId) => Promise<void>;
      sync: () => Promise<void>;
      getLocations: (clientId: ClientId) => Promise<FamilyLocation[]>;
      getMailbox: () => Record<string, string>;
    };
  }
}
