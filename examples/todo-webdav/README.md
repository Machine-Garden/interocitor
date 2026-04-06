# TODO over local WebDAV

This is a manual playground for `SyncEngine` + `WebDAVAdapter`.

## Start

From project root:

```bash
yarn demo:todo
```

This starts the local WebDAV server in file mode. Sync files are written to:

- `examples/todo-webdav/webdav-data/`

Then open in two browser tabs/windows:

- `http://127.0.0.1:4173/examples/todo-webdav/index.html`

## Try

1. In tab A, click `New session` then `Copy token`.
2. In tab B, paste token and click `Apply token`.
3. Click `Connect` in both tabs.
4. Add tasks in either tab and watch them sync.
5. Create another session in tab C to verify remote path isolation.

## Notes

- Join token includes `baseUrl`, `remotePath`, and key passphrase.
- Demo mode is file-backed so you can inspect cloud-side artifacts.
- E2E mode uses memory storage via `yarn test:e2e:*`.
- Server storage is intentionally abstracted for future SQLite/D1-backed persistence.

