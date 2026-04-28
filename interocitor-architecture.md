# Interocitor: Local-First Database over Cloud Storage

## Problem

A web app needs to share structured data across multiple devices in a mesh. Requirements:

- **No dedicated server** — no process to "keep running"
- **No vendor cloud** — data stays in storage the mesh already owns (Google Drive, Dropbox, OneDrive)
- **Offline-first** — each device works independently, syncs when connectivity allows
- **Crash-proof** — any device can close/crash/lose power without corrupting shared state
- **Multi-user** — mesh members on different browsers, different machines
- **Browser-only** — no native app, no sidecar process

## Architecture Overview

```
┌─────────────────────────────────────┐
│           Device A (Browser)        │
│  ┌───────────┐   ┌───────────────┐  │
│  │ IndexedDB │◄──│  Sync Engine  │  │
│  │ (runtime) │──►│               │  │
│  └───────────┘   └───────┬───────┘  │
└──────────────────────────┼──────────┘
                           │ OAuth / REST API
                           ▼
              ┌────────────────────────┐
              │   Cloud Storage        │
              │   (Google Drive /      │
              │    Dropbox / OneDrive) │
              │                        │
              │  /Interocitor/       │
              │    manifest.json       │
              │    snapshots/          │
              │      latest.json       │
              │    changes/            │
              │      {deviceId}.ndjson │
              └────────────────────────┘
                           ▲
                           │ OAuth / REST API
┌──────────────────────────┼──────────┐
│           Device B (Browser)        │
│  ┌───────────┐   ┌───────┴───────┐  │
│  │ IndexedDB │◄──│  Sync Engine  │  │
│  │ (runtime) │──►│               │  │
│  └───────────┘   └───────────────┘  │
└─────────────────────────────────────┘
```

Each device maintains a **full local copy** in IndexedDB (or OPFS-backed SQLite). The cloud folder is a **mailbox**, not a runtime database. No device reads directly from the cloud folder to serve UI — it syncs in the background.

## Core Concepts

### 1. Device Identity

Each browser profile generates a UUID on first launch, stored in `localStorage` (not IndexedDB — survives IDB clears).

```typescript
function getDeviceId(): string {
  let id = localStorage.getItem('interocitor-device-id');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('interocitor-device-id', id);
  }
  return id;
}
```

A device ID is tied to a browser profile on a machine. Same person, two browsers = two devices. This is intentional — it avoids write conflicts at the file level.

### 2. Mesh Identity

A mesh is identified by the shared cloud folder. No account system, no invite codes. The onboarding flow:

1. First user: "Create a new mesh" → app creates the folder structure in their cloud storage, shares it
2. Other members: "Join a mesh" → OAuth into the same cloud storage, pick the shared folder
3. App reads `manifest.json` to confirm it's a valid mesh folder

```json
// manifest.json
{
  "version": 1,
  "created": "2026-03-30T10:00:00Z",
  "meshId": "hh_a1b2c3d4",
  "schema": 3
}
```

### 3. User Identity (Not Device Identity)

A device is a browser. A user is a person. Multiple devices may belong to one user.

```json
// Part of manifest.json or separate users.json
{
  "users": {
    "usr_abc": { "name": "Marina", "devices": ["dev_x1", "dev_x2"] },
    "usr_def": { "name": "Anton", "devices": ["dev_y1"] }
  }
}
```

User identity matters for attribution ("who added this meal?") and permissions later. Device identity matters for sync correctness.

## Sync Protocol

### Change Log Format

Each device writes to its own append-only NDJSON file: `changes/{deviceId}.ndjson`

One device, one file. No concurrent writes to the same file. This eliminates cloud storage's biggest weakness (no file locking).

Each line is a **change entry**:

```json
{
  "id": "chg_a1b2c3",
  "ts": 1711785600000,
  "device": "dev_x1",
  "user": "usr_abc",
  "hlc": "2026-03-30T10:00:00.000Z-0000-dev_x1",
  "ops": [
    {
      "type": "upsert",
      "table": "meals",
      "rowId": "meal_123",
      "columns": {
        "name": { "value": "Butter Chicken", "hlc": "2026-03-30T10:00:00.000Z-0000-dev_x1" },
        "servings": { "value": 4, "hlc": "2026-03-30T10:00:00.000Z-0000-dev_x1" }
      }
    }
  ]
}
```

