import XCTest
@testable import InterocitorSwift

// MARK: - HLC Tests

final class HLCTests: XCTestCase {

    func testHlcInit() {
        let clock = hlcInit(nodeId: "dev_test")
        XCTAssertEqual(clock.nodeId, "dev_test")
        XCTAssertEqual(clock.counter, 0)
        XCTAssertGreaterThan(clock.ts, 0)
    }

    func testHlcNow_wallAdvances() {
        let clock = HLC(ts: 1000, counter: 5, nodeId: "dev_a")
        let next = hlcNow(clock)
        // Wall time should be >> 1000ms (epoch 1970)
        XCTAssertGreaterThan(next.ts, clock.ts)
        XCTAssertEqual(next.counter, 0)
    }

    func testHlcNow_sameWall() {
        // Simulate wall time not advancing by giving a far-future ts
        let future: Int64 = 9_999_999_999_999
        let clock = HLC(ts: future, counter: 3, nodeId: "dev_a")
        let next = hlcNow(clock)
        XCTAssertEqual(next.ts, future)
        XCTAssertEqual(next.counter, 4)
    }

    func testHlcSerializeAndParse() {
        let clock = HLC(ts: 1_711_785_600_000, counter: 0x1a2b, nodeId: "dev_x1")
        let s = hlcSerialize(clock)
        // ts padded to 15 digits, counter to 4 hex
        XCTAssertTrue(s.hasPrefix("001711785600000-1a2b-dev_x1"))
        let parsed = hlcParse(s)
        XCTAssertEqual(parsed.ts, clock.ts)
        XCTAssertEqual(parsed.counter, clock.counter)
        XCTAssertEqual(parsed.nodeId, clock.nodeId)
    }

    func testHlcCompare() {
        let a = HLC(ts: 100, counter: 0, nodeId: "dev_a")
        let b = HLC(ts: 200, counter: 0, nodeId: "dev_a")
        XCTAssertLessThan(hlcCompare(a, b), 0)
        XCTAssertGreaterThan(hlcCompare(b, a), 0)
        XCTAssertEqual(hlcCompare(a, a), 0)
    }

    func testHlcCompareStr_lexicographic() {
        let a = hlcSerialize(HLC(ts: 100, counter: 0, nodeId: "dev_a"))
        let b = hlcSerialize(HLC(ts: 200, counter: 0, nodeId: "dev_a"))
        XCTAssertLessThan(hlcCompareStr(a, b), 0)
        XCTAssertGreaterThan(hlcCompareStr(b, a), 0)
        XCTAssertEqual(hlcCompareStr(a, a), 0)
    }

    func testHlcReceive_futureSkewClamped() {
        let local = hlcInit(nodeId: "dev_local")
        let farFuture = Int64(Date().timeIntervalSince1970 * 1000) + HLC_MAX_FUTURE_SKEW_MS + 60_000
        let remote = HLC(ts: farFuture, counter: 0, nodeId: "dev_remote")
        let merged = hlcReceive(local, remote)
        // Should not exceed wall + max skew
        let wall = Int64(Date().timeIntervalSince1970 * 1000)
        XCTAssertLessThanOrEqual(merged.ts, wall + HLC_MAX_FUTURE_SKEW_MS + 1000)
    }
}

// MARK: - CRDT Tests

final class CRDTTests: XCTestCase {

    func testApplyUpsertOp_basic() {
        var tables: [String: [String: Row]] = [:]
        let hlcStr = hlcSerialize(HLC(ts: 1000, counter: 0, nodeId: "dev_a"))
        let op = UpsertOp(table: "tasks", rowId: "t1", columns: [
            "title": ColumnEntry(value: .string("Hello"), hlc: hlcStr)
        ])
        let row = applyOp(tables: &tables, op: .upsert(op), schemaVersion: 1)
        XCTAssertNotNil(row)
        XCTAssertEqual(row?._table, "tasks")
        XCTAssertEqual(row?._rowId, "t1")
        XCTAssertFalse(row?._deleted ?? true)
        XCTAssertEqual(row?.columns["title"]?.value, .string("Hello"))
    }

