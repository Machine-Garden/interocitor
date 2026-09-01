# Sync completeness, convergence, and integrity

Interocitor must not report a client as caught up merely because it has seen a
large logical timestamp. In a mesh, change creation order and remote publication
order are different: a device can create a change offline, then publish its file
after another device has advanced the global HLC head.

This page separates three questions that are easy to conflate:

1. **Completeness:** which immutable change files has this client observed?
2. **Convergence:** do clients that observed the same changes derive the same
   state?
3. **Integrity:** can a client detect missing, altered, or inconsistently applied
   history?

## Protocol rule

Exact immutable change filenames are the authoritative observation record.
`head.json`, a scalar cursor, and per-writer HLC frontiers are hints;
none proves that every lower HLC was observed.

On pull, a client lists remaining change files and applies every filename absent
from its local receipt set. A successful local flush records its own filenames
before publication, so a receipt-storage failure cannot leave an authoritative
file locally unrecorded. The durable outbox is only acknowledged after primary
publication; retries use the same immutable IDs. Row mutation plus pending
batch, and pending batch plus outbox promotion, are atomic local-store commits.
Concurrent pull and flush commits merge under one per-store observation writer.
Receipts survive incomplete or non-monotonic listings. On snapshot restore, the
exact receipt set carried by the retained snapshot becomes the authoritative
base.

Compaction writes the exact observed filename set into the snapshot as
`coveredChangeFiles`. Rehydrate restores that set as receipts before catch-up.
After publishing the snapshot and manifest pointer, compaction deletes exactly
that set. A file that appears during compaction is absent from the captured set
and therefore survives regardless of whether its HLC is below the snapshot
watermark. Deployments must serialize compaction because concurrent pointer
updates and deletion are not safe without CAS or a lease.

Compaction holds the local sync-state lock, promotes and publishes completed
batches, pulls remote changes, and then captures exact receipts and rows. A
write or explicit batch is therefore wholly before or wholly after that cut.

This makes a new client and an existing client the same algorithm with different
starting receipts:

- a new client starts with snapshot receipts and applies every remaining file;
- an existing client subtracts its exact receipts and applies every unseen
  remaining file.

Provided the remote eventually lists every remaining immutable file, clients that
observe the same file set converge under the built-in LWW policy. Core emits
`sync:late-change` when a newly observed file falls behind the client's prior
global or writer frontier, making the condition observable.

## Conflict order is separate from catch-up progress

HLC is used to choose a value, not to prove delivery. The built-in replicated
merge policy is LWW: the column entry with the greater HLC wins regardless of
discovery direction or publication order.

One device generates strictly increasing HLC values, but cross-device order
still depends on their wall-clock components. It is a deterministic conflict
order, not proof of causality or real-time precedence.

`local-wins` and `remote-wins` are not convergent mesh policies because each
peer assigns “local” and “remote” to different values. An equal HLC with a
different wire value is protocol corruption. A custom merge must be
deterministic, commutative, associative, and idempotent.

## How established systems approach the boundary

These systems use different data models, but they consistently avoid treating a
cross-writer timestamp as proof of complete history.