### Why HLC (Hybrid Logical Clock) not timestamps

Wall clocks drift between devices. Two phones in the same house can disagree by seconds or minutes. A Hybrid Logical Clock combines wall time with a logical counter, guaranteeing:

- Total ordering of events across devices
- Monotonic increase even if wall clock jumps backward
- No central coordination needed

```typescript
interface HLC {
  ts: number;    // max(local wall time, last seen remote ts)
  counter: number; // increments when ts doesn't advance
  nodeId: string;  // device ID for tiebreaking
}

function hlcNow(local: HLC): HLC {
  const wallTime = Date.now();
  if (wallTime > local.ts) {
    return { ts: wallTime, counter: 0, nodeId: local.nodeId };
  }
  return { ts: local.ts, counter: local.counter + 1, nodeId: local.nodeId };
}

function hlcReceive(local: HLC, remote: HLC): HLC {
  const maxTs = Math.max(Date.now(), local.ts, remote.ts);
  if (maxTs === local.ts && maxTs === remote.ts) {
    return { ts: maxTs, counter: Math.max(local.counter, remote.counter) + 1, nodeId: local.nodeId };
  }
  if (maxTs === local.ts) {
    return { ts: maxTs, counter: local.counter + 1, nodeId: local.nodeId };
  }
  if (maxTs === remote.ts) {
    return { ts: maxTs, counter: remote.counter + 1, nodeId: local.nodeId };
  }
  return { ts: maxTs, counter: 0, nodeId: local.nodeId };
}

function hlcCompare(a: HLC, b: HLC): number {
  if (a.ts !== b.ts) return a.ts - b.ts;
  if (a.counter !== b.counter) return a.counter - b.counter;
  return a.nodeId < b.nodeId ? -1 : 1;
}
```

### CRDT Strategy: Last-Writer-Wins per Column (LWW-Register)

Each column in each row carries its own HLC. When merging, the highest HLC wins for that column independently.

```
Device A sets meal_123.name = "Butter Chicken" at HLC T1
Device B sets meal_123.servings = 6 at HLC T2

After merge: meal_123 = { name: "Butter Chicken" (T1), servings: 6 (T2) }
```

No conflicts. No merge dialogs. Both changes preserved because they touched different columns.

If both devices change the **same column**:

```
Device A sets meal_123.name = "Butter Chicken" at HLC T1
Device B sets meal_123.name = "Tikka Masala" at HLC T2 (T2 > T1)

After merge: meal_123.name = "Tikka Masala" (T2 wins)
```

Last writer wins. For mesh data (meals, shopping lists, schedules), this is acceptable. Nobody is concurrently editing the same field in practice — and when they do, the most recent intent is usually the right one.

### Operations

```typescript
type Op =
  | { type: 'upsert'; table: string; rowId: string; columns: Record<string, { value: any; hlc: string }> }
  | { type: 'delete'; table: string; rowId: string; hlc: string }
```

**Deletes are soft.** A tombstone row stays in the DB with `_deleted: true` and `deletedHlc`. Its payload is reduced to `{}` so deleted user data does not remain in tombstones. If a later upsert has an HLC greater than `deletedHlc`, it starts a fresh row incarnation; stale pre-delete columns do not carry forward.

Tombstones are cleaned up during compaction only after active devices have acknowledged a GC floor (see below).

## Sync Engine Lifecycle

### On App Open

```
1. Read local IndexedDB → render UI immediately (offline-first)
2. Background: authenticate with cloud storage provider
3. List files in changes/ directory
4. For each device's .ndjson file:
   a. Check local cursor (last byte offset read from this file)
   b. Download new bytes from cursor to EOF (range request if supported)
   c. Parse new change entries
   d. For each op, merge into local IndexedDB using HLC comparison
   e. Update local cursor
5. Check snapshots/latest.json timestamp
   a. If newer than local snapshot cursor → full rehydration from snapshot + replay changes after snapshot
6. Push local unpushed changes to own changes/{deviceId}.ndjson
```