    func testApplyUpsertOp_lwwWins() {
        var tables: [String: [String: Row]] = [:]
        let hlc1 = hlcSerialize(HLC(ts: 1000, counter: 0, nodeId: "dev_a"))
        let hlc2 = hlcSerialize(HLC(ts: 2000, counter: 0, nodeId: "dev_b"))

        let op1 = UpsertOp(table: "tasks", rowId: "t1", columns: [
            "title": ColumnEntry(value: .string("Old"), hlc: hlc1)
        ])
        let op2 = UpsertOp(table: "tasks", rowId: "t1", columns: [
            "title": ColumnEntry(value: .string("New"), hlc: hlc2)
        ])
        applyOp(tables: &tables, op: .upsert(op1), schemaVersion: 1)
        let row = applyOp(tables: &tables, op: .upsert(op2), schemaVersion: 1)
        XCTAssertEqual(row?.columns["title"]?.value, .string("New"))
    }

    func testApplyUpsertOp_olderWriteIgnored() {
        var tables: [String: [String: Row]] = [:]
        let hlc2 = hlcSerialize(HLC(ts: 2000, counter: 0, nodeId: "dev_b"))
        let hlc1 = hlcSerialize(HLC(ts: 1000, counter: 0, nodeId: "dev_a"))

        let op2 = UpsertOp(table: "tasks", rowId: "t1", columns: [
            "title": ColumnEntry(value: .string("New"), hlc: hlc2)
        ])
        let op1 = UpsertOp(table: "tasks", rowId: "t1", columns: [
            "title": ColumnEntry(value: .string("Old"), hlc: hlc1)
        ])
        applyOp(tables: &tables, op: .upsert(op2), schemaVersion: 1)
        let result = applyOp(tables: &tables, op: .upsert(op1), schemaVersion: 1)
        // No change — returns nil
        XCTAssertNil(result)
        XCTAssertEqual(tables["tasks"]?["t1"]?.columns["title"]?.value, .string("New"))
    }

    func testApplyDeleteOp() {
        var tables: [String: [String: Row]] = [:]
        let hlc1 = hlcSerialize(HLC(ts: 1000, counter: 0, nodeId: "dev_a"))
        let hlc2 = hlcSerialize(HLC(ts: 2000, counter: 0, nodeId: "dev_a"))

        let upsert = UpsertOp(table: "tasks", rowId: "t1", columns: [
            "title": ColumnEntry(value: .string("Hello"), hlc: hlc1)
        ])
        applyOp(tables: &tables, op: .upsert(upsert), schemaVersion: 1)

        let del = DeleteOp(table: "tasks", rowId: "t1", hlc: hlc2)
        let row = applyOp(tables: &tables, op: .delete(del), schemaVersion: 1)
        XCTAssertTrue(row?._deleted ?? false)
    }

    func testUpsertAfterDeleteRevivesRow() {
        var tables: [String: [String: Row]] = [:]
        let hlc1 = hlcSerialize(HLC(ts: 1000, counter: 0, nodeId: "dev_a"))
        let hlc2 = hlcSerialize(HLC(ts: 2000, counter: 0, nodeId: "dev_a"))
        let hlc3 = hlcSerialize(HLC(ts: 3000, counter: 0, nodeId: "dev_a"))

        applyOp(tables: &tables, op: .upsert(UpsertOp(table: "t", rowId: "r1", columns: ["x": ColumnEntry(value: .int(1), hlc: hlc1)])), schemaVersion: 1)
        applyOp(tables: &tables, op: .delete(DeleteOp(table: "t", rowId: "r1", hlc: hlc2)), schemaVersion: 1)
        let row = applyOp(tables: &tables, op: .upsert(UpsertOp(table: "t", rowId: "r1", columns: ["x": ColumnEntry(value: .int(2), hlc: hlc3)])), schemaVersion: 1)
        XCTAssertFalse(row?._deleted ?? true)
        XCTAssertEqual(row?.columns["x"]?.value, .int(2))
    }
}

// MARK: - MemoryLocalStore Tests

final class MemoryLocalStoreTests: XCTestCase {

    var store: MemoryLocalStore!

    override func setUp() async throws {
        store = MemoryLocalStore()
        try await store.open()
    }

    func testPutAndGetRow() async throws {
        let row = Row(table: "tasks", rowId: "t1", columns: [
            "title": ColumnEntry(value: .string("Buy milk"), hlc: "001000000000000-0000-dev_a")
        ])
        try await store.putRow(row)
        let fetched = try await store.getRow(table: "tasks", rowId: "t1")
        XCTAssertEqual(fetched?._rowId, "t1")
        XCTAssertEqual(fetched?.columns["title"]?.value, .string("Buy milk"))
    }

