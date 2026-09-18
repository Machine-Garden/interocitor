# Simple questions, honest answers

Interocitor keeps app data on trusted devices and synchronizes it through
remote storage. These answers explain what it protects, how it combines
changes, and where its guarantees stop.

## Privacy and protection

### Is it true end-to-end encryption?

Yes—unless the app explicitly creates an unencrypted database. With encryption
on, rows and files are encrypted before they leave the device. Only someone
with the secret key can read them. This is the same boundary Signal, Proton,
iCloud Advanced Data Protection, and Bitwarden rely on: the operator stores what
it cannot open. Interocitor uses one shared key per mesh rather than per-message
ratcheting keys; an application that needs forward secrecy adds that layer on
top.

### Can someone else read my data?

Anyone with the secret key or control of an unlocked trusted device can.
Someone who only has access to the remote storage cannot read the protected
contents.

### Can someone still learn anything from the remote storage?

Yes. Row-sync objects use protocol names: for example, change names contain a
timestamp and device identifier, while `manifest.json` and snapshot names have
fixed protocol roles. They do not contain a client-facing filename.

Durable files follow the same rule. The path passed to `putFile()` is
replaced on the remote by a keyed hash under a key derived from the mesh key,
and the content type, plaintext size, and digest travel inside the encrypted
object. The remote can still see stored sizes, device identifiers, and when
activity happened. Encryption hides contents and names, not every operational
trace of their existence.

### What happens if someone changes the encrypted data?

Interocitor detects the change and refuses to use the damaged data. It cannot
stop the storage provider from deleting data, hiding it, or serving an older
copy.

### Is the copy on my device encrypted too?

Not by Interocitor. The local database may contain readable data, so device
encryption, screen locks, browser security, and application isolation still
matter.

### Does encryption replace login and access control?

No. Encryption protects the stored contents. The application and storage
provider still decide who may connect, upload, download, or delete data.

### What happens if I lose the secret key?

If every copy is lost, the encrypted data cannot be read. Another trusted
device or a recovery phrase can help only if recovery was set up before the
key was lost. Every built-in path carries key-strength entropy. Any other
recovery design derives the mesh key through `BoundSharedKeySource` from
inputs the host supplies and is the host's to secure; see
[shared-key scenarios](../packages/core/docs/shared-key-scenarios.md).

### What happens if someone steals the secret key?

They can read any copy of the data protected by that key. The safe response is
to create a new database with a new key and move the data; changing a login
does not make a copied key harmless.

### Can I revoke one device?

Not while keeping the same shared key. A removed device may still have a copy
of that key, so a full revocation requires a new key and a new database.

For the complete boundary, see the
[security model](../packages/core/docs/security-model.md). Key choices and
recovery are described in
[shared-key scenarios](../packages/core/docs/shared-key-scenarios.md) and
[recovery phrases](../packages/core/docs/recovery.md).

## Sync and conflicts

### How are conflicts resolved?

Changes to different fields are combined. If two devices change the same
field, the value with the greater hybrid logical clock (HLC) wins by default.
An app can instead provide a deterministic, commutative, associative, and
idempotent custom merge function so every device reaches the same result.

### What is the default conflict rule?

Defined and schema-less databases both default to HLC-based last-write-wins.
That order is deterministic across devices, but it is not proof of real-time or
causal order because each device contributes its own wall clock.

### Will every device end up with the same data?

Yes, after every device has received the same changes and used the same
conflict rules. This may take time when a device is offline.

### What happens if one device edits a row while another deletes it?

The deletion is remembered so that an older edit cannot accidentally bring the
row back. A later deliberate insert can create the row again as a fresh row.

### Can I keep working offline?

Yes for rows. Changes wait on the device and synchronize when the connection
returns. They survive an app restart only when the app uses durable local
storage; files still need a connection because they are stored remotely.

### Can I migrate application data?

Yes, through application code. Interocitor does not provide a migration runner
or decide what a data version means. An application can keep one global version,
version individual tables or rows, or simply update recognizable old data
without a version. Those updates use the normal row and file APIs.