### On Local Write

```
1. Generate HLC for the write
2. Apply to local IndexedDB immediately (UI updates instantly)
3. Append change entry to in-memory outbox
4. Debounce: after 2s of inactivity or 50 pending changes, flush outbox
5. Flush = append to changes/{deviceId}.ndjson in cloud storage
```

### Periodic Sync (While App is Open)

```
Poll every 30-60 seconds:
1. List changes/ directory for modified files (check etag/modifiedTime)
2. Download + merge any new entries
3. Flush local outbox if non-empty
```

### On App Close / Tab Unload

```
beforeunload / visibilitychange → flush outbox immediately
If flush fails (network gone), changes survive in IndexedDB outbox
Next app open picks them up
```

## Compaction

Change logs grow unbounded. Compaction creates a point-in-time snapshot and allows truncation.

### Snapshot Format

```json
// snapshots/latest.json
{
  "snapshotId": "snap_001",
  "timestamp": "2026-03-30T10:00:00.000Z",
  "hlc": "2026-03-30T10:00:00.000Z-0042-dev_x1",
  "cursors": {
    "dev_x1": 48230,
    "dev_y1": 12400
  },
  "tables": {
    "meals": {
      "meal_123": {
        "name": { "value": "Butter Chicken", "hlc": "..." },
        "servings": { "value": 4, "hlc": "..." },
        "_deleted": false
      }
    },
    "shoppingList": { ... }
  }
}
```

### Compaction Trigger

Any device can trigger compaction. Natural trigger: when total change log size across all devices exceeds a threshold (e.g. 1MB, or 5000 entries).

```
1. Pull all remote changes → build merged local state
2. Compute active devices from devices/<deviceId>.json
3. Compute gcFloorHlc = min(active observedWatermarkHlc)
4. Write new snapshot, omitting tombstones with deletedHlc <= gcFloorHlc
5. Publish manifest with epoch, watermarkHlc, snapshotPath, gcFloorHlc
6. Delete remote change files whose HLC <= watermarkHlc
7. Devices that later see the new epoch/floor rehydrate before writing stale history
```

### Safe Truncation

Cloud storage doesn't support file truncation. Instead:

1. Device writes a **new** change log file: `changes/{deviceId}-2.ndjson`
2. Deletes the old one: `changes/{deviceId}.ndjson`
3. Snapshot records which file generation each device is on

## Storage Adapter Interface

```typescript
interface StorageAdapter {
  /** Auth */
  authenticate(): Promise<void>;
  isAuthenticated(): boolean;

  /** Folder operations */
  ensureFolder(path: string): Promise<void>;
  listFiles(path: string): Promise<FileEntry[]>;

  /** File operations */
  readFile(path: string): Promise<ArrayBuffer>;
  readFileRange(path: string, start: number): Promise<ArrayBuffer>; // for incremental reads
  writeFile(path: string, data: ArrayBuffer | string): Promise<void>;
  appendToFile(path: string, data: string): Promise<void>; // not all providers support this
  deleteFile(path: string): Promise<void>;

  /** Metadata */
  getFileMetadata(path: string): Promise<{ size: number; modifiedTime: string; etag?: string }>;
}

interface FileEntry {
  name: string;
  path: string;
  size: number;
  modifiedTime: string;
  etag?: string;
}
```

### Provider Notes

| Capability | Google Drive | Dropbox | OneDrive |
|---|---|---|---|
| OAuth from browser | Yes | Yes | Yes |
| Scoped folder access | `drive.file` scope — app can only see files it created or user explicitly opened | Scoped app folder | App folder or specific consent |
| Folder sharing | Native — share folder with family Google accounts | Shared folders | Shared OneDrive folders |
| Append to file | No — must read-modify-write | No | No |
| Range reads | Yes (Range header on download URL) | Yes | Yes |
| File watch/webhooks | Yes but needs a server to receive — not useful here | Same | Same |
| Free tier | 15 GB shared across Gmail/Drive/Photos | 2 GB | 5 GB |