    func testGetTable_excludesDeleted() async throws {
        let live = Row(table: "tasks", rowId: "t1", deleted: false, columns: [:])
        let dead = Row(table: "tasks", rowId: "t2", deleted: true, columns: [:])
        try await store.putRows([live, dead])
        let rows = try await store.getTable("tasks")
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0]._rowId, "t1")
    }

    func testOutbox() async throws {
        let entry = ChangeEntry(
            id: "chg_1", ts: 1000, device: "dev_a", hlc: "001000000000000-0000-dev_a",
            ops: []
        )
        try await store.pushOutbox(entry)
        let size1 = try await store.outboxSize(); XCTAssertEqual(size1, 1)
        let drained = try await store.drainOutbox()
        XCTAssertEqual(drained.count, 1)
        XCTAssertEqual(drained[0].id, "chg_1")
        let size0 = try await store.outboxSize(); XCTAssertEqual(size0, 0)
    }

    func testCursors() async throws {
        try await store.setCursor(deviceId: "dev_a", offset: 42)
        let v = try await store.getCursor(deviceId: "dev_a")
        XCTAssertEqual(v, 42)
        let all = try await store.getAllCursors()
        XCTAssertEqual(all["dev_a"], 42)
    }

    func testMeta() async throws {
        try await store.setMeta(key: "hlc", value: AnyCodable.string("001000000000000-0000-dev_a"))
        let v = try await store.getMeta(key: "hlc")
        XCTAssertEqual((v as? AnyCodable)?.stringValue, "001000000000000-0000-dev_a")
    }

    func testClearAll() async throws {
        let row = Row(table: "tasks", rowId: "t1", columns: [:])
        try await store.putRow(row)
        try await store.clearAll()
        let rows = try await store.getAllRows()
        XCTAssertTrue(rows.isEmpty)
    }
}

// MARK: - Interocitor (memory) Tests

final class SyncEngineMemoryTests: XCTestCase {

    func makePair() -> (Interocitor, Interocitor, MemoryStorageAdapter) {
        let shared = MemoryStorageAdapter()
        let cfg = SyncConfig(remotePath: "/TestApp", pollInterval: 9999, flushDebounce: 0)
        let engineA = Interocitor(adapter: shared, config: cfg, localStore: MemoryLocalStore())
        let engineB = Interocitor(adapter: shared, config: cfg, localStore: MemoryLocalStore())
        return (engineA, engineB, shared)
    }

    func testBasicSync() async throws {
        let (a, b, _) = makePair()
        try await a.initialize()
        try await b.initialize()
        try await a.connect()

        try await a.put(table: "tasks", rowId: "t1", columns: ["title": .string("Hello")])
        try await a.flush()

        try await b.connect()
        let row = try await b.get(table: "tasks", rowId: "t1")
        XCTAssertEqual(row?.columns["title"]?.value, .string("Hello"))
    }

    func testLocalWriteBeforeConnect() async throws {
        let (a, _, _) = makePair()
        try await a.initialize()
        try await a.put(table: "notes", rowId: "n1", columns: ["body": .string("offline")])

        let row = try await a.get(table: "notes", rowId: "n1")
        XCTAssertEqual(row?.columns["body"]?.value, .string("offline"))
    }

    func testDeleteSync() async throws {
        let (a, b, _) = makePair()
        try await a.initialize()
        try await b.initialize()
        try await a.connect()

        try await a.put(table: "tasks", rowId: "t1", columns: ["title": .string("Hello")])
        try await a.flush()
        try await b.connect()

        try await a.delete(table: "tasks", rowId: "t1")
        try await a.flush()
        try await b.pull()

        let row = try await b.get(table: "tasks", rowId: "t1")
        XCTAssertNil(row)
    }

    func testQueryWhere_equals() async throws {
        let (a, _, _) = makePair()
        try await a.initialize()
        try await a.put(table: "tasks", rowId: "t1", columns: ["status": .string("open")])
        try await a.put(table: "tasks", rowId: "t2", columns: ["status": .string("done")])

        let clause = WhereClause(field: "status", op: .equals, value: .string("open"))
        let results = try await a.queryWhere(table: "tasks", clause: clause)
        XCTAssertEqual(results.count, 1)
        XCTAssertEqual(results[0]._rowId, "t1")
    }

