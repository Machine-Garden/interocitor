# Protocol flows

Detailed Mermaid diagrams for row-sync protocol paths. Durable files and
images use direct `putFile` / `getFile` / `deleteFile` operations under the
mesh `files/` namespace. They do not participate in the local row outbox,
pull, flush, or compaction, so callers need live transport and their own retry
policy. For the project overview, see [README.md](../README.md).

## Pull — exact receipt and merge

```mermaid
flowchart TD
    A([pull]) --> B[loadOrCreateManifest]
    B --> F[list changes/]
    F -- 404 / empty --> DONE([sync:complete\nentriesMerged=0])
    F -- files --> G[sort filenames bytewise\nfor deterministic processing]
    G --> H{next file?}
    H -- done --> I[persist observation ledger\nemit sync:complete]
    H -- head.json --> H
    H -- change file --> J{exact filename\nalready observed?}
    J -- Yes --> H
    J -- No --> K[GET + decodeFromCloud + JSON.parse]
    K --> L[applyChangeEntry\n→ putRows in local store]
    L --> M[atomically persist rows\n+ exact filename receipt]
    M --> N[emit change/delete events]
    N --> H
```

**Key invariant:** exact immutable filename identity is authoritative. HLCs
order conflicting CRDT operations deterministically, but neither a cursor nor
`head.json` proves that a lower-HLC file was previously observed.

## Connect and engine lifecycle

```mermaid
flowchart TD
    A([init]) --> B{open configured\nlocal store}
    B -- opened --> B1[restore HLC + table names]
    B -- resilient wrapper degrades --> B2[use memory for this session\nemit onLocalDegraded]
    B -- raw store fails --> BX([init rejects])
    B2 --> B1
    B1 --> C([connect])
    C --> D{adapter\nauthenticated?}
    D -- No --> E[bounded stage:\nadapter.authenticate]
    E --> E1{stage completed\nbefore deadline?}
    E1 -- No --> Z[offline-ready degrade\nemit connect:error + onConnectStalled]
    E1 -- Yes --> D
    D -- Yes --> F["bounded stage:\nensureFolder ×4\nremotePath → devices\n→ mainline → changes"]
    F --> F1{stage completed\nbefore deadline?}
    F1 -- No --> Z
    F1 -- Yes --> G[bounded stage:\nloadOrCreateManifest]
    G --> G0{stage completed\nbefore deadline?}
    G0 -- No --> Z
    G0 -- Yes --> G1{manifest exists?}
    G1 -- No --> H[createBootstrapManifest\nmanifest-1 + manifest.json]
    H --> G1
    G1 -- Yes --> I[validate content hash\ncheck schema version\ncheck server auth if managed]
    I --> IP{joining existing mesh\nwith different local meshId?}
    IP -- Yes: reset-to-remote --> IR[clear local rows, outbox, cursors\nand pending writes before pull]
    IP -- Yes: merge-with-remote --> IM[keep local rows and queued writes\nfor normal CRDT sync]
    IP -- No --> I1[bounded stage:\nupsertDeviceMetadata]
    IR --> I1
    IM --> I1
    I1 --> I2{stage completed\nbefore deadline?}
    I2 -- No --> Z
    I2 -- Yes --> J{localEpoch\n< remoteEpoch?}
    J -- Yes: new snapshot --> KF[bounded stage:\nflush durable outbox]
    KF --> K[bounded stage:\nrehydrate]
    K --> K0{stage completed\nbefore deadline?}
    K0 -- No --> Z
    K0 -- Yes --> K1[GET snapshotPath from manifest]
    K1 --> K2[clear rows and reset\nobservation ledger; preserve outbox]
    K2 --> K3[write snapshot rows\nrestore HLC]
    K3 --> M
    J -- No --> L[bounded stage:\npull exact unseen filenames]
    L --> L0{stage completed\nbefore deadline?}
    L0 -- No --> Z
    L0 -- Yes --> M[bounded stage:\nflush durable outbox]
    M --> M0{stage completed\nbefore deadline?}
    M0 -- No --> Z
    M0 -- Yes --> N[flush to replicas\nbest-effort]
    N --> O([startPolling every N ms])
    Z --> Z1([return from connect\nready but not connected])
```

**Offline row behavior:** `init()` never touches the network. After the
configured local store initializes successfully, row operations through
`table(...)`—including `add`, `patch`, `replace`, `delete`, `row`, `query`, and
`where`—work against that store. Memory fallback is conditional: applications
must select the resilient local-store wrapper to degrade when its backing
store is blocked, closing, unavailable, or stalled. A raw
`IndexedDbLocalStore` does not provide that fallback. Durable file methods are
direct adapter operations and do not share the offline row behavior.

**Connect stage deadlines:** `connect()` begins the row-sync network
lifecycle. Authentication, folder setup, manifest loading, device metadata,
rehydration, pull, and flush use `connectStageTimeoutMs` (15s by default). A
timeout in one of those guarded stages emits `connect:error`, calls
`onConnectStalled`, and returns offline-ready so the app can retry later.

**Join-existing-mesh policy:** after `connect()` loads an existing remote
manifest and before device metadata, pull, or flush, the engine compares the
remote `meshId` with local mesh metadata. If they differ,
`joinExistingMeshPolicy` applies. The default `reset-to-remote` clears local
rows, outbox, pending writes, cursors, and stale mesh metadata before pulling
remote data. `merge-with-remote` keeps local rows and queued writes so normal
CRDT pull/flush can merge them into the joined mesh.