**Append workaround:** Since no provider supports true append, the adapter does:

1. Download current file content
2. Append new entries in memory
3. Upload as new revision

This is safe because each device only writes its own file — no concurrent writes to the same file.

For large files, switch to the generation-based approach: write a new file with only the new entries, update a manifest tracking file order.

### Google Drive Adapter (Primary)

```typescript
class GoogleDriveAdapter implements StorageAdapter {
  private folderId: string | null = null;

  async authenticate(): Promise<void> {
    // Use Google Identity Services (GIS) for OAuth2
    // Scopes: 'https://www.googleapis.com/auth/drive.file'
    // Token stored in localStorage, refreshed via silent prompt
  }

  async ensureFolder(path: string): Promise<void> {
    // Search for folder by name in appDataFolder or user's Drive
    // Create if not exists, cache folderId
  }

  async readFile(path: string): Promise<ArrayBuffer> {
    // GET https://www.googleapis.com/drive/v3/files/{fileId}?alt=media
  }

  async readFileRange(path: string, start: number): Promise<ArrayBuffer> {
    // Same endpoint with Range: bytes={start}- header
  }

  async writeFile(path: string, data: ArrayBuffer | string): Promise<void> {
    // If file exists: PATCH with uploadType=media
    // If new: POST to upload endpoint with parent folderId
  }

  async listFiles(path: string): Promise<FileEntry[]> {
    // GET https://www.googleapis.com/drive/v3/files
    // q: "'{folderId}' in parents and trashed = false"
  }

  async deleteFile(path: string): Promise<void> {
    // DELETE https://www.googleapis.com/drive/v3/files/{fileId}
    // or PATCH with trashed: true
  }
}
```

## Schema & Migrations

The local IndexedDB schema is versioned. The manifest tracks the current schema version.

```typescript
interface SchemaDefinition {
  version: number;
  tables: {
    [tableName: string]: {
      columns: {
        [colName: string]: 'string' | 'number' | 'boolean' | 'json';
      };
      indexes?: string[];
    };
  };
}
```

### Migration Strategy

Migrations are **additive only** in a CRDT system:

- Add a table: safe — old devices ignore unknown tables
- Add a column: safe — old devices ignore unknown columns, new devices treat missing columns as null
- Rename/remove a column: **not safe** — old devices will keep writing to the old column

For breaking changes:
1. Bump schema version in manifest
2. Old devices see version mismatch, show "please update" message
3. New devices run migration on local DB, write a migration change entry that other new devices can skip

## Conflict Scenarios & Resolution

| Scenario | Resolution |
|---|---|
| Two devices add different meals | Both preserved — different rowIds |
| Two devices edit same meal's name | LWW — higher HLC wins |
| One device deletes a meal, other edits it | If delete HLC > edit HLC: deleted. If edit HLC > delete HLC: undeleted with edit applied |
| Two devices add same item to shopping list | Both preserved — different rowIds. App can deduplicate in UI layer |
| Device offline for a week, then syncs | All changes replay in HLC order. No special handling needed |
| New device joins mesh | Downloads latest snapshot, replays changes since snapshot. Full state in minutes |
| Device leaves mesh (sold/lost) | Remove device from manifest. Its change log can be deleted after next compaction |

## Failure Modes

| Failure | Impact | Recovery |
|---|---|---|
| Browser clears IndexedDB | Local data gone | Rehydrate from cloud snapshot + change logs on next open |
| Cloud storage quota exceeded | Sync stops | App detects 403/507, shows warning. Local DB continues working |
| OAuth token expires mid-session | Sync pauses | Silent re-auth or prompt. Local writes queue in outbox |
| Corrupt change log entry | One entry unreadable | Skip entry, log warning. CRDTs are convergent — missing one entry means that write is lost, not the whole DB |
| Two devices compact simultaneously | Two snapshots written | Later snapshot wins (higher HLC). Other is ignored |
| Cloud storage folder deleted | All shared state gone | Each device still has full local copy. Re-create folder, push local state as new snapshot |
| Key lost (all devices cleared) | Encrypted cloud data unrecoverable | Recover from printed/saved key backup. If no backup: data is gone — start fresh from any device's local IDB copy (unencrypted) |
| Wrong key entered on join | Decryption fails | App detects GCM auth tag failure, prompts to re-enter. No data corruption possible. |
| Key rotation interrupted | Mix of old-key and new-key files | Each file's envelope has version field. App tries new key first, falls back to old key. Rotation resumes on next open. |
| localStorage cleared (key gone) | Device can't decrypt cloud data | Re-enter key via passphrase/QR from another device. Local IDB still has cleartext — device keeps working offline. |