    func testCompaction() async throws {
        let (a, b, _) = makePair()
        try await a.initialize()
        try await b.initialize()
        try await a.connect()

        try await a.put(table: "tasks", rowId: "t1", columns: ["title": .string("Hello")])
        try await a.flush()
        try await a.compact()

        // B joins after compaction — should rehydrate from snapshot
        try await b.connect()
        let row = try await b.get(table: "tasks", rowId: "t1")
        XCTAssertEqual(row?.columns["title"]?.value, .string("Hello"))
    }
}

// MARK: - Crypto Tests

final class CryptoTests: XCTestCase {

    // MARK: Key generation & raw export/import

    func testGenerateMeshKey_is256bits() {
        let key = generateMeshKey()
        let raw = exportKeyRaw(key)
        XCTAssertEqual(raw.count, 32)
    }

    func testGenerateMeshKey_uniqueEachTime() {
        let a = exportKeyRaw(generateMeshKey())
        let b = exportKeyRaw(generateMeshKey())
        XCTAssertNotEqual(a, b)
    }

    func testImportKeyRaw_roundTrip() throws {
        let key = generateMeshKey()
        let raw = exportKeyRaw(key)
        let restored = try importKeyRaw(raw)
        XCTAssertEqual(exportKeyRaw(restored), raw)
    }

    func testImportKeyRaw_rejectsBadSize() {
        XCTAssertThrowsError(try importKeyRaw(Data([0x01, 0x02])))
    }

    // MARK: Base58

    func testBase58RoundTrip() throws {
        let key = generateMeshKey()
        let raw = exportKeyRaw(key)
        let encoded = base58Encode(raw)
        let decoded = try base58Decode(encoded)
        XCTAssertEqual(decoded, raw)
    }

    func testBase58_invalidChar() {
        XCTAssertThrowsError(try base58Decode("invalid-char!"))
    }

    // MARK: Passphrase

    func testPassphraseRoundTrip() throws {
        let key = generateMeshKey()
        let passphrase = keyToPassphrase(key)
        XCTAssertFalse(passphrase.isEmpty)
        XCTAssertGreaterThan(passphrase.count, 30) // ~43 chars for 256-bit key
        let restored = try passphraseToKey(passphrase)
        XCTAssertEqual(exportKeyRaw(restored), exportKeyRaw(key))
    }

    func testPassphraseToKey_tripsWhitespace() throws {
        let key = generateMeshKey()
        let passphrase = "  " + keyToPassphrase(key) + "  "
        let restored = try passphraseToKey(passphrase)
        XCTAssertEqual(exportKeyRaw(restored), exportKeyRaw(key))
    }

    // MARK: Share URL

    func testShareURLRoundTrip() throws {
        let key = generateMeshKey()
        let url = keyToShareURL(key, baseURL: "https://app.example.com/join")
        XCTAssertTrue(url.contains("#key="))
        guard let fragment = url.components(separatedBy: "#").last,
              let rawBytes = keyFromFragment(fragment) else {
            XCTFail("keyFromFragment returned nil"); return
        }
        let restored = try importKeyRaw(rawBytes)
        XCTAssertEqual(exportKeyRaw(restored), exportKeyRaw(key))
    }

    func testKeyFromFragment_returnsNilForMissingParam() {
        XCTAssertNil(keyFromFragment("nope=123"))
    }

    // MARK: Encrypt / Decrypt

    func testEncryptDecryptRoundTrip() throws {
        let key = generateMeshKey()
        let plaintext = #"{"id":"chg_1","ops":[]}"#
        let envelope = try encryptEntry(key, plaintext: plaintext)
        XCTAssertTrue(envelope.hasPrefix("{")) // JSON envelope
        let decrypted = try decryptEntry(key, envelopeStr: envelope)
        XCTAssertEqual(decrypted, plaintext)
    }

    func testEncrypt_randomIV_differentCiphertextEachTime() throws {
        let key = generateMeshKey()
        let a = try encryptEntry(key, plaintext: "same input")
        let b = try encryptEntry(key, plaintext: "same input")
        XCTAssertNotEqual(a, b)
    }

    func testDecrypt_wrongKeyThrows() throws {
        let keyA = generateMeshKey()
        let keyB = generateMeshKey()
        let envelope = try encryptEntry(keyA, plaintext: "secret")
        XCTAssertThrowsError(try decryptEntry(keyB, envelopeStr: envelope))
    }

