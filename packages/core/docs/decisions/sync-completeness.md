# Sync completeness and deterministic merge

Interocitor treats delivery completeness and conflict resolution as separate
protocol responsibilities. A logical timestamp orders mutations; it cannot
prove that every immutable change file has been observed.

## Decision

1. Exact immutable change filenames are the authoritative local observation
   record.
2. Every pull lists retained change files and skips only exact receipts.
3. `head.json`, scalar cursors, and per-writer HLC frontiers are hints and
   diagnostics, never completeness proofs.
4. HLC orders conflicting column values. LWW is the only built-in replicated
   merge policy.
5. Perspective-relative `local-wins` and `remote-wins` policies are invalid in
   a peer mesh.
6. Equal HLC with unequal wire values is protocol corruption.
7. Custom merge functions must be deterministic, commutative, associative, and
   idempotent.
8. Core emits `sync:late-change` when an unseen file is discovered behind an
   observed global or writer frontier.
9. A snapshot names its exact `coveredChangeFiles`, and rehydrate restores that
   set as receipts before catch-up. Every mesh retains every change file until
   the adapter contract gains a safe remote publication barrier.
10. Observation metadata commits are serialized per local store and merge exact
    identities. Primary flush persists its receipts before remote publication;
    replica publication is private to that primary operation.
11. Reset and snapshot replacement use the same observation gate and invalidate
    ledgers loaded against the prior local state, so stale receipts cannot
    reappear after a mesh reset or rehydrate.
12. Local mutation plus pending batch, and pending-batch promotion to outbox,
    are atomic store commits. Flush peeks, publishes, then acknowledges exact
    IDs; compaction holds the sync-state lock through flush, pull, and capture.
13. No scalar GC floor exists. Tombstones remain in snapshots, and reconnect
    publishes an old client's durable work before snapshot replacement.

## Why the decision is correct

Completeness is set-based: a client can name every retained file it has
observed. Convergence is order-independent: clients with the same file set
choose the same LWW winners, and duplicate delivery is idempotent. Compaction
uses concrete snapshot coverage as a receipt base, never an HLC range.

This separates “have I received this mutation?” from “which mutation wins?” and
makes late publication observable without assigning delivery semantics to HLC.

## Implementation ownership

Correctness is centralized by invariant, while `sync-engine.ts` coordinates the
lifecycle:

| Concern                                                                     | Single owner                     | Callers                                                       |
| --------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------- |
| Exact receipts, frontiers, filename parsing, and late-change classification | `src/core/change-observation.ts` | pull, primary flush, connect fast path, compaction, rehydrate |
| Conflict ordering and equal-HLC validation                                  | `src/core/crdt.ts`               | local and remote row application                              |
| Authoritative publication and receipt recording                             | `src/core/flush.ts`              | sync-engine flush orchestration                               |
| Snapshot coverage and restore                                              | `src/core/compaction.ts`         | sync-engine maintenance orchestration                         |
| Remote decode and merge pipeline                                            | `src/core/pull.ts`               | sync-engine pull orchestration                                |

`sync-engine.ts` does not parse observation metadata or construct change
filenames. A source-ownership test rejects those bypasses, including access to
the low-level adapter publisher outside `flush.ts`.

## Invalid substitutions

- **One global HLC cursor:** independent writers can publish lower-HLC files
  after the cursor advances.
- **One HLC frontier per writer:** HLCs are not contiguous, so a frontier does
  not reveal a missing intermediate publication. A per-writer frontier becomes
  proof only with a contiguous sequence or hash chain.
- **A changing `head.json` alone:** invalidation does not identify the concrete
  missing file or prove a complete retained set.
- **Snapshot watermark as a retention boundary:** a lower-HLC file can be
  published after snapshot capture, so a scalar watermark cannot authorize
  deletion.
- **Destructive compaction without CAS:** competing processes can use the same
  authorized server identity and select different snapshots. Every mode retains
  immutable history until remote mutual exclusion is enforceable.
- **A state checksum as catch-up progress:** a mismatch detects divergence but
  does not identify missing history; a match cannot prove that the remote has
  no withheld change.
- **CRC32 for integrity:** CRC32 is not collision-resistant. Protocol history
  and state commitments require a cryptographic hash such as SHA-256.
- **Arrival-relative conflict policies:** “local” and “remote” reverse between
  peers, so the same mutations can produce different winners.

## Consequences

- Pull performs a retained-file listing for correctness. A reload fast path may
  avoid change-file reads only after verifying that all listed filenames have
  exact receipts.
- Receipt metadata grows with observed history. Snapshot restore replaces it
  with the snapshot's concrete coverage set.
- Concurrent pull and flush cannot overwrite each other's receipt commits. A
  receipt write failure prevents authoritative publication; a later remote
  failure leaves the same pre-receipted immutable identity durably queued.
- A crash cannot separate a row mutation from its pending batch, remove an
  outbox entry before publication, or expose part of a completed batch through
  compaction.
- Core, Python, and Swift apply the same late-publication and conflict-ordering
  rules.
- The guarantee assumes an honest remote eventually lists retained files. A
  remote that withholds both a change and every commitment to it remains outside
  this guarantee.

## Established-system evidence

The full comparison is maintained in
[Sync completeness, convergence, and integrity](../sync-completeness.md). Its
primary sources include:

- [Automerge storage and change heads](https://automerge.org/docs/reference/under-the-hood/storage/)
- [Git protocol v2 object negotiation](https://git-scm.com/docs/protocol-v2)
- [CouchDB replication protocol](https://docs.couchdb.org/en/stable/replication/protocol.html)
- [Yjs update properties](https://docs.yjs.dev/tutorials/creating-a-custom-provider)
- [Kafka partition ordering](https://kafka.apache.org/41/design/design/)
- [Secure Scuttlebutt per-author feeds](https://ssbc.github.io/scuttlebutt-protocol-guide/)
- [Dynamo causal versioning](https://www.amazon.science/publications/dynamo-amazons-highly-available-key-value-store)

## Cryptographic completeness

Exact receipts prove what a client has observed from an eventually complete
listing. Cryptographic proof of published history additionally requires a
contiguous per-writer `publishSeq`, SHA-256 hash-chained batch manifests,
per-writer heads, and a separate canonical CRDT state root. Detecting a remote
that hides an entire head requires an independent witness such as peer gossip,
a trusted checkpoint, or quorum storage.
