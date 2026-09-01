<p align="center">
  <a href="https://github.com/Machine-Garden/interocitor">
    <img src="https://raw.githubusercontent.com/Machine-Garden/interocitor/main/docs/assets/hero.svg" alt="Interocitor" width="560" />
  </a>
</p>

# Interocitor for Python

interocitor is an async Python implementation of the Interocitor core protocol.
It lets a Python process read and write local-first CRDT rows and durable files
in the same mesh as [@interocitor/core](../core/README.md). A key source
encrypts row and file contents. It is useful for headless workers, automation,
and protocol integrations; it is not a job queue, ORM, database server, or
credential service.

The default MemoryLocalStore is intentionally memory-only: a normal
disconnect clears its rows, outbox, and mesh cache. A short-lived worker should
therefore treat the remote mesh as its durable shared state and call flush()
before it reports work as successful.

The two data surfaces have different behavior:

| Surface       | What Python does                                                                                                               | Important boundary                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Rows          | Reads and writes a local CRDT cache, then exchanges changes and snapshots with the mesh. A key source encrypts their contents. | tasks are logical collections, not remote database tables or atomic jobs.                               |
| Durable files | Reads and writes bytes at an application path. A key source encrypts their contents.                                           | File operations are direct remote calls, not part of the row outbox or a transaction with a row update. |

Two workers can observe the same task row and both perform its side effect.
Use an application-owned transactional claim, lease, or idempotency mechanism
when work must run once; use Interocitor rows for shared convergent state and
files for its encrypted artifacts.

## Install

Python 3.11 or newer is required. Install from a repository revision:

```bash
python -m pip install "git+https://github.com/Machine-Garden/interocitor.git#subdirectory=packages/interocitor-python"
```

For a local checkout, use editable mode while developing:

```bash
python -m pip install -e packages/interocitor-python
```

Release maintainers can include the package's test runner with the `test`
extra:

```bash
python -m pip install -e "packages/interocitor-python[test]"
```

Pin the Git URL to a tag or commit for a production deployment. The package
does not load .env files or manage secret storage: a launcher or application
owns that choice and passes resolved values to Interocitor.

## Define a logical tasks collection

mesh.table("tasks") selects a logical CRDT collection. It does not create a SQL
table, call remote DDL, or declare a job queue. The first put, patch, or add
creates a row with a particular ID.

Use Schema and TableSchema to make the collection's intended fields, merge
policy, and optional compatibility version visible next to the client setup.
This runnable example writes a task row and its input file to an in-memory mesh:

```python
import asyncio

from interocitor import Interocitor, MemoryAdapter, Schema, TableSchema, types


TASK_SCHEMA = Schema(
    version=1,
    tables={
        "tasks": TableSchema(
            fields={
                "state": types.enum("queued", "running", "complete", "failed"),
                "inputPath": types.string,
                "resultPath": types.string.optional,
                "attempt": types.number,
            },
            # Make task-field conflicts choose the highest HLC explicitly.
            merge="lww",
        ),
    },
)


async def main() -> None:
    mesh = Interocitor(
        MemoryAdapter(),
        remote_path="/task-example",
        schema=TASK_SCHEMA,
    )
    await mesh.connect()
    try:
        tasks = mesh.table("tasks")
        await mesh.put_file("tasks/task-1/input.bin", b"input", "application/octet-stream")
        await tasks.put(
            "task-1",
            {
                "state": "queued",
                "inputPath": "tasks/task-1/input.bin",
                "attempt": 1,
            },
        )

        task = await tasks.row("task-1")
        assert task is not None
        assert await mesh.get_file(task["inputPath"]) == b"input"
        await mesh.flush()
    finally:
        await mesh.disconnect()


asyncio.run(main())
```

MemoryAdapter makes the example self-contained. A real adapter persists the
mesh artifacts; a configured key source encrypts their contents.
MemoryLocalStore remains the default local cache and is cleared on
disconnect().

## What a Python schema means

The Python schema has the same logical shape as core's
DatabaseSchemaDefinition:

| Python declaration                                   | Purpose                                                                                                                    |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Schema(tables=...)                                   | Names logical collections and optionally sets version and a database-wide merge_strategy.                                  |
| TableSchema(fields=..., merge=...)                   | Declares intended fields and a table-wide merge policy.                                                                    |
| TableMergeConfig(strategy=..., fields=...)           | Sets a table default plus field-specific merge overrides.                                                                  |
| types.string, number, boolean, date, json, enum(...) | Field descriptors matching core's vocabulary. .optional, types.index(...), and types.unique(...) create matching metadata. |
| TableIndex(...)                                      | Explicit index metadata accepted in a core-shaped schema.                                                                  |