## Encryption

### Threat Model

The threat is **unauthorized access to the cloud folder** — compromised Google account, leaked shared link, Google themselves, law enforcement with a warrant. Anyone who can read the folder should see ciphertext, not meal plans.

What we're NOT trying to solve: physical device access (browser DevTools on an unlocked laptop). That's OS-level disk encryption, outside the app's control.

### Design: Symmetric Key, Client-Side Encryption

One AES-256-GCM key encrypts everything in the cloud folder. All devices in the mesh share this key. The key **never** leaves devices — it's never stored in the cloud folder.

```
                    ┌──────────────────────────┐
                    │    Cloud Storage          │
                    │                           │
                    │  manifest.json (cleartext)│
                    │  changes/*.enc.ndjson     │ ← encrypted
                    │  snapshots/*.enc.json     │ ← encrypted
                    │                           │
                    │  Key is NOT here          │
                    └──────────────────────────┘
                         ▲            ▲
                    encrypted    encrypted
                    writes       writes
                         │            │
              ┌──────────┴──┐   ┌─────┴──────────┐
              │  Device A   │   │  Device B       │
              │             │   │                 │
              │  Key in     │   │  Key in         │
              │  localStorage│   │  localStorage  │
              │             │   │                 │
              │  IDB is     │   │  IDB is         │
              │  cleartext  │   │  cleartext      │
              └─────────────┘   └─────────────────┘
```

### Key Generation & Storage

The first device creates the mesh generates the key:

```typescript
async function generateMeshKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true, // extractable — needed for export to transfer
    ['encrypt', 'decrypt']
  );
}

async function storeKey(key: CryptoKey): Promise<void> {
  const exported = await crypto.subtle.exportKey('raw', key);
  const b64 = btoa(String.fromCharCode(...new Uint8Array(exported)));
  localStorage.setItem('interocitor-key', b64);
}

async function loadKey(): Promise<CryptoKey | null> {
  const b64 = localStorage.getItem('interocitor-key');
  if (!b64) return null;
  const raw = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  return crypto.subtle.importKey(
    'raw', raw, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']
  );
}
```

`localStorage` is used over IndexedDB for the key because:
- It survives IndexedDB clears (different eviction behavior)
- The key is tiny (44 bytes base64)
- If localStorage is cleared too, the user re-enters the passphrase or re-scans QR

### Key Transfer: Two Methods, Same Key

The key needs to get from the first device to every other device. Two mechanisms — the user picks whichever is convenient:

**Method A: Passphrase (remote onboarding)**

The creating device shows the raw key encoded as a human-readable passphrase. The other device's "Join mesh" screen has a field to type it in.

```typescript
// Encode 256-bit key as a sequence of words (BIP39-style) or as base58
// 256 bits = 24 BIP39 words, or ~43 base58 characters

async function keyToPassphrase(key: CryptoKey): Promise<string> {
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key));
  // Option A: base58 — short, copy-pasteable
  return base58encode(raw);  // ~43 chars like "5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ"
  // Option B: word list — speakable over phone
  // return toMnemonic(raw);  // "abandon ability able about above absent ..."
}

async function passphraseToKey(passphrase: string): Promise<CryptoKey> {
  const raw = base58decode(passphrase.trim());
  return crypto.subtle.importKey(
    'raw', raw, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']
  );
}
```

