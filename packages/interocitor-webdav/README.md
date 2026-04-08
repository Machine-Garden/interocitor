<p align="center">
  <a href="https://github.com/TheUiTeam/interocitor">
    <img src="https://raw.githubusercontent.com/TheUiTeam/interocitor/main/docs/assets/hero.svg" alt="interocitor" width="560"/>
  </a>
</p>

# interocitor-webdav

Local WebDAV server for Interocitor.

## What it is

This package provides a lightweight WebDAV-compatible server that can run in memory or against a local file tree for Interocitor itself. It is mainly useful when you want to run Interocitor against a local or self-hosted WebDAV target and inspect the sync artifacts on disk.

## CLI

```bash
npx interocitor-webdav --mode=memory
npx interocitor-webdav --mode=file --data-root=./webdav-data
```

## Workspace usage

From the monorepo root:

```bash
yarn workspace interocitor-webdav server --mode=memory
```

Example-owned scripts such as file-backed demo flows live with the relevant example. For the current demo flow, see the WebDAV example directory:

- GitHub: <https://github.com/TheUiTeam/interocitor/tree/main/examples/todo-webdav>
- Monorepo path: `examples/todo-webdav`

## License

MIT
