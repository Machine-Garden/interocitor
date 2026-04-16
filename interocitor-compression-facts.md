# Interocitor: Data Volume & Compression Facts

## Remote File Architecture

### Change Files (`changes/{deviceId}-{generation}.ndjson`)
- **Format**: NDJSON (newline-delimited JSON), one change entry per line
- **Individual entry structure**: 
  ```json
  {
    "id": "chg_...",
    "ts": timestamp,
    "device": "dev_...",
    "hlc": "...",
    "ops": [...]
  }
  ```
- **Write pattern**: Each device appends only to its own file (eliminates concurrent write issues)
- **Generation-based rotation**: When change file grows large, device writes new file with generation suffix, then deletes old
- **Read efficiency**: Cloud adapter tracks cursor (last-merged HLC) to skip already-processed entries; fast-path optimization via `head.json` prevents listing if no new changes
- **Reference**: `./packages/interocitor/src/core/pull.ts` (cursor-based filtering), `./packages/interocitor/src/core/flush.ts` (per-entry writes)

### Snapshots (`snapshots/{snapshotId}-{serverId}.json`)
- **Full point-in-time state**: All tables + all rows with HLC metadata per column
- **Compact trigger**: Device initiates when total change log across all devices exceeds threshold (e.g., 1MB, 5000+ entries)
- **Safe truncation**: Old change files retained until all known devices acknowledge snapshot (checked via cursors file or after 7 days)
- **Content**: Includes watermark HLC and per-device cursors to enable safe pruning
- **Reduces growth**: Removes outdated entries, hard-deletes tombstones older than 30 days
- **Reference**: `./interocitor-architecture.md` § Compaction (lines 260–310), `./packages/interocitor/src/core/compaction.ts`

### Manifest (`manifest-{generation}.json`)
- **Metadata**: Schema version, mesh ID, encryption flag, encryption disabled by default, snapshot/delta paths
- **Content-hashed**: Includes SHA256 of payload for integrity; hash verified on read
- **Cleartext always**: Readable without decryption key (device needs to know encryption is required to prompt for key)
- **Reference**: `./packages/interocitor/src/core/manifest.ts`, `./interocitor-architecture.md` § Encryption (lines 590–599)

---

## Encryption & Compression Implications

### Encryption Status
- **Payload encryption**: AES-256-GCM encrypts every NDJSON line individually + snapshot files
- **Per-entry encryption overhead**: Each line wrapped as `{"v":1,"iv":"base64...","ct":"base64..."}` with 96-bit random IV + 128-bit auth tag
- **Key facts for compression**:
  - ✗ **Encrypted data is incompressible**: AES-GCM output is cryptographically random; any server-side transport/storage compression gains near-zero bytes
  - ✓ **Plaintext NDJSON is highly compressible**: Repetitive JSON structure, HLC/device ID patterns, column values → ~60–80% reduction typical with gzip
  - ✓ **Unencrypted mode preferred for compression**: Default is `encrypted: false`; enables end-to-end gzip if infrastructure supports it

### Design Trade-off
- No mention of compression in codebase (grep: 0 results for `compress|gzip|deflate|brotli`)
- **Implication**: Payload size optimization delegated to cloud provider (Google Drive, OneDrive, Dropbox all handle transport compression transparently at TLS layer)
- **Missing opportunity**: If encryption enabled, re-encryption + recompaction workflow (lines 649–659 in arch doc) uploads entire dataset uncompressed

---

## Storage Adapter Considerations

### Supported Backends
1. **Google Drive** (`./packages/interocitor/src/adapters/google-drive.ts`):
   - Range reads supported (HTTP Range header) → enables incremental file fetch
   - No true append; works around via read-modify-write per entry
   - OAuth scoped to `drive.file` (app can only access files it created)

2. **WebDAV** (`./packages/interocitor/src/adapters/webdav.ts`):
   - Stateless HTTP-based file ops
   - No append support (read-modify-write workaround)

3. **Cloudflare R2** (`./packages/interocitor/src/adapters/cloudflare.ts`):
   - S3-compatible; supports conditional writes (ETags)
   - No range-read API call in current code

4. **Memory adapter** (test/dev only)

### No Server-Side Compression Features
- **StorageAdapter interface** (lines 313–342 in arch doc):
  - `readFile()`, `writeFile()`, `appendToFile()` (not universally supported)
  - Metadata: `size`, `modifiedTime`, `etag` — no compression-related fields
- **Missing**: No `deflate` or compression negotiation headers in adapter code
- **Why**: Cloud providers handle compression at TLS layer; app-level compression incompatible with encryption

---

## Practical Recommendations

### For Unencrypted Meshes (Default)
1. **Enable HTTP compression**: Ensure cloud storage API calls use gzip/brotli (Google Drive/Dropbox do automatically)
2. **Monitor snapshot frequency**: Compaction removes old entries, but monitor threshold to prevent runaway change log growth
   - Benchmark: 1–5MB threshold typical; adjust per device storage constraints
3. **No app-level compression needed**: Cloud layer handles it transparently

### For Encrypted Meshes
1. **Accept incompressibility**: AES-GCM output cannot be compressed; plan storage accordingly
2. **Estimate overhead**: Each entry adds ~80 bytes (IV base64 + wrapper JSON); for 10K entries = ~800KB extra
3. **Key rotation is expensive**: Full re-encryption + re-upload of all files; schedule during off-peak (§ Key Rotation, lines 646–659)
4. **Optimize compaction cadence**: More frequent snapshots reduce per-file size but increase metadata overhead; sweet spot ~5000–10000 entries per device

### For High-Volume Scenarios
- **Change log growth rate**: 1 change entry ≈ 200–500 bytes (JSON) → plaintext file compression ~70%, encrypted file ~100%
- **Snapshot compression**: Full dataset snapshot compresses ~80% unencrypted; use as baseline for storage budgeting
- **Range read optimization**: Google Drive's Range header support allows incremental merges; consider for very large change files (>10MB) to avoid full download
  - Not implemented in current pull.ts; potential future optimization

### Storage Budgeting Example
- **Unencrypted, 4-person mesh, 1 year**:
  - ~500 daily changes per person (food log, shopping items)
  - 365 days × 500 × 4 = 730K entries
  - Plaintext: ~100–200MB; compressed: ~20–40MB
  - With compaction every 30 days: ~10–15 snapshot files, ~2–5MB each; old change logs deleted
  - **Total**: ~50–70MB uncompressed, ~10–15MB compressed

- **Encrypted, same scenario**:
  - Same size before encryption overhead + IV per line
  - ~730K entries × 80 bytes overhead = 58MB extra
  - **Total**: ~150–250MB on disk, incompressible at app level

---

## References
- `./interocitor-architecture.md` — Compaction (§260–310), Encryption (§465–710), Storage Adapters (§311–365)
- `./packages/interocitor/src/core/pull.ts` — cursor-based file reading, change merging
- `./packages/interocitor/src/core/flush.ts` — per-entry cloud writes
- `./packages/interocitor/src/core/compaction.ts` — snapshot creation, file pruning
- `./packages/interocitor/src/core/manifest.ts` — manifest hash validation, bootstrap
- `./packages/interocitor/src/crypto/encryption.ts` — AES-GCM entry encryption, IV handling
- `./packages/interocitor/src/adapters/{google-drive,webdav,cloudflare}.ts` — backend capabilities