No PBKDF2 needed — the key IS the passphrase (encoded). No stretching because the input is already 256 bits of entropy. This is not a human-chosen password, it's a machine-generated key that happens to be encoded as text.

**Method B: QR code / URL fragment (in-person onboarding)**

The creating device shows a QR code or a clickable link. The key sits in the URL fragment (`#`), which is never sent to any server.

```typescript
function keyToShareUrl(key: Uint8Array): string {
  const b64url = btoa(String.fromCharCode(...key))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return `https://yourapp.com/join#key=${b64url}`;
  // Fragment is client-only — never hits the server
}

// On receiving device:
function keyFromFragment(): Uint8Array | null {
  const hash = window.location.hash;
  const match = hash.match(/key=([A-Za-z0-9_-]+)/);
  if (!match) return null;
  const b64 = match[1].replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}
```

Both methods deliver the same 256-bit key. The app doesn't care how it arrived.

### What Gets Encrypted

**Encrypted (stored in cloud folder):**
- Every NDJSON change entry (each line encrypted individually)
- Snapshot files
- `users.json` (names, device associations)

**Cleartext (must be readable without key):**
- `manifest.json` — contains schema version, mesh ID, and an `encrypted: true` flag. A new device needs to read this to know decryption is required before prompting for the key.

### Encrypted Entry Format

Each NDJSON line becomes an encrypted envelope:

```json
{"v":1,"iv":"base64...","ct":"base64...","tag":"base64..."}
```

```typescript
const IV_LENGTH = 12; // 96-bit IV for AES-GCM

async function encryptEntry(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoded
  );
  // GCM appends 16-byte auth tag to ciphertext automatically in Web Crypto
  const ct = new Uint8Array(ciphertext);
  return JSON.stringify({
    v: 1,
    iv: uint8ToBase64(iv),
    ct: uint8ToBase64(ct)
    // tag is included in ct by Web Crypto API
  });
}

async function decryptEntry(key: CryptoKey, envelope: string): Promise<string> {
  const { v, iv, ct } = JSON.parse(envelope);
  if (v !== 1) throw new Error(`Unknown envelope version: ${v}`);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToUint8(iv) },
    key,
    base64ToUint8(ct)
  );
  return new TextDecoder().decode(decrypted);
}
```

Each line is independently encrypted with a unique random IV. This means:
- You can still append lines without re-encrypting the file
- Corrupt one line, only that entry is lost
- File-level diffing still works (cloud storage can see line count changed, just not content)

### Key Rotation

When: device is lost/stolen, mesh member leaves, or periodic rotation.

```
1. Existing device generates new key
2. Downloads all change logs + snapshot
3. Decrypts with old key
4. Re-encrypts with new key
5. Uploads re-encrypted files (atomic: write new files, then delete old)
6. Distributes new key to remaining devices (QR/passphrase, same as initial setup)
```

This is expensive (re-upload everything) but infrequent. For a mesh meal planner, we're talking about re-encrypting maybe 1-5MB. Takes seconds.

The old key should be discarded from all devices after rotation. The app can prompt: "A key rotation is pending. Enter new key or scan QR code."

### Encryption Disabled by Default

Encryption adds onboarding friction (key transfer step). Default is unencrypted. User can enable it in settings.

```json
// manifest.json
{
  "version": 1,
  "meshId": "hh_a1b2c3d4",
  "schema": 3,
  "encrypted": false
}
```

When enabled:
1. App generates key, shows it to user
2. Re-encrypts any existing data in the cloud folder
3. Sets `"encrypted": true` in manifest
4. Other devices see the flag, prompt for key on next sync

### Recovery

If ALL devices lose the key (all browsers cleared, all phones lost):
- Data in cloud folder is **unrecoverable**. This is by design — if you could recover without the key, so could an attacker.
- The app should warn clearly when enabling encryption: "Write down this key and store it somewhere safe. If all your devices are lost, this is the only way to recover your data."
- Suggest: take a screenshot of the QR code, print it, put it in a drawer.

### Security Properties

| Property | Status |
|---|---|
| Data at rest in cloud folder | AES-256-GCM encrypted |
| Data in transit (browser ↔ cloud API) | TLS (provider enforced) |
| Data at rest on device (IndexedDB) | Cleartext (OS-level encryption responsibility) |
| Key in cloud folder | Never stored there |
| Key in transit during transfer | URL fragment (never hits server) or spoken/typed passphrase |
| Google/Dropbox/Microsoft can read data | No (without key) |
| Compromised cloud account can read data | No (without key) |
| IV reuse | Impossible (random 96-bit IV per entry, 2^96 space) |
| Tamper detection | GCM auth tag — corrupted ciphertext fails decryption |
| Forward secrecy | No — compromised key decrypts all past data. Key rotation limits blast radius. |

### Data Residency (unchanged)
- Data lives wherever the cloud storage account is hosted
- For Australian users on Google: likely Sydney or Singapore region
- No third-party servers ever see the data or the key

## Onboarding UX Flow

### First User (Create Mesh)

```
1. "Welcome! Let's set up your mesh."
2. "Where should we store shared data?"
   → [Google Drive] [Dropbox] [OneDrive]
