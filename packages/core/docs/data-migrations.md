# Migrate application data

Interocitor transports and merges application writes; it does not elect a
migration owner or run schema transformations. Use the normal table and file
APIs to write the desired representation, and let the application own version
markers, coordination, validation, and cleanup.

The examples below are illustrative fragments. They assume an initialized
`db`, application row types, and a stored `id` field whose value is the
Interocitor row ID.

## Choose a coordination policy

Before changing data, decide who may run the transformation:

- Run it on one designated trusted endpoint, protected by an
  application-owned lease, when side effects must be serialized.
- Run it on every endpoint only when repeated and concurrent execution is
  deterministic and idempotent.
- Run it lazily on read or write when records may safely coexist at different
  application versions.

`db.batch()` publishes one CRDT change entry. It is not a distributed lock and
does not provide exactly-once execution.
The application must also record enough progress to validate or resume a
partially completed transformation after a crash or interrupted release.

## Use one application data version

Store a version in a well-known row and advance it in the same local batch as
the transformed records:

```ts
const meta = db.table("app_meta");
const tasks = db.table("tasks");
const state = await meta.row("data");

if (state?.version === 1) {
  const rows = await tasks.query();

  await db.batch(async () => {
    for (const task of rows) {
      await tasks.patch(task.id, {
        status: task.done ? "done" : "open",
      });
    }
    await meta.patch("data", { version: 2 });
  });
}
```

Use this pattern when the application can name one current representation and
coordinate clients that do not yet understand it.

## Version a table or row

Keep a version on each row when records may be upgraded independently:

```ts
const tasks = db.table("tasks");

async function readTask(taskId: string) {
  const task = await tasks.row(taskId);
  if (!task || task.dataVersion !== 1) return task;

  return tasks.patch(taskId, {
    dataVersion: 2,
    status: task.done ? "done" : "open",
  });
}
```

A table-wide variant keeps the marker in a well-known metadata row for that
table. The application decides whether to transform on read, on write, in a
background task, or during a coordinated release.

## Transform recognizable data without a version

When the prior representation is unambiguous and the update is safe to repeat,
transform matching rows directly:

```ts
const tasks = db.table("tasks");
const rows = await tasks.query();

await db.batch(async () => {
  for (const task of rows) {
    if (task.status === undefined) {
      await tasks.patch(task.id, {
        status: task.done ? "done" : "open",
      });
    }
  }
});
```

These writes have the same merge behavior as other application writes. Core
does not decide which concurrent transformation is semantically correct.

## Keep compatibility separate from transformation

`schema.version` is an optional manifest compatibility gate. Core records it
when a mesh is created and rejects a client that later supplies a different
value. Changing it does not transform data or advance an existing mesh's
version. Application `version` or `dataVersion` fields are unrelated to this
gate.

Local `types.index(...)` changes are maintained by the local-store schema and
do not require an application data version.

Run a transformation that needs current remote rows after `connect()` or an
explicit `pull()`. `onInit` runs before the remote session and sees only the
current local state.

Durable files are direct remote objects rather than CRDT rows. File conversion,
progress tracking, switchover, and deletion are also application-owned, and
file operations are not included in `db.batch()`.

For merge and lifecycle behavior, see the [Core API
reference](api-reference.md). For remote completeness and integrity boundaries,
see [Sync completeness, convergence, and integrity](sync-completeness.md).