Interocitor transports and merges row changes; the application owns when the
update runs, concurrent execution, old-client compatibility, partial completion,
and file cleanup. See the
[application-owned migration patterns](../packages/core/docs/data-migrations.md)
for examples and the exact boundary.

The exact choices are listed under
[conflict resolution](../packages/core/docs/api-reference.md#conflict-resolution) and
[deletion semantics](../packages/core/docs/api-reference.md#deletion-semantics).

## Servers, workers, and size

### Can a server, worker, or AI agent process my data?

Yes. A trusted process can join like another device, receive the secret key,
download and decrypt the rows, process them, and send changes back. Giving it
the key also gives it access to the whole row database, not just one task.

### Does the storage server process my data?

No. The bundled Cloudflare Worker stores and relays the payloads that clients
upload. For an encrypted database, clients encrypt those payloads before they
arrive; the Worker does not receive the secret key or read protected rows.
Processing needs a separate trusted program, such as a headless Python client.

### Can I let an agent see only some tables or rows?

Not with the shared database key. A process that has that key can read the
whole row database. Put sensitive data in a separate database with a separate
key, or send only the selected data to the agent through an application-owned
process.

### Can I use Interocitor rows as a job queue?

Not by themselves. Two workers can see the same task and both act on it. Work
that must happen once needs an application-owned claim, lease, or safe retry
rule.

### How many tables or databases can I have?

Interocitor sets no fixed count. One database can contain many logical tables,
and an application can use many separate databases. Each database synchronizes
independently, and every device connected to it receives all of its row tables.

### Can I shard my data?

Yes, at the application level. Split the data into separate databases; they can
share one secret so clients that know their locations and have storage access
can roam between them, or each database can use a different secret for stronger
isolation.

You can also keep a small directory database containing the locations and
secrets of the other databases. `db.connectedStores` exists for exactly this:
it persists credential records for related databases inside the parent's local
store and does nothing else; the application constructs the child engine from a
record. That directory becomes a master key: anyone who can read it can open
every database listed in it.

Interocitor does not choose shards, route requests, or join data across them.
Each shard is a normal database and becomes a full local copy when opened; the
application owns routing, cross-shard work, and key management.

See the [database storage layout](../packages/core/docs/adapter-contract.md#folder-layout-the-engine-writes)
and [shared-key scenarios](../packages/core/docs/shared-key-scenarios.md).

### Is there a database size limit?

Yes, although core does not set one universal number. Every connected device
stores the complete row database, and compaction must create and upload one
complete copy. The practical limit is whichever comes first: device storage or
memory, transfer time, snapshot size, or the storage provider's limits.

With the default Cloudflare Worker settings, one full row snapshot is limited
to 16 MiB and one change batch to 8 MiB. These values can be changed, but the
database still has to fit as a full local copy and a full snapshot. Durable
files are separate and do not count toward this row snapshot limit.

If one database grows too large, split it into smaller databases and let each
client open only the ones it needs. Opening every shard still requires the same
total local space; see [Can I shard my data?](#can-i-shard-my-data).

### Is 16 MiB enough?

It depends on how much data each ticket contains. A 16 MiB encrypted snapshot
holds about 12 MiB of snapshot JSON after encryption and encoding overhead.
These illustrative estimates include Interocitor's per-field sync metadata:

| Ticket contents                                                        | Snapshot data per ticket | Approximate maximum | Planning target |
| ---------------------------------------------------------------------- | -----------------------: | ------------------: | --------------: |
| Summary, status, people, dates, and labels only                        |                  1.0 KiB |      12,000 tickets |   9,000 tickets |
| Adds a 1.5 KiB description, about 1 KiB of comments, and custom fields |                  4.7 KiB |       2,600 tickets |   1,900 tickets |
| Adds a 5 KiB description, about 10 KiB of comments, and change history |                 20.5 KiB |         600 tickets |     400 tickets |

Attachments do not count when their bodies are stored as durable files, but
attachment names and references stored in rows do. Other row tables also
count, so users, projects, separate comment rows, and application data all
reduce the ticket total. The safest check is to compact a representative test
database, measure its snapshot, and leave at least 25% free for growth.

### Can I disable the full local copy?

No. Row synchronization requires a local store and does not support
selective tables, selected rows, or remote-only queries. A memory-only store
forgets the data after shutdown, but it still holds the full row database in
memory while running.

For implementation choices and exact limits, see the
[headless-worker guide](../packages/interocitor-python/README.md#connect-a-real-worker),
[server trust boundary](../packages/workers/docs/security-guardrails.md#what-the-server-can-and-cannot-read),
[local-store contract](../packages/core/docs/api-reference.md#local-store-contract),
and
[Worker limits](../packages/workers/docs/runtime-options.md#request-body-and-storage-limits).

## Compaction

### How is data compacted?

Interocitor replaces a long list of small changes with one full copy of the
current row data. Once that full copy is stored, the old changes it already
contains can be removed. The data stays the same; the history becomes shorter.

### Can compaction delete current data?

It removes only old changes that are already included in the new full copy.
A device that missed those changes downloads the full copy instead. Larger
deployments should let one trusted process perform compaction so two devices do
not compete.

### What happens to deleted rows?

A small deletion marker is retained in snapshots so an older device cannot
bring the row back. The protocol does not garbage-collect tombstones. Offline
expiry prevents stale queued writes from publishing automatically, but it does
not prove that a tombstone is safe to delete.

### Are files compacted?

No. Files stay as separate files until the app overwrites or deletes them, or
the storage provider loses them.

The detailed process and its limits are in
[compaction](../packages/core/docs/compaction.md).

## Keeping and recovering data

### Where can I store my data?

Wherever you choose: your Google Drive, a WebDAV server or home NAS, your own
Cloudflare deployment, or another backend through a custom adapter.
Interocitor is not a hosting service and does not take custody of the data.
Your data, your storage, your responsibility: you own access, cost, quotas,
backups, retention, availability, and the provider you trust.

See the available [storage adapters](../packages/core/README.md#mailbox-adapter).

### How is my row data preserved?

On a device, rows and unsent changes live in the local database. Remotely,
Interocitor stores changes and occasional full copies so another device can
catch up or rebuild; these are encrypted when encryption is on. A temporary
memory-only database does not survive a restart.

### What happens to a device that stays offline for a long time?

In `@interocitor/core`, a device absent longer than the mesh's finite
`retention.maxOfflineDurationMs` rebuilds from the latest full copy instead of
publishing its old queue. The default is 30 days. Its queued operations remain
in a local quarantine for export, review, or deliberate reapplication; they do
not enter shared history automatically. Do not leave important unsynchronized
work on a disconnected device as the only copy until that deadline.

### How long does the mailbox keep my data?

The protocol does not decide; the storage owner does. A deployment may reclaim
a mesh that has gone unwritten for a configured period, measured in writes
rather than reads, because every trusted device already holds what a reader is
reading. One year is the recommended figure, and it must exceed
`retention.maxOfflineDurationMs`. A plain bucket or WebDAV server states its
policy only in its own documentation; treat an unstated limit as unknown, not
as unlimited.

### If the mailbox is reclaimed, is the data gone?

Not while a trusted device still holds a copy. The mesh identity survives and
is marked evicted; every device that reconnects republishes its own rows with
their original clocks, and last-writer-wins settles the overlaps. It takes all
of them, because no single device holds what the others alone observed. File
bodies are the
exception — no device caches them, so rows return pointing at bytes that a
sweep may have kept or a lifecycle rule may have expired.

That also means reclamation is not erasure. A deletion that must hold means
revoking the mesh address and rotating to a new mesh, so remaining copies
cannot rejoin.

See [data retention](site/content/retention.md).

### Is remote storage a backup?

Not automatically. If the storage provider loses every copy, Interocitor
cannot recreate the missing data. Important deployments should use provider
backups, version history, or an independent second copy and should test
restoration.

### Does a recovery phrase restore everything?

No. It can restore the secret key and the information needed to find the
database. It cannot restore deleted data, a storage-provider login, or an
application account.

### What should I trust?

Trust authorized devices with readable data and the secret key. Trust the
storage provider to keep data available and return honest copies. You do not
need to trust it with protected contents. Encryption protects privacy; backups
and reliable storage protect availability.
