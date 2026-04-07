# interocitor 0.0.0-beta.2 Missing Pieces

This file tracks what is not complete yet in the current beta branch.

## Status Legend

- `implemented` - shipped and tested
- `partial` - basic path exists but edge cases/coverage remain
- `missing` - not implemented yet

## Core Protocol

- `implemented` Manifest pointer + generation files (`manifest.json` → `manifest-{n}.json`)
- `implemented` File-per-change writes in flat `changes/` folder + global `head.json`
- `implemented` Manifest content-hash verification on read
- `implemented` Flat folder layout (no channel indirection)
- `partial` Delta lifecycle (`deltaPath` reserved but not fully produced/consumed)
- `missing` Manifest read fallback to highest valid generation when pointer target is invalid

## Sync Behavior

- `implemented` Poll + merge from remote devices via HLC/LWW CRDT
- `implemented` Cursor-based pull with HLC fast-skip via `head.json`
- `implemented` Replica adapter support (best-effort write to backup remotes)
- `partial` Efficient pull optimization by watermark/date-range pruning across large histories

## Compaction / GC

- `implemented` Compaction writes snapshot + publishes next manifest generation
- `implemented` Direct-cloud compaction by client; optional server-managed restriction
- `implemented` Change file pruning after compaction (≤ watermarkHlc)
- `missing` Delta emission and delta-based catch-up
- `missing` Garbage collection pass (reachability, grace windows, retention policy)
- `missing` Tombstone retention enforcement against known-device sync state

## Security / Integrity

- `implemented` Per-entry encryption envelopes for change files
- `implemented` Unauthorized writer rejection when `server.managed=true`
- `partial` Auth model hardening (writer identity only; no signatures)
- `missing` Rotation workflow and explicit mixed-key migration handling

## Testing Gaps

- `implemented` Full e2e browser suite currently green
- `missing` Corrupt-pointer recovery and highest-valid-generation fallback tests
- `missing` Eventual-consistency simulation tests for delayed folder listing visibility
- `missing` Large-history performance regression tests
- `missing` Explicit GC correctness tests
- `missing` Replica adapter flush tests (multi-adapter write verification)

## Documentation Gaps

- `implemented` Public docs no longer use retired versioned draft branding
- `implemented` Detailed protocol flows moved to `docs/flows.md`
- `partial` `interocitor-architecture.md` still contains older NDJSON/append design context and needs an alignment pass

## Next Recommended Implementation Order

1. Manifest pointer fallback recovery
2. Delta generation + apply path
3. Garbage collection engine + tests
4. Replica adapter e2e tests
5. Eventual consistency + performance test fixtures
