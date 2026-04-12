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

## Notes

- Join token includes `baseUrl`, `remotePath`, and key passphrase.
- Demo mode is file-backed so you can inspect cloud-side artifacts.
- Package-level e2e validation uses the in-memory server mode.
- Server storage remains abstracted for future persistence backends.

## Related packages

- Core engine: `packages/interocitor`
- WebDAV helper server: `packages/interocitor-webdav`
