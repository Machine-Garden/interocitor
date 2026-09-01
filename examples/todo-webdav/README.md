<p align="center">
  <a href="https://github.com/Machine-Garden/interocitor">
    <img src="../../docs/assets/hero.svg" alt="Interocitor" width="560" />
  </a>
</p>

# TODO over local WebDAV

Runnable browser playground for `@interocitor/core` with `WebDAVAdapter`.

Two tabs keep queryable rows in IndexedDB, exchange encrypted sync artifacts
through a local mailbox, and merge on the client. The bundled WebDAV server
does not understand application rows.

## Run from the repository root

```bash
yarn install
yarn demo:todo
```

Then open:

<http://127.0.0.1:4173/examples/todo-webdav/index.html>

`yarn demo:todo` builds core and web, then starts the example-owned file-mode
server. On every start, that server **deletes and recreates**
`examples/todo-webdav/webdav-data`. The directory is disposable demo state;
never point `--data-root` at data you need to keep.

To start only the already-built example server:

```bash
yarn --cwd examples/todo-webdav server:file
```

The server binds to loopback but has no authentication, authorization, TLS, or
request-size limit, and non-WebDAV routes expose files below the repository
root. It is for local development and tests only.

## Try sync

1. In tab A, select **New session**, then **Copy token**.
2. In tab B, paste the token and select **Apply token**.
3. Select **Connect** in both tabs.
4. Add tasks in either tab and watch them sync.
5. Inspect `examples/todo-webdav/webdav-data` to see encrypted change and
   snapshot payloads plus visible routing/manifest metadata.
6. Create another session to verify that a different remote path and key form a
   separate mesh.

## Treat the join token as a secret

The JSON token contains the WebDAV base URL, remote path, and portable mesh key.
Possession gives a peer the location and the material required to decrypt this
demo mesh. The page also places the token in the URL fragment and can copy it
to the clipboard. Fragments are not sent in HTTP requests, but browser history,
extensions, screenshots, clipboard readers, and same-origin script can still
expose them.

Use a purpose-built authenticated invitation/recovery flow in a real product.
Do not log or persist the demo token as ordinary metadata.

## Credential storage modes

Use the `credentials` query parameter to exercise explicit browser custody:

```text
?credentials=session          # default: plaintext credential record in sessionStorage
?credentials=memory           # JS memory only; reload needs the join token again
?credentials=local            # plaintext credential record in localStorage
?credentials=passkey          # WebAuthn largeBlob, when supported
?credentials=memory-envelope  # encrypted envelope and unwrap key both in page memory
```

The wiring is in `app.js#createTodoCredentialStore`. Browser storage remains
readable to same-origin JavaScript. WebAuthn-protected bytes enter JavaScript
after a successful ceremony. The memory-envelope option demonstrates API
composition, not a durable or independently protected backend.

## Durable-file pattern

The TODO UI is row-only. This partial application fragment shows the intended
separation when an app adds attachments; it assumes `db`, `task`, `taskId`, and
`file` already exist:

```js
const path = `tasks/${taskId}/files/${Date.now()}_${file.name}`;
await db.putFile(path, new Uint8Array(await file.arrayBuffer()), file.type);
await db.table("tasks").patch(taskId, {
  file_paths: [...(task.file_paths ?? []), path],
});
```

Use rows for references and metadata, and the file API for bytes. In this demo
the engine has a portable passphrase key source, so remote file payloads are
encrypted before WebDAV storage. An engine without encryption would upload raw
bytes.

For React image display, use `useImage(db, path)` from
`@interocitor/react`. For other attachments, read `db.getFile(path)` and own
the download UX.

## Validate the example

From the repository root:

```bash
yarn test:e2e:todo
```

This command builds core and web, syntax-checks the app, starts the disposable
loopback server, and verifies join-token sync plus remote-path isolation in a
real browser.

## Related packages

- [Core engine](../../packages/core/README.md)
- [Browser helpers](../../packages/web/README.md)
- [Internal loopback WebDAV server](../../tools/webdav-server/README.md)
