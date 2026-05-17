# Protocol Flows

Detailed Mermaid diagrams for row-sync protocol paths. Durable files/images use direct `putFile`/`getFile`/`deleteFile` operations under the mesh `files/` namespace and do not participate in pull/flush/compaction. For the bird's-eye overview see [README.md](../README.md).

## Pull — fast-skip and merge

```mermaid
flowchart TD
    A([pull]) --> B[loadOrCreateManifest]
    B --> C[GET changes/head.json]
    C --> D{head.latestHlc\n≤ cursor?}
    D -- Yes --> SKIP([sync:complete\nentriesMerged=0])
    D -- No or no head --> F[list changes/]
    F -- 404 / empty --> SKIP
    F -- files --> G[sort by filename\nHLC prefix = chronological]
    G --> H{next file?}
    H -- done --> I[cursor ← latestMergedHlc\nemit sync:complete]
    H -- head.json --> H
    H -- change file --> J{file HLC > cursor?}
    J -- No → skip --> H
    J -- Yes --> K[GET + decodeFromCloud + JSON.parse]
    K --> L[applyChangeEntry\n→ putRows IDB]
    L --> M[emit change/delete events]
    M --> H
```

**Key invariant:** the cursor is an HLC string. It advances monotonically.
Files whose HLC prefix sorts ≤ cursor are never downloaded — the filename
itself is enough to skip them.

## Connect and engine lifecycle

```mermaid
flowchart TD
    A([init]) --> B{open resilient\nlocal store}
    B -- IDB ok --> B1[restore HLC + table names]
    B -- IDB blocked / closing / stalled --> B2[degrade to memory\nemit onLocalDegraded]
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
    I --> I1[bounded stage:\nupsertDeviceMetadata]
    I1 --> I2{stage completed\nbefore deadline?}
    I2 -- No --> Z
    I2 -- Yes --> J{localEpoch\n< remoteEpoch?}
    J -- Yes: new snapshot --> K[bounded stage:\nrehydrate]
    K --> K0{stage completed\nbefore deadline?}
    K0 -- No --> Z
    K0 -- Yes --> K1[GET snapshotPath from manifest]
    K1 --> K2[clearAll local store]
    K2 --> K3[write snapshot rows\nrestore HLC]
    K3 --> M
    J -- No --> L[bounded stage:\npull change files]
    L --> L0{stage completed\nbefore deadline?}
    L0 -- No --> Z
    L0 -- Yes --> M[bounded stage:\nflush outbox]
    M --> M0{stage completed\nbefore deadline?}
    M0 -- No --> Z
    M0 -- Yes --> N[flush to replicas\nbest-effort]
    N --> O([startPolling every N ms])
    Z --> Z1([return from connect\nready but not connected])
```

**Offline guarantee:** `init()` never touches the network. After `init()`,
`put()`, `delete()`, `get()`, `query()`, and `queryWhere()` all work
against the local store. IndexedDB is preferred but not required: if it is
blocked, closing, unavailable, or fails to make progress, the resilient
store degrades to memory so the app can continue.

**Bounded connect guarantee:** `connect()` is the first network call. Each
cloud stage has a bounded-progress deadline (`connectStageTimeoutMs`, 15s
by default). A stalled stage emits `connect:error` and calls
`onConnectStalled`, then returns offline-ready: `init()` remains complete,
local writes keep queuing, and the app can retry `connect()` later.

**Failure semantics:** local-store degradation and connect-stage stalls are
availability fallbacks, not successful sync. A degraded local store may lose
session-only writes on reload until they have flushed remotely. An
offline-ready `connect()` means the engine is ready for local work but is
not yet connected to the remote. Validation errors such as mesh mismatch,
encryption mismatch, poison, or schema incompatibility are not availability
fallbacks; they still surface as hard correctness/security errors.

**Disaster recovery:** the durable local database name is a cache
namespace, not mesh identity. If a browser keeps a DB blocked or a handle
keeps closing, applications can rotate to a new versioned local DB name and
continue. Old DB names are cleaned up opportunistically when the platform
supports IndexedDB enumeration; cleanup must never block app startup.

## Flush (local → cloud)

```mermaid
flowchart TD
    A([flush]) --> A1[reload manifest]
    A1 --> B[drainOutbox from IDB]
    B --> C{entries.length\n== 0?}
    C -- Yes --> DONE([return])
    C -- No --> C1{any entry.hlc\n<= gcFloorHlc?}
    C1 -- Yes --> R[rehydrate from snapshot\nrefuse stale flush]
    R --> ERR([throw rehydrate required])
    C1 -- No --> D[emit flush:start]
    D --> E[flushToAdapter — primary]
    E --> F{replicas\nconfigured?}
    F -- No --> G[emit flush:complete]
    F -- Yes --> H[for each replica]
    H --> I[flushToAdapter — replica]
    I --> J{replica\nsucceeded?}
    J -- No --> K[emit replica:error\ncontinue]
    J -- Yes --> H
    K --> H
    H -- done --> G
```

Each `flushToAdapter` call writes one JSON file per change entry,
then updates `changes/head.json` with the latest HLC.

## Compaction

```mermaid
sequenceDiagram
    participant E as SyncEngine (compactor)
    participant C as Cloud

    Note over E: compactInFlight prevents overlap inside one engine instance
    E->>E: pull() — merge all remote changes first
    E->>C: LIST devices/
    E->>E: active = not retired and lastSeenAt inside offlineGraceMs
    E->>E: gcFloorHlc = min(active observedWatermarkHlc)
    E->>E: getAllRows() — full IDB scan
    E->>E: omit tombstones where deletedHlc <= gcFloorHlc
    E->>C: PUT mainline/snapshot-{epoch}-{writer}.json
    E->>C: PUT manifest-{gen}.json (epoch, watermarkHlc, snapshotPath, gcFloorHlc)
    E->>C: PUT manifest.json { currentGeneration, file }
    E->>C: PUT devices/{deviceId}.json observation ack
    Note over C: pointer switches — other devices see new epoch/floor on next connect/pull/flush

    E->>E: setMeta epoch ← nextEpoch

    E->>C: list changes/ (all files)
    loop each change file with HLC ≤ watermarkHlc
        E->>C: DELETE {hlc}-{changeId}.json
    end
    Note over E,C: changes/ now contains only post-watermark files
```

**Write ordering:** snapshot → manifest file → manifest pointer.
Readers loading `manifest.json` always see a consistent pair; the
snapshot file exists before any reader is directed to it.

Other devices detect epoch/floor advancement on the next `connect()`,
`pull()`, or `flush()` manifest reload. If `remoteEpoch > localEpoch`,
they `rehydrate()` from the snapshot and then pull deltas above the
watermark. If their outbox contains entries at or before `gcFloorHlc`,
flush is refused and the device aligns from the canonical snapshot.

## Bootstrap (first-ever connect)

```mermaid
sequenceDiagram
    participant E as SyncEngine
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
    E->>C: GET changes/head.json
    C-->>E: 404 (no changes yet)
    Note over E: sync:complete entriesMerged=0
```

## Rehydration (after compaction by another device)

```mermaid
flowchart TD
    A([rehydrate]) --> B{manifest.snapshotPath\nexists?}
    B -- No --> C[emit rehydrate:complete rowCount=0]
    C --> D[pull]
    B -- Yes --> E[GET snapshot file]
    E --> F{encrypted?}
    F -- Yes --> G[decodeFromCloud]
    F -- No --> H[parse JSON]
    G --> H
    H --> I[clearAll IDB]
    I --> J[write all snapshot rows to IDB]
    J --> K[restore HLC from snapshot]
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