The recommended Schema builder validates the declaration early. A raw
core-shaped mapping is also accepted when an application shares configuration
with JavaScript:

```python
TASK_SCHEMA = {
    "version": 1,
    "tables": {
        "tasks": {
            "fields": {"state": {"kind": "enum"}},
            "merge": "lww",
        },
    },
}
```

Malformed builder declarations raise SchemaError immediately. A malformed raw
mapping raises it while Interocitor is constructed, before local initialization
or remote I/O.

### What fields and indexes do not do

Schemas are local client configuration, not a runtime validator. Python field
descriptors do not reject unknown columns, type mismatches, or enum
values; unique does not enforce uniqueness; and a schema does not prevent
mesh.table("another-name"). Validate application input with your own models or
validation library before writing it.

The package provides `MemoryLocalStore`, which scans local rows. `index`,
`unique`, and `TableIndex` are compatible metadata for the core schema
shape; they do not create a Python index or improve query performance. They
also never provide mesh-wide uniqueness or an atomic task claim.

Only Schema.version crosses the wire, as manifest.schema. Field definitions,
indexes, and merge functions never leave the client. Every client that uses a
mesh therefore needs compatible data meaning and merge policy; matching a
version number alone does not prove that they are identical.

### Choose a merge policy deliberately

Catch-up records exact immutable change filenames. The global HLC cursor and
`head.json` are ordering/invalidation hints, not proof that every older file
was observed; a queued change published late is still listed and merged.

Interocitor resolves a conflicting column in this order:

1. TableMergeConfig(fields={...}) for that field.
2. The table's merge or TableMergeConfig(strategy=...).
3. Schema(merge_strategy=...).
4. The default: **"lww"**.

The built-in policy matches core:

- "lww" accepts the column with the higher hybrid logical clock (HLC).
  A missing local column always accepts the incoming value. Deletions use their
  own HLC tombstone rules rather than a field merge policy. Python also accepts a
  custom callable merge strategy, but it must be deterministic, commutative,
  associative, and idempotent. Its code is not transmitted, so every client must
  implement equivalent behavior or replicas can diverge.

### Treat version as a compatibility gate

version is optional. When set, a client writes it when bootstrapping a mesh and
rejects a manifest with a different version. It does not migrate rows, create
indexes, publish field definitions, or change a mesh's version by itself. Omit
it when no explicit compatibility gate is needed; an omitted version does not
reject an existing manifest.

Data migration is application-owned. An application can keep one global
version, version individual tables or rows, or simply update recognizable old
data without a version. Do not rely on merely changing Schema.version to
transform existing data. The [core data migration guide](../core/docs/data-migrations.md)
shows these patterns and the guarantees Interocitor deliberately does not add.

## Connect a real worker

The following **illustrative** worker step assumes the host application has
already loaded its configuration, supplied TASK_SCHEMA, and chosen how to
validate task input. The Cloudflare I/O URL includes /io/<address>.

```python
import asyncio
import os

from interocitor import CloudflareAdapter, Interocitor, PortablePassphraseKeySource
from my_application.schema import TASK_SCHEMA


async def run_one_task() -> None:
    env = os.environ
    mesh = Interocitor(
        CloudflareAdapter(
            base_url=env["INTEROCITOR_IO_URL"],
            token=env["INTEROCITOR_MESH_BEARER"],
        ),
        remote_path=env["INTEROCITOR_REMOTE_PATH"],
        key_source=PortablePassphraseKeySource(
            portable_key=env["INTEROCITOR_PORTABLE_KEY"],
            generate_if_missing=False,
        ),
        schema=TASK_SCHEMA,
        device_name=env.get("INTEROCITOR_WORKER_NAME", "python-worker"),
        device_type="worker",
        expected_mesh_id=env.get("INTEROCITOR_MESH_ID"),
        require_existing_mesh=True,
        require_encryption=True,
    )

    async with mesh:
        task_id = env["INTEROCITOR_TASK_ID"]
        tasks = mesh.table("tasks")
        task = await tasks.row(task_id)
        if task is None:
            return

        source = await mesh.get_file(task["inputPath"])
        result_path = "tasks/{}/attempts/1/result.bin".format(task_id)
        await mesh.put_file(result_path, source, "application/octet-stream")
        await tasks.patch(
            task_id,
            {"state": "complete", "resultPath": result_path},
        )

        # Required before reporting application-level task success.
        await mesh.flush()


asyncio.run(run_one_task())
```

require_existing_mesh=True stops a path typo from bootstrapping a new mesh.
require_encryption=True fails closed if a key source does not yield an encrypted
mesh key. expected_mesh_id is an additional guard when the host knows the
expected mesh.

