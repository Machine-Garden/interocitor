# TODO over local WebDAV

Manual playground for `interocitor` + `WebDAVAdapter`.

This example shows the smallest version of the Interocitor idea: two browser tabs, one shared mailbox, zero server-side understanding of the data.

GitHub example directory: <https://github.com/TheUiTeam/interocitor/tree/main/examples/todo-webdav>

## Why this example exists

If Interocitor is "a mailbox that can't read your mail," this is the easiest way to watch that happen.

The browser keeps the usable dataset in IndexedDB. The WebDAV server just stores sync artifacts. In file-backed mode you can inspect the remote folder directly and see that it contains transport files, not an application-aware backend.

## Start from the repo root

```bash
yarn demo:todo
```

Or run the example-owned file-backed server script directly:

```bash
yarn --cwd examples/todo-webdav server:file
```

Sync files are written to:

- `examples/todo-webdav/webdav-data/`

Then open:

- `http://127.0.0.1:4173/examples/todo-webdav/index.html`

## Try

1. In tab A, click `New session` then `Copy token`.
2. In tab B, paste token and click `Apply token`.
3. Click `Connect` in both tabs.
4. Add tasks in either tab and watch them sync.
5. Inspect `examples/todo-webdav/webdav-data/` to see the mailbox artifacts.
6. Create another session in tab C to verify remote path isolation.

## Credential storage modes

The demo wires `credentialStore` explicitly. Use the `credentials` query
parameter to try different browser key-storage policies without editing code:

```text
?credentials=session          # default: sessionStorage credential record
?credentials=memory           # JS memory only; reload needs the join token again
?credentials=local            # localStorage credential record
?credentials=passkey          # WebAuthn largeBlob / platform authenticator
?credentials=memory-envelope  # encrypted envelope in app memory, unwrap key in memory
```

The actual wiring lives in `app.js#createTodoCredentialStore`. Production apps
can replace the memory envelope store with a backend-backed
`CredentialEnvelopeStore` while keeping the unwrap key in passkey/biometrics.

## Durable files pattern

The TODO UI intentionally stays row-only, but this example's WebDAV mailbox
also supports durable files. Use rows for structured state and store file
paths in those rows; use file storage for the opaque payload.

```js
const path = `tasks/${taskId}/files/${Date.now()}_${file.name}`;
await db.putFile(path, new Uint8Array(await file.arrayBuffer()), file.type);
await db.table('tasks').patch(taskId, {
  file_paths: [...(task.file_paths ?? []), path],
});
```

For image UI in React apps, render a stored image with
`useImage(db, path)` from `@interocitor/react`. For non-image attachments,
read bytes directly with `db.getFile(path)` and build your own download UI.

## Notes

- Join token includes `baseUrl`, `remotePath`, and portable key material.
- Demo mode is file-backed so you can inspect cloud-side artifacts.
- Package-level e2e validation uses the in-memory server mode.
- Server storage remains abstracted for future persistence backends.

## Related packages

- Core engine: `packages/interocitor`
- WebDAV helper server: `packages/interocitor-webdav`