| System             | Relevant mechanism                                                                                                                                                                                                               | Design lesson for Interocitor                                                                                                                                                                                                                                                                                                           |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Automerge          | Changes are content-addressed, carry actor sequence numbers and dependency hashes, and form a graph summarized by heads. Concurrent assignments use deterministic operation identifiers, while losing values remain inspectable. | Stable change identity and dependency structure prove history; merge direction does not select a winner. See [storage](https://automerge.org/docs/reference/under-the-hood/storage/), [binary format](https://automerge.org/automerge-binary-format-spec/), and [conflicts](https://automerge.org/docs/reference/documents/conflicts/). |
| Git                | Fetch negotiates exact object IDs through wants and haves, and object connectivity/integrity can be checked independently.                                                                                                       | Exchange concrete immutable identities and graph reachability instead of inferring completeness from time. See [protocol v2](https://git-scm.com/docs/protocol-v2), [data model](https://git-scm.com/docs/gitdatamodel), and [`git fsck`](https://git-scm.com/docs/git-fsck).                                                           |
| CouchDB            | Replication checkpoints progress, then requests exact missing revisions with `revs_diff`; divergent revision leaves are retained and a deterministic winner is exposed.                                                          | A checkpoint is paired with exact revision identity, and conflict resolution is independent of push/pull direction. See the [replication protocol](https://docs.couchdb.org/en/stable/replication/protocol.html) and [conflict model](https://docs.couchdb.org/en/stable/replication/conflicts.html).                                   |
| Yjs                | Updates are commutative, associative, and idempotent; structs have stable `(clientID, clock)` identities.                                                                                                                        | Convergence depends on stable operation identity and algebraic merge properties, not arrival-relative policies. See [custom provider semantics](https://docs.yjs.dev/tutorials/creating-a-custom-provider) and [Yjs internals](https://github.com/yjs/yjs/blob/main/INTERNALS.md).                                                      |
| Kafka              | A scalar offset is meaningful within one broker-serialized partition. Ordering across partitions is not collapsed into one completeness cursor.                                                                                  | Scalar progress is safe only where a single authority creates a contiguous total log. See [Kafka design](https://kafka.apache.org/41/design/design/).                                                                                                                                                                                   |
| Secure Scuttlebutt | Each author publishes a contiguous sequence and hash-linked feed; peers summarize progress per author.                                                                                                                           | A per-writer frontier proves completeness only when the writer stream is contiguous and hash-linked. See the [Scuttlebutt protocol guide](https://ssbc.github.io/scuttlebutt-protocol-guide/).                                                                                                                                          |
| Dynamo             | Vector clocks distinguish causal ancestry from concurrency; incomparable versions can be returned together for reconciliation.                                                                                                   | Causal progress and conflict policy are distinct, and concurrent values need a stable resolution rule. See the [Dynamo publication and paper](https://www.amazon.science/publications/dynamo-amazons-highly-available-key-value-store).                                                                                                 |

The comparison supports exact receipts as the immediate fit for Interocitor's
existing one-change-per-file storage model. It also shows why a per-writer HLC
alone is insufficient: HLC values are not contiguous, so a frontier cannot show
whether an intermediate publication is missing.

## What checksums can and cannot guarantee

A canonical state hash can detect that two clients derived different state. It
cannot prove that the remote disclosed every change: a withheld change and its
withheld checksum are indistinguishable to a client that has no independent
commitment to that history.

Likewise, CRC32 is suitable for accidental-error detection, not adversarial
integrity. Any protocol integrity commitment should use a cryptographic hash
such as SHA-256.

The exact-receipt design guarantees catch-up against an honest,
eventually consistent remote that eventually lists remaining files. It does not
cryptographically prove completeness against a remote that withholds both a
change and every reference to it. The [security model](security-model.md)
continues to treat remote withholding and rollback as threats.

## Cryptographic completeness boundary

Exact receipts do not provide a cryptographic completeness commitment. Adding
that property requires a different wire contract with these elements:

1. Give each writer a contiguous `publishSeq` independent of HLC.
2. Publish an immutable batch manifest containing `writerId`, `publishSeq`, the
   previous batch hash, and each change filename plus SHA-256 ciphertext hash.
3. Advance a mutable per-writer head only after the batch files and manifest are
   durable.
4. Treat the vector of writer heads as the history commitment used by catch-up
   and compaction.
5. Maintain a separate canonical CRDT state root to detect deterministic-merge
   or implementation failures after the same committed history is observed.

This would make gaps and mutations within a published writer history
detectable. Detecting a malicious sole remote that hides an entire unpublished
head still requires an independent witness such as peer gossip, a trusted
checkpoint, or quorum storage.

The protocol constraints are recorded in
[Sync completeness and deterministic merge](decisions/sync-completeness.md).