**Failure semantics:** local-store degradation and connect-stage stalls are
availability fallbacks, not successful sync. A degraded local store may lose
session-only writes on reload until they have flushed remotely. An
offline-ready `connect()` means the engine is ready for local work but is
disconnected from the remote. Validation errors such as encryption
mismatch, poison, or schema incompatibility are not availability fallbacks;
they still surface as hard correctness/security errors.

**Disaster recovery:** the durable local database name is a cache
namespace, not mesh identity. If a browser keeps a DB blocked or a handle
keeps closing, applications can rotate to a new versioned local DB name and
continue. Old DB names are cleaned up opportunistically when the platform
supports IndexedDB enumeration; cleanup must never block app startup.

## Flush (local → cloud)

```mermaid
flowchart TD
    A([flush]) --> A1[reload manifest]
    A1 --> B[peek durable outbox]
    B --> C{entries.length\n== 0?}
    C -- Yes --> DONE([return])
    C -- No --> D[emit flush:start]
    D --> E[flushToAdapter — primary]
    E --> F{replicas\nconfigured?}
    F -- No --> ACK[acknowledge exact published IDs]
    F -- Yes --> H[for each replica]
    H --> I[flushToAdapter — replica]
    I --> J{replica\nsucceeded?}
    J -- No --> K[emit replica:error\ncontinue]
    J -- Yes --> H
    K --> H
    H -- done --> ACK
    ACK --> G[emit flush:complete]
```

Each `flushToAdapter` call writes one JSON file per change entry,
then updates `changes/head.json` with the latest HLC.

## Compaction

```mermaid
sequenceDiagram
    participant E as Interocitor (compactor)
    participant C as Cloud

    Note over E: compactInFlight prevents overlap inside one engine instance
    E->>E: flush durable local work, then pull all remote changes
    E->>C: LIST changes/
    E->>E: capture exact observed filenames
    E->>E: getAllRows() — full local-store scan
    E->>C: PUT mainline/snapshot-{epoch}-{writer}.json
    E->>C: PUT manifest-{gen}.json (epoch, watermarkHlc, snapshotPath, coveredChangeFiles)
    E->>C: PUT manifest.json { currentGeneration, file }
    E->>C: PUT devices/{deviceId}.json observation ack
    Note over C: pointer switches — other devices see the new epoch on next connect/pull

    E->>E: setMeta epoch ← nextEpoch

    E->>C: DELETE each filename in coveredChangeFiles
    Note over E,C: uncovered change files and snapshot tombstones remain
```

**Write ordering:** snapshot → manifest file → manifest pointer.
Readers loading `manifest.json` always see a consistent pair; the
snapshot file exists before any reader is directed to it.

Other devices detect epoch advancement on the next `connect()` or `pull()`.
If `remoteEpoch > localEpoch`, an old client first publishes durable local
work, then rehydrates from the snapshot and pulls every remaining filename not
present in the snapshot's exact receipt set. A new client has no local work and
can restore immediately.

The adapter contract does not provide CAS/ETag writes, so compaction is not
strictly race-safe across concurrent devices: one valid manifest pointer can
overwrite another. A single in-flight guard only deduplicates work within one
Interocitor instance. Use a server-managed single compactor when strict
coordination is required; see
[Compaction coordination](../packages/core/docs/compaction.md#coordination--locking).

## Bootstrap (first-ever connect)

```mermaid
sequenceDiagram
    participant E as Interocitor
    participant C as Cloud

    E->>C: GET {remotePath}/manifest.json
    C-->>E: 404 (not found)

    Note over E: createBootstrapManifest()
    E->>C: PUT {remotePath}/manifest-1.json (contentHash, epoch:0)
    E->>C: PUT {remotePath}/manifest.json { currentGeneration: 1, file: manifest-1.json }

    Note over E: loadOrCreateManifest() — second pass
    E->>C: GET manifest.json → pointer
    E->>C: GET manifest-1.json → validate hash
    E->>E: manifest.epoch = 0, localEpoch = 0 → pull()
    E->>C: LIST changes/
    C-->>E: empty
    Note over E: sync:complete entriesMerged=0
```

## Rehydration (after compaction by another device)

```mermaid
flowchart TD
    A([rehydrate]) --> A1[flush durable outbox]
    A1 --> B{manifest.snapshotPath\nexists?}
    B -- No --> C[emit rehydrate:complete rowCount=0]
    C --> D[pull]
    B -- Yes --> E[GET snapshot file]
    E --> F{encrypted?}
    F -- Yes --> G[decodeFromCloud]
    F -- No --> H[parse JSON]
    G --> H
    H --> I[clear rows; preserve durable outbox]
    I --> J[write all snapshot rows to local store]
    J --> K[restore HLC and exact\ncoveredChangeFiles receipts]
    K --> L[setMeta epoch]
    L --> M[emit rehydrate:complete]
    M --> D
```

## Replica flush

Replicas are write-only mirrors of the primary remote. The engine
writes the same change files + head.json to each replica on every flush.
Replica failures are non-fatal — the primary write must succeed, but
replica errors only emit a `replica:error` event.

```mermaid
flowchart LR
    subgraph Primary
        A[changes/head.json]
        B[changes/{hlc}-{id}.json]
    end

    subgraph Replica 1
        C[changes/head.json]
        D[changes/{hlc}-{id}.json]
    end

    subgraph Replica 2
        E[changes/head.json]
        F[changes/{hlc}-{id}.json]
    end

    FLUSH([flush]) --> Primary
    FLUSH -.->|best-effort| C
    FLUSH -.->|best-effort| E
```

Pull always reads from the primary adapter only.
