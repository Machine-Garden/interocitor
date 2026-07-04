# Worker audit

Audit is an operation-level worker contract.

Configure it with `runtime.audit` when creating the worker mount:

```ts
export default withInterocitor(app, {
  db: (env) => env.DB,
  runtime: {
    audit: (event, env) => {
      console.log(JSON.stringify(event));
    },
  },
});
```

The callback receives a well-known shape:

```ts
interface WorkerAuditEvent {
  event: 'interocitor.audit';
  at: string;
  op:
    | 'read'
    | 'write'
    | 'delete'
    | 'list'
    | 'metadata'
    | 'stored-file-read'
    | 'stored-file-write'
    | 'stored-file-delete'
    | 'stored-file-metadata'
    | 'system';
  prefix?: string;
  path?: string;
  pathType?: string;
  deviceId?: string;
  status: number;
  outcome: 'ok' | 'error' | 'rejected' | 'not-found';
  bytes?: number;
  taint?: string;
  systemOp?: string;
  requestId?: string;
}
```

Audit is a pure callback. The worker does not persist audit events itself; it only invokes the callback. Callback failures do not fail the request.

## Worker-visible operations

The worker emits audit events for operations it observes:

| Category | Examples |
| --- | --- |
| Mesh writes | change file write, `changes/head.json` update, `manifest.json` update, `manifest-<gen>.json` write |
| Mesh reads | manifest read, folder list, change file read, snapshot read |
| Mesh deletes | file/path delete requests |
| Stored-file operations | stored-file upload, download, delete, metadata fetch |

The `op: 'system'` value and `systemOp` field are reserved for system/maintenance handlers that opt into auditing; the standard request handlers above do not emit them.

## What the worker cannot audit

The worker cannot observe encrypted payload meaning or client-local decrypt outcomes. For tainted files, `openFile(path)` downloads ciphertext through the worker, but `sealed.open(key)` runs inside the client after the app resolves or unlocks the key. Biometric failures, missing group keys, and successful plaintext views are not visible to the worker.

Apps may record client-side view-layer or semantic events, but those reports are client-asserted and not tamper-proof.