    func testDecrypt_corruptCiphertextThrows() {
        let key = generateMeshKey()
        let corrupt = #"{"v":1,"iv":"AAAA","ct":"BBBB"}"#
        XCTAssertThrowsError(try decryptEntry(key, envelopeStr: corrupt))
    }

    func testDecrypt_unknownVersionThrows() {
        let key = generateMeshKey()
        let bad = #"{"v":99,"iv":"AAAA","ct":"BBBB"}"#
        XCTAssertThrowsError(try decryptEntry(key, envelopeStr: bad))
    }

    func testTryDecryptEntry_returnsNilOnFailure() throws {
        let keyA = generateMeshKey()
        let keyB = generateMeshKey()
        let envelope = try encryptEntry(keyA, plaintext: "secret")
        XCTAssertNil(tryDecryptEntry(keyB, envelopeStr: envelope))
    }

    func testVerifyKey_correctKey() throws {
        let key = generateMeshKey()
        let sample = try encryptEntry(key, plaintext: "test")
        XCTAssertTrue(verifyKey(key, sampleEncrypted: sample))
    }

    func testVerifyKey_wrongKey() throws {
        let keyA = generateMeshKey()
        let keyB = generateMeshKey()
        let sample = try encryptEntry(keyA, plaintext: "test")
        XCTAssertFalse(verifyKey(keyB, sampleEncrypted: sample))
    }

    // MARK: Envelope structure

    func testEnvelope_hasVersionIVAndCT() throws {
        let key = generateMeshKey()
        let envelope = try encryptEntry(key, plaintext: "hello")
        let data = envelope.data(using: .utf8)!
        let parsed = try JSONDecoder().decode(EncryptedEnvelope.self, from: data)
        XCTAssertEqual(parsed.v, 1)
        XCTAssertFalse(parsed.iv.isEmpty)
        XCTAssertFalse(parsed.ct.isEmpty)
        // IV should decode to 12 bytes
        let ivBytes = Data(base64Encoded: parsed.iv)!
        XCTAssertEqual(ivBytes.count, 12)
    }
}

// MARK: - Encrypted Interocitor Tests

final class EncryptedSyncEngineTests: XCTestCase {

    func makeEncryptedPair(key: MeshKey? = nil) -> (Interocitor, Interocitor, MeshKey) {
        let shared = MemoryStorageAdapter()
        let meshKey = key ?? generateMeshKey()
        let cfg = SyncConfig(remotePath: "/EncryptedApp", pollInterval: 9999, flushDebounce: 0)
        let engineA = Interocitor(adapter: shared, config: cfg, localStore: MemoryLocalStore())
        let engineB = Interocitor(adapter: shared, config: cfg, localStore: MemoryLocalStore())
        return (engineA, engineB, meshKey)
    }

    func testEncryptedSync_basicRoundTrip() async throws {
        let (a, b, key) = makeEncryptedPair()
        await a.setEncryptionKey(key)
        await b.setEncryptionKey(key)

        try await a.initialize()
        try await b.initialize()
        try await a.connect()

        try await a.put(table: "notes", rowId: "n1", columns: ["body": .string("encrypted hello")])
        try await a.flush()

        try await b.connect()
        let row = try await b.get(table: "notes", rowId: "n1")
        XCTAssertEqual(row?.columns["body"]?.value, .string("encrypted hello"))
    }

