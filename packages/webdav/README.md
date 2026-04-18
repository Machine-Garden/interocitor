<p align="center">
  <a href="https://github.com/TheUiTeam/interocitor">
    <img src="https://raw.githubusercontent.com/TheUiTeam/interocitor/main/docs/assets/hero.svg" alt="interocitor" width="560"/>
  </a>
</p>

# interocitor-webdav

Local WebDAV server for Interocitor.

This package exists for one job: provide a mailbox that still can't read your mail.

## Why this package exists

Interocitor treats remote storage as a dumb byte pipe. WebDAV is a convenient way to provide that pipe when you want:

- local development
- self-hosted sync targets
- easy inspection of remote artifacts on disk
- integration tests without a purpose-built backend

This server does not merge your data, query your data, or decrypt your data. It simply exposes a WebDAV-compatible surface so Interocitor clients can exchange encrypted sync artifacts.

## CLI

```bash
npx interocitor-webdav --mode=memory
npx interocitor-webdav --mode=file --data-root=./webdav-data
```

## Workspace usage

From the monorepo root:

```bash
yarn workspace interocitor-webdav server --mode=memory
yarn workspace interocitor-webdav server --mode=file --data-root=./webdav-data
```

## Modes

### Memory mode

Useful for tests and disposable local runs.

### File mode

Useful when you want to inspect the mailbox contents on disk. This is especially helpful for demos and debugging because you can verify that remote artifacts are opaque files rather than application-readable rows.

## Example consumer

The main demo that uses this package lives here:

- GitHub: <https://github.com/TheUiTeam/interocitor/tree/main/examples/todo-webdav>
- Monorepo path: `examples/todo-webdav`

## What this package is not

- not a database
- not a sync engine
- not an encryption layer
- not a collaboration server

It is just the transport surface.

## License

MIT
