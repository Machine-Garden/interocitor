# Worker audit

After terminal mesh, stored-file, or recovery storage operations, the Worker
can emit a structured event through `runtime.storageOperationAudit`. It does
not persist those events, identify the caller, or observe client-side decrypt
outcomes; the host owns the audit sink and any request-identity context.

The first snippet is an illustrative mount fragment; supply the surrounding
Worker and D1 binding. Import `WorkerAuditEvent` from the package root when
typing application code; the shape below is a human-readable reference.

Configure it with `runtime.storageOperationAudit` when creating the worker mount:

```ts
import { withInterocitor } from '@interocitor/workers';

export default withInterocitor(app, {
  db: (env) => env.DB,
  runtime: {
    meshIntegrityGates: [({ address }) => address === 'main'],
    storageOperationAudit: (event, env) => {
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
    | 'recovery-read'
    | 'recovery-write'
    | 'stored-file-read'
    | 'stored-file-write'
    | 'stored-file-delete'
    | 'stored-file-metadata';
  address?: string;
  path?: string;
  pathType?: string;
  status: number;
  outcome: 'ok' | 'rejected' | 'not-found';
  bytes?: number;
  taint?: string;
  requestId?: string;
}
```

The callback is awaited, so its latency adds request latency. The Worker does
not persist events, and callback failures do not fail the request.

For request-level policy auditing, place an audit layer before authorization in
`runtime.meshMiddleware`. It can call `next()`, observe the final response
status, and record rejected requests as well as accepted operations.

## Worker-visible operations

The worker emits audit events for operations it observes:

| Category | Examples |
| --- | --- |
| Mesh writes | change file write, `changes/head.json` update, `manifest.json` update, `manifest-<gen>.json` write |
| Mesh reads | manifest read, folder list, change file read, snapshot read |
| Mesh deletes | file/path delete requests |
| Stored-file operations | stored-file upload, download, delete, metadata fetch |
| Recovery wrappers | wrapper read and immutable write attempts |

This callback runs after terminal storage operations. It does not observe
integrity rejection, middleware rejection, notify connections, early request
validation, quota rejection, upload-policy rejection, or system operations.

## What the worker cannot audit

The worker cannot observe encrypted payload meaning or client-local decrypt outcomes. For tainted files, `openFile(path)` downloads ciphertext through the worker, but `sealed.open(key)` runs inside the client after the app resolves or unlocks the key. Biometric failures, missing group keys, and successful plaintext views are not visible to the worker.

Apps may record client-side view-layer or semantic events, but those reports are client-asserted and not tamper-proof.