    func testEncryptedChangeFilesAreMeshBoundAndDoNotLeakPlaintext() async throws {
        let shared = MemoryStorageAdapter()
        let key = generateMeshKey()
        let cfg = SyncConfig(remotePath: "/EncryptedFingerprintChange", pollInterval: 9999, flushDebounce: 0)
        let engine = Interocitor(adapter: shared, config: cfg, localStore: MemoryLocalStore())
        await engine.setEncryptionKey(key)

        try await engine.initialize()
        try await engine.connect()
        try await engine.put(table: "notes", rowId: "n1", columns: ["body": .string("classified")])
        try await engine.flush()
        let meshId = await engine.getMeshId()
        try await engine.disconnect()

        let files = try await shared.listFiles(path: "/EncryptedFingerprintChange/changes")
        let payloadFile = try XCTUnwrap(files.first(where: { $0.name.contains("-chg_") }))
        let ciphertextData = try await shared.readFile(path: payloadFile.path)
        let ciphertext = try XCTUnwrap(String(data: ciphertextData, encoding: .utf8))
        XCTAssertFalse(ciphertext.contains("classified"))

        let decrypted = try decryptEntry(key, envelopeStr: ciphertext)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(decrypted.utf8)) as? [String: Any])
        XCTAssertEqual(object["kind"] as? String, "change")
        XCTAssertEqual(object["meshId"] as? String, meshId)
    }

    func testEncryptedSnapshotsAreMeshBoundAndDoNotLeakPlaintext() async throws {
        let shared = MemoryStorageAdapter()
        let key = generateMeshKey()
        let cfg = SyncConfig(remotePath: "/EncryptedFingerprintSnapshot", pollInterval: 9999, flushDebounce: 0)
        let engine = Interocitor(adapter: shared, config: cfg, localStore: MemoryLocalStore())
        await engine.setEncryptionKey(key)

        try await engine.initialize()
        try await engine.connect()
        try await engine.put(table: "notes", rowId: "n1", columns: ["body": .string("classified snapshot")])
        try await engine.flush()
        try await engine.compact()
        let meshId = await engine.getMeshId()
        try await engine.disconnect()

        let files = try await shared.listFiles(path: "/EncryptedFingerprintSnapshot/mainline")
        let payloadFile = try XCTUnwrap(files.first(where: { $0.name.hasPrefix("snapshot-") }))
        let ciphertextData = try await shared.readFile(path: payloadFile.path)
        let ciphertext = try XCTUnwrap(String(data: ciphertextData, encoding: .utf8))
        XCTAssertFalse(ciphertext.contains("classified snapshot"))

        let decrypted = try decryptEntry(key, envelopeStr: ciphertext)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(decrypted.utf8)) as? [String: Any])
        XCTAssertEqual(object["kind"] as? String, "snapshot")
        XCTAssertEqual(object["meshId"] as? String, meshId)
        let snapshot = object["snapshot"] as? [String: Any]
        let tables = snapshot?["tables"] as? [String: Any]
        XCTAssertNotNil(tables?["notes"])
    }

    func testEncryptedWrongMeshDataPoisonsTheRemote() async throws {
        let shared = MemoryStorageAdapter()
        let key = generateMeshKey()

        let sourceCfg = SyncConfig(remotePath: "/EncryptedPoisonSource", pollInterval: 9999, flushDebounce: 0)
        let source = Interocitor(adapter: shared, config: sourceCfg, localStore: MemoryLocalStore())
        await source.setEncryptionKey(key)
        try await source.initialize()
        try await source.connect()
        try await source.put(table: "notes", rowId: "n1", columns: ["body": .string("poison me")])
        try await source.flush()
        try await source.disconnect()

        let targetSeedCfg = SyncConfig(remotePath: "/EncryptedPoisonTarget", pollInterval: 9999, flushDebounce: 0)
        let targetSeed = Interocitor(adapter: shared, config: targetSeedCfg, localStore: MemoryLocalStore())
        await targetSeed.setEncryptionKey(key)
        try await targetSeed.initialize()
        try await targetSeed.connect()
        try await targetSeed.disconnect()

        let sourceFiles = try await shared.listFiles(path: "/EncryptedPoisonSource/changes")
        let sourceFile = try XCTUnwrap(sourceFiles.first(where: { $0.name.contains("-chg_") }))
        let sourceData = try await shared.readFile(path: sourceFile.path)
        let poisonedPath = sourceFile.path.replacingOccurrences(of: "/EncryptedPoisonSource/", with: "/EncryptedPoisonTarget/")
        try await shared.writeFile(path: poisonedPath, data: sourceData)

        let target = Interocitor(adapter: shared, config: targetSeedCfg, localStore: MemoryLocalStore())
        await target.setEncryptionKey(key)
        try await target.initialize()

        do {
            try await target.connect()
            XCTFail("Expected target.connect() to fail for wrong-mesh data")
        } catch {
            XCTAssertTrue(String(describing: error).contains("mesh mismatch") || String(describing: error).contains("Remote poisoned"))
        }
        do {
            try await target.pull()
            XCTFail("Expected target.pull() to stay cut off after poisoning")
        } catch {
            XCTAssertTrue(String(describing: error).contains("mesh mismatch") || String(describing: error).contains("Remote poisoned"))
        }
    }

    func testEncryptedSync_wrongKeyCannotRead() async throws {
        let (_, _, key) = makeEncryptedPair()
        let wrongKey = generateMeshKey()
        _ = key

        let shared = MemoryStorageAdapter()
        let cfg = SyncConfig(remotePath: "/EncryptedApp2", pollInterval: 9999, flushDebounce: 0)
        let engineA = Interocitor(adapter: shared, config: cfg, localStore: MemoryLocalStore())
        let engineB = Interocitor(adapter: shared, config: cfg, localStore: MemoryLocalStore())

        await engineA.setEncryptionKey(key)
        await engineB.setEncryptionKey(wrongKey)

        try await engineA.initialize()
        try await engineB.initialize()
        try await engineA.connect()

        try await engineA.put(table: "notes", rowId: "n1", columns: ["body": .string("secret")])
        try await engineA.flush()

        do {
            try await engineB.connect()
            XCTFail("Expected engineB.connect() to fail with the wrong key")
        } catch {
            XCTAssertTrue(String(describing: error).contains("authenticationFailure") || String(describing: error).contains("Remote poisoned"))
        }
    }

    func testEncryptedSync_compactionAndRehydration() async throws {
        let (a, b, key) = makeEncryptedPair()
        await a.setEncryptionKey(key)
        await b.setEncryptionKey(key)

        try await a.initialize()
        try await b.initialize()
        try await a.connect()

        try await a.put(table: "tasks", rowId: "t1", columns: ["title": .string("Encrypted Task")])
        try await a.flush()
        try await a.compact()

        try await b.connect()
        let row = try await b.get(table: "tasks", rowId: "t1")
        XCTAssertEqual(row?.columns["title"]?.value, .string("Encrypted Task"))
    }

    func testIsEncrypted_flagReflectsState() async {
        let cfg = SyncConfig(remotePath: "/x")
        let engine = Interocitor(config: cfg)
        let notEncrypted = await engine.isEncrypted()
        XCTAssertFalse(notEncrypted)

        let key = generateMeshKey()
        await engine.setEncryptionKey(key)
        let nowEncrypted = await engine.isEncrypted()
        XCTAssertTrue(nowEncrypted)
    }
}

