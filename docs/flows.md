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
    A([init]) --> B[open IDB\nrestore HLC + table names]
    B --> C([connect])
    C --> D{adapter\nauthenticated?}
    D -- No --> E[adapter.authenticate]
    E --> D
    D -- Yes --> F["ensureFolder ×4\nremotePath → devices\n→ mainline → changes"]
    F --> G[loadOrCreateManifest]
    G -- no manifest.json --> H[createBootstrapManifest\nmanifest-1 + manifest.json]
    H --> G
    G -- found --> I[validate content hash\ncheck schema version\ncheck server auth if managed]
    I --> J{localEpoch\n< remoteEpoch?}
    J -- Yes: new snapshot --> K[rehydrate]
    K --> K1[GET snapshotPath from manifest]
    K1 --> K2[clearAll IDB]
    K2 --> K3[write snapshot rows to IDB\nrestore HLC]
    K3 --> L
    J -- No --> L[pull change files]
    L --> M[flush outbox]
    M --> N[flush to replicas\nbest-effort]
    N --> O([startPolling every N ms])
```

**Offline guarantee:** `init()` never touches the network. After `init()`,
`put()`, `delete()`, `get()`, `query()`, and `queryWhere()` all work
against local IndexedDB. `connect()` is the first network call.

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