Do not use a stable worker label as device_id across concurrent invocations. It
is an HLC node identifier, not authentication identity. Leave it unset for a
fresh per-invocation ID, use device_name for a human label, and put the stable
workload identity in the transport credential or application layer.

flush() is the delivery boundary for row changes. disconnect() attempts a final
flush but intentionally ignores its failure while clearing the memory store; it
cannot acknowledge a completed task on the application's behalf.

## Lifecycle, rows, and files

| Call                                                       | Behavior                                                                                                                                                      |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| await mesh.init()                                          | Opens the local store and resolves the key source. It does not contact the adapter.                                                                           |
| await mesh.connect() or async with mesh                    | Authenticates, loads or joins the mesh, pulls changes, and flushes the local outbox.                                                                          |
| mesh.table(name)                                           | Returns a Table handle for row/get, query, where, put, patch, add, and delete.                                                                                |
| await mesh.pull()                                          | Merges available remote row changes after a connection has been established.                                                                                  |
| await mesh.flush()                                         | Uploads queued local row changes. Call it before an external success acknowledgement.                                                                         |
| await mesh.put_file/get_file/delete_file/get_file_metadata | Reads or writes durable bytes directly through the adapter; a key source encrypts their contents.                                                             |
| await mesh.compact()                                       | Publishes a snapshot, removes its exactly covered changes and superseded snapshots, and retains tombstones. Designate one checkpoint writer per managed mesh. |
| await mesh.disconnect()                                    | Ends the session and clears the default volatile local store.                                                                                                 |

Rows may be created or patched after init() and before connect(). Snapshot
rehydration rebases that queued work. Every immutable change remains eligible
for publication and pull regardless of its HLC relative to a snapshot
watermark.

## Keys, encryption, and recovery

PortablePassphraseKeySource receives a caller-owned full mesh key. The transport
bearer authorizes a request to the adapter; the portable key decrypts the whole
mesh. Keep both in the host's secret boundary and never put either in a row,
durable file path, or log.

The Python package does not prescribe where a local worker gets that key. A
launcher may pass an environment variable, a secret manager value, or the
result of an application-specific bootstrap procedure. A recovery phrase is an
optional way to unwrap existing mesh credentials, not a different access mode:
recover_mesh_credentials(...) returns the remote path, portable key, and mesh
ID, while the application still supplies the adapter URL and transport bearer.
See the [core recovery guide](../core/docs/recovery.md) and
[security model](../core/docs/security-model.md) for those boundaries.

## Core compatibility and current scope

Python uses the version-3 manifest, change, snapshot, HLC, and AES-GCM envelope
formats used by @interocitor/core. The public schema shape and merge defaults
above deliberately match core. Its runtime scope is intentionally smaller:

| Available here                                                                                                                           | Not provided by this package                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Memory and Cloudflare adapters, volatile local state, encrypted rows/files, explicit pull/flush, manual compaction, and phrase recovery. | Browser local stores, durable Python local storage, pairing, replica replication, background polling, relay invalidation, query caches/row handles, extra-key sealed files, and a task-claim protocol. |

For remote adapter behavior, artifact layout, compaction rules, and the full
metadata/security model, use the corresponding core documentation:

- [Adapter contract](../core/docs/adapter-contract.md)
- [Compaction](../core/docs/compaction.md)
- [Security model](../core/docs/security-model.md)
- [Recovery](../core/docs/recovery.md)

## Public entry points

| Entry point                                                                    | Use it for                                                                                           |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Interocitor and Table                                                          | Lifecycle, CRDT row operations, manual sync/compaction, and durable file operations.                 |
| Schema, DatabaseSchema, TableSchema, TableMergeConfig, types, normalize_schema | Local schema declarations, core-compatible merge policy, and conversion of raw core-shaped mappings. |
| MemoryLocalStore, MemoryAdapter, CloudflareAdapter                             | Volatile local state and the provided transports.                                                    |
| PortablePassphraseKeySource                                                    | A caller-supplied portable full-mesh key. It does not read environment variables.                    |
| recover_mesh_credentials, create_recovery_wrapper, publish_recovery_wrapper    | Optional recovery phrase wrappers.                                                                   |
| encrypt_entry, encrypt_bytes, decrypt_entry, decrypt_bytes, and wire types     | Advanced protocol integration and interoperability tooling.                                          |

Interocitor raises MeshNotFoundError for an existing-mesh guard with no
manifest, MeshMismatchError for a wrong expected/payload mesh ID, and
MeshEncryptionMismatchError when the local key configuration disagrees with the
manifest. Adapter failures propagate. An undecryptable or corrupt remote
change/snapshot poisons the active remote session; disconnect and reconnect
only after fixing the key or remote data problem.