// MARK: - WebDAV Adapter Tests (against MemoryStorageAdapter as stand-in)

// Note: Full WebDAV wire-protocol tests require a running server.
// Here we verify the adapter's URL construction and auth-header logic
// using a mock URLSession, and do a structural sanity check.

final class WebDAVAdapterTests: XCTestCase {

    func testWebDAVConfig_stripsTrailingSlash() {
        let cfg = WebDAVConfig(baseURL: "http://localhost:4173/", auth: .basic(username: "u", password: "p"))
        XCTAssertFalse(cfg.baseURL.hasSuffix("/"))
    }

    func testWebDAVAuth_basicHeader() {
        let auth = WebDAVAuth.basic(username: "alice", password: "pass")
        XCTAssertTrue(auth.headerValue.hasPrefix("Basic "))
        // Decode and verify
        let b64 = auth.headerValue.dropFirst(6)
        let decoded = String(data: Data(base64Encoded: String(b64))!, encoding: .utf8)!
        XCTAssertEqual(decoded, "alice:pass")
    }

    func testWebDAVAuth_bearerHeader() {
        let auth = WebDAVAuth.bearer(token: "mytoken123")
        XCTAssertEqual(auth.headerValue, "Bearer mytoken123")
    }

    func testWebDAVError_localizedDescription() {
        let err = WebDAVError.httpError(404, "GET /changes")
        XCTAssertTrue(err.localizedDescription.contains("404"))
    }
}

// MARK: - Cloudflare Adapter Tests

final class CloudflareAdapterTests: XCTestCase {

    func testCloudflareConfig_stripsTrailingSlash() {
        let cfg = CloudflareAdapterConfig(baseURL: "https://worker.example.com/io/team/", token: nil)
        XCTAssertFalse(cfg.baseURL.hasSuffix("/"))
    }

    func testCloudflareConfig_withToken() {
        let cfg = CloudflareAdapterConfig(baseURL: "https://worker.example.com/io/team", token: "tok123")
        XCTAssertEqual(cfg.token, "tok123")
    }

    func testCloudflareError_localizedDescription() {
        let err = CloudflareError.authFailed
        XCTAssertFalse(err.localizedDescription.isEmpty)
        let httpErr = CloudflareError.httpError(500, "PUT file")
        XCTAssertTrue(httpErr.localizedDescription.contains("500"))
    }
}
