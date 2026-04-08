<p align="center">
  <a href="https://github.com/TheUiTeam/interocitor">
    <img src="https://raw.githubusercontent.com/TheUiTeam/interocitor/main/docs/assets/hero.svg" alt="interocitor" width="560"/>
  </a>
</p>

# interocitor-swift

Swift workspace for a native Interocitor implementation.

## Goal

This package is reserved for a Swift-native runtime that preserves Interocitor's local-first model while mapping IndexedDB-like concepts onto SQLite-backed storage.

## Design direction

Planned concepts include:

- object-store style tables
- secondary indexes
- key ranges and ordered scans
- transaction semantics
- schema versioning and migrations
- local change feeds compatible with Interocitor sync expectations

## Current status

Scaffold only. The placeholder storage surface lives in `Sources/InterocitorSwift/IndexedSQLiteStore.swift`.

The monorepo home for this package is:

- GitHub: <https://github.com/TheUiTeam/interocitor/tree/main/packages/interocitor-swift>
- Monorepo path: `packages/interocitor-swift`

## License

MIT