3. OAuth flow → grant folder access
4. App creates /Interocitor/ folder structure
5. "Encrypt your data?" → [Yes] [No, maybe later]
   If yes:
   a. App generates 256-bit key
   b. "Share this key with your mesh members:"
      → [Show QR Code] [Copy Key Text]
   c. "Important: write this down. If all devices are lost,
      this is the only way to recover your data."
6. "Share this folder with your mesh:"
   → [Copy sharing link] or [Enter email addresses]
7. "What's your name?" → creates user identity
8. Done. Local DB initialized. Sync active.
```

### Other Members (Join Mesh)

```
1. "Join an existing mesh"
2. "Which cloud storage is your mesh using?"
   → [Google Drive] [Dropbox] [OneDrive]
3. OAuth flow
4. "Select the shared Interocitor folder"
   → folder picker or auto-detect
5. App reads manifest.json
   If encrypted:
   a. "This mesh is encrypted. Enter the key:"
      → [Scan QR Code] [Paste Key Text]
   b. App verifies key by attempting to decrypt one entry
   c. If wrong key → "Key doesn't match. Try again."
6. App downloads snapshot, syncs
7. "What's your name?" → added to users
8. Done. Full local copy in seconds.
```

## Performance Characteristics

| Operation | Expected Latency |
|---|---|
| Local read (IDB) | < 5ms |
| Local write (IDB + queue) | < 10ms |
| Sync push (flush outbox to cloud) | 200-500ms per API call |
| Sync pull (poll + download + merge) | 500ms-2s depending on change volume |
| Full rehydration from snapshot | 2-10s for typical mesh data (< 1MB) |
| Compaction | 1-5s locally, one API write |

## What This Architecture Does NOT Solve

- **Real-time collaboration** (e.g. two people editing the same form field simultaneously) — 30-60s polling is not real-time. For that, you'd need WebRTC or a signaling server. Probably not needed for mesh meal planning.
- **Large binary data** (photos, PDFs) — change logs are for structured data. Binary assets need a separate strategy (store in cloud folder, reference by path).
- **Fine-grained permissions** — everyone in the folder sees everything. Acceptable for mesh, not for multi-tenant.
- **Unlimited offline writes after retention** — once `gcFloorHlc` advances, clients with pre-floor outbox entries must rehydrate instead of flushing. This protects the mesh from very old devices, but their stale unsynced writes are not merged automatically.

## Implementation Order

1. **Local DB layer** — IndexedDB with HLC columns on every field. CRUD operations.
2. **Change log serializer** — write local changes as NDJSON entries with HLC.
3. **Merge engine** — given a set of change entries, merge into local DB using HLC comparison.
4. **Google Drive adapter** — OAuth, folder CRUD, file read/write.
5. **Sync engine** — poll loop, outbox flush, cursor management.
6. **Snapshot/compaction** — periodic state dump, rehydration.
7. **Onboarding UI** — create/join mesh, folder selection.
8. **Second adapter** (Dropbox or OneDrive) — prove the adapter interface works.
