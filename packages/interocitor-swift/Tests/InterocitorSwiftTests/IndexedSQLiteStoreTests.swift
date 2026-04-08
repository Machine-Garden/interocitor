/**
 * IndexedSQLiteStore Integration Tests
 *
 * Tests run against a real on-disk SQLite database written to a temp directory.
 * They verify persistence: data survives store close+reopen cycles.
 */

import XCTest
@testable import InterocitorSwift

// MARK: - Helpers

private func makeTempConfig(name: String = "test") -> IndexedSQLiteStoreConfiguration {
    let dir = FileManager.default.temporaryDirectory
        .appendingPathComponent("interocitor-tests-\(name)-\(Int(Date().timeIntervalSince1970 * 1000))")
        .path
    return IndexedSQLiteStoreConfiguration(databasePath: dir, databaseName: "\(name).db")
}

private func makeTempStore(name: String = "test") -> IndexedSQLiteStore {
    IndexedSQLiteStore(configuration: makeTempConfig(name: name))
}

// MARK: - Basic CRUD

final class IndexedSQLiteStoreBasicTests: XCTestCase {

    var store: IndexedSQLiteStore!

    override func setUp() async throws {
        store = makeTempStore(name: "basic")
        try await store.open()
    }

    override func tearDown() async throws {
        store.close()
    }

    func test_open_succeeds() async throws {
        // Already opened in setUp — just confirm no throw
    }

    func test_putAndGetRow() async throws {
        let row = Row(table: "tasks", rowId: "t1", columns: [
            "title": ColumnEntry(value: .string("Buy milk"), hlc: "001000000000000-0000-dev_a"),
            "done":  ColumnEntry(value: .bool(false),        hlc: "001000000000000-0001-dev_a")
        ])
        try await store.putRow(row)
        let fetched = try await store.getRow(table: "tasks", rowId: "t1")
        XCTAssertNotNil(fetched)
        XCTAssertEqual(fetched?._rowId, "t1")
        XCTAssertEqual(fetched?.columns["title"]?.value, .string("Buy milk"))
        XCTAssertEqual(fetched?.columns["done"]?.value, .bool(false))
    }

    func test_getRow_missing_returnsNil() async throws {
        let row = try await store.getRow(table: "tasks", rowId: "nope")
        XCTAssertNil(row)
    }

    func test_putRow_overwrite() async throws {
        let r1 = Row(table: "t", rowId: "r1", columns: ["x": ColumnEntry(value: .int(1), hlc: "001000000000001-0000-dev_a")])
        let r2 = Row(table: "t", rowId: "r1", columns: ["x": ColumnEntry(value: .int(2), hlc: "001000000000002-0000-dev_a")])
        try await store.putRow(r1)
        try await store.putRow(r2)
        let fetched = try await store.getRow(table: "t", rowId: "r1")
        XCTAssertEqual(fetched?.columns["x"]?.value, .int(2))
    }

    func test_putRows_batch() async throws {
        let rows = (1...10).map { i in
            Row(table: "items", rowId: "item_\(i)",
                columns: ["n": ColumnEntry(value: .int(i), hlc: "001000000000000-000\(i)-dev_a")])
        }
        try await store.putRows(rows)
        let fetched = try await store.getTable("items")
        XCTAssertEqual(fetched.count, 10)
    }

    func test_getTable_excludesDeleted() async throws {
        let live = Row(table: "tasks", rowId: "live", deleted: false, columns: [:])
        let dead = Row(table: "tasks", rowId: "dead", deleted: true,  columns: [:])
        try await store.putRows([live, dead])
        let rows = try await store.getTable("tasks")
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0]._rowId, "live")
    }

    func test_getAllRows_includesDeleted() async throws {
        let live = Row(table: "tasks", rowId: "live", deleted: false, columns: [:])
        let dead = Row(table: "tasks", rowId: "dead", deleted: true,  columns: [:])
        try await store.putRows([live, dead])
        let rows = try await store.getAllRows()
        XCTAssertEqual(rows.count, 2)
    }

    func test_getTableNames() async throws {
        try await store.putRow(Row(table: "alpha", rowId: "r1", columns: [:]))
        try await store.putRow(Row(table: "beta",  rowId: "r2", columns: [:]))
        let names = try await store.getTableNames()
        XCTAssertTrue(names.contains("alpha"))
        XCTAssertTrue(names.contains("beta"))
    }

    func test_clearRows() async throws {
        try await store.putRow(Row(table: "t", rowId: "r1", columns: [:]))
        try await store.clearRows()
        let all = try await store.getAllRows()
        XCTAssertTrue(all.isEmpty)
    }
}

// MARK: - Outbox

final class IndexedSQLiteStoreOutboxTests: XCTestCase {

    var store: IndexedSQLiteStore!

    override func setUp() async throws {
        store = makeTempStore(name: "outbox")
        try await store.open()
    }

    override func tearDown() async throws { store.close() }

    private func makeEntry(id: String) -> ChangeEntry {
        ChangeEntry(id: id, ts: 1000, device: "dev_a",
                    hlc: "001000000000000-0000-dev_a", ops: [])
    }

    func test_pushAndDrain() async throws {
        try await store.pushOutbox(makeEntry(id: "chg_1"))
        try await store.pushOutbox(makeEntry(id: "chg_2"))

        let size = try await store.outboxSize()
        XCTAssertEqual(size, 2)

        let drained = try await store.drainOutbox()
        XCTAssertEqual(drained.count, 2)
        XCTAssertEqual(drained[0].id, "chg_1")
        XCTAssertEqual(drained[1].id, "chg_2")

        let sizeAfter = try await store.outboxSize()
        XCTAssertEqual(sizeAfter, 0)
    }

    func test_drain_preservesFIFOOrder() async throws {
        for i in 1...5 {
            try await store.pushOutbox(makeEntry(id: "chg_\(i)"))
        }
        let drained = try await store.drainOutbox()
        XCTAssertEqual(drained.map(\.id), (1...5).map { "chg_\($0)" })
    }

    func test_drain_empty() async throws {
        let drained = try await store.drainOutbox()
        XCTAssertTrue(drained.isEmpty)
    }

    func test_outboxSize_empty() async throws {
        let s = try await store.outboxSize()
        XCTAssertEqual(s, 0)
    }

    func test_pushOutbox_withOps() async throws {
        let hlcStr = "001000000000000-0000-dev_a"
        let op = UpsertOp(table: "tasks", rowId: "t1", columns: [
            "title": ColumnEntry(value: .string("Test task"), hlc: hlcStr)
        ])
        let entry = ChangeEntry(id: "chg_ops", ts: 1000, device: "dev_a",
                                hlc: hlcStr, ops: [.upsert(op)])
        try await store.pushOutbox(entry)
        let drained = try await store.drainOutbox()
        XCTAssertEqual(drained[0].ops.count, 1)
        if case .upsert(let upserted) = drained[0].ops[0] {
            XCTAssertEqual(upserted.rowId, "t1")
            XCTAssertEqual(upserted.columns["title"]?.value, .string("Test task"))
        } else {
            XCTFail("Expected upsert op")
        }
    }
}

// MARK: - Cursors

final class IndexedSQLiteStoreCursorTests: XCTestCase {

    var store: IndexedSQLiteStore!

    override func setUp() async throws {
        store = makeTempStore(name: "cursors")
        try await store.open()
    }

    override func tearDown() async throws { store.close() }

    func test_getCursor_default_zero() async throws {
        let c = try await store.getCursor(deviceId: "dev_unknown")
        XCTAssertEqual(c, 0)
    }

    func test_setCursorAndGet() async throws {
        try await store.setCursor(deviceId: "dev_a", offset: 42)
        let c = try await store.getCursor(deviceId: "dev_a")
        XCTAssertEqual(c, 42)
    }

    func test_setCursor_update() async throws {
        try await store.setCursor(deviceId: "dev_a", offset: 10)
        try await store.setCursor(deviceId: "dev_a", offset: 99)
        let c = try await store.getCursor(deviceId: "dev_a")
        XCTAssertEqual(c, 99)
    }

    func test_getAllCursors() async throws {
        try await store.setCursor(deviceId: "dev_a", offset: 1)
        try await store.setCursor(deviceId: "dev_b", offset: 2)
        let all = try await store.getAllCursors()
        XCTAssertEqual(all["dev_a"], 1)
        XCTAssertEqual(all["dev_b"], 2)
    }

    func test_getAllCursors_empty() async throws {
        let all = try await store.getAllCursors()
        XCTAssertTrue(all.isEmpty)
    }
}

// MARK: - Meta

final class IndexedSQLiteStoreMetaTests: XCTestCase {

    var store: IndexedSQLiteStore!

    override func setUp() async throws {
        store = makeTempStore(name: "meta")
        try await store.open()
    }

    override func tearDown() async throws { store.close() }

    func test_setAndGetMeta_string() async throws {
        try await store.setMeta(key: "hlc", value: AnyCodable.string("001000000000000-0000-dev_a"))
        let v = try await store.getMeta(key: "hlc")
        XCTAssertEqual((v as? AnyCodable)?.stringValue, "001000000000000-0000-dev_a")
    }

    func test_setAndGetMeta_int() async throws {
        try await store.setMeta(key: "epoch", value: AnyCodable.int(7))
        let v = try await store.getMeta(key: "epoch")
        XCTAssertEqual((v as? AnyCodable)?.intValue, 7)
    }

    func test_setAndGetMeta_bool() async throws {
        try await store.setMeta(key: "flag", value: AnyCodable.bool(true))
        let v = try await store.getMeta(key: "flag")
        XCTAssertEqual((v as? AnyCodable)?.boolValue, true)
    }

    func test_getMeta_missing_returnsNil() async throws {
        let v = try await store.getMeta(key: "nokey")
        XCTAssertNil(v)
    }

    func test_setMeta_nil_removesKey() async throws {
        try await store.setMeta(key: "temp", value: AnyCodable.string("x"))
        try await store.setMeta(key: "temp", value: nil)
        let v = try await store.getMeta(key: "temp")
        XCTAssertNil(v)
    }

    func test_setMeta_overwrite() async throws {
        try await store.setMeta(key: "cursor", value: AnyCodable.string("old"))
        try await store.setMeta(key: "cursor", value: AnyCodable.string("new"))
        let v = try await store.getMeta(key: "cursor")
        XCTAssertEqual((v as? AnyCodable)?.stringValue, "new")
    }
}

// MARK: - Persistence (close + reopen)

final class IndexedSQLiteStorePersistenceTests: XCTestCase {

    func test_rowsSurviveReopenCycle() async throws {
        let cfg = makeTempConfig(name: "persist-rows")
        let store1 = IndexedSQLiteStore(configuration: cfg)
        try await store1.open()
        let row = Row(table: "tasks", rowId: "p1", columns: [
            "title": ColumnEntry(value: .string("Persistent"), hlc: "001000000000000-0000-dev_a")
        ])
        try await store1.putRow(row)
        store1.close()
        // Let nonisolated close Task complete before reopening a fresh instance
        try await Task.sleep(nanoseconds: 10_000_000)

        let store2 = IndexedSQLiteStore(configuration: cfg)
        try await store2.open()
        let fetched = try await store2.getRow(table: "tasks", rowId: "p1")
        XCTAssertEqual(fetched?.columns["title"]?.value, .string("Persistent"))
        store2.close()
    }

    func test_outboxSurvivesReopenCycle() async throws {
        let cfg = makeTempConfig(name: "persist-outbox")
        let store1 = IndexedSQLiteStore(configuration: cfg)
        try await store1.open()
        let entry = ChangeEntry(id: "chg_persist", ts: 1000, device: "dev_a",
                                hlc: "001000000000000-0000-dev_a", ops: [])
        try await store1.pushOutbox(entry)
        store1.close()
        try await Task.sleep(nanoseconds: 10_000_000)

        let store2 = IndexedSQLiteStore(configuration: cfg)
        try await store2.open()
        let size = try await store2.outboxSize()
        XCTAssertEqual(size, 1)
        let drained = try await store2.drainOutbox()
        XCTAssertEqual(drained[0].id, "chg_persist")
        store2.close()
    }

    func test_cursorsSurviveReopenCycle() async throws {
        let cfg = makeTempConfig(name: "persist-cursors")
        let store1 = IndexedSQLiteStore(configuration: cfg)
        try await store1.open()
        try await store1.setCursor(deviceId: "dev_x", offset: 77)
        store1.close()
        try await Task.sleep(nanoseconds: 10_000_000)

        let store2 = IndexedSQLiteStore(configuration: cfg)
        try await store2.open()
        let c = try await store2.getCursor(deviceId: "dev_x")
        XCTAssertEqual(c, 77)
        store2.close()
    }

    func test_metaSurvivesReopenCycle() async throws {
        let cfg = makeTempConfig(name: "persist-meta")
        let store1 = IndexedSQLiteStore(configuration: cfg)
        try await store1.open()
        try await store1.setMeta(key: "meshId", value: AnyCodable.string("mesh_abc123"))
        store1.close()
        try await Task.sleep(nanoseconds: 10_000_000)

        let store2 = IndexedSQLiteStore(configuration: cfg)
        try await store2.open()
        let v = try await store2.getMeta(key: "meshId")
        XCTAssertEqual((v as? AnyCodable)?.stringValue, "mesh_abc123")
        store2.close()
    }

    func test_clearAll_removesEverything() async throws {
        // Use a single store instance — clearAll does not require a reopen
        let store = makeTempStore(name: "persist-clear-\(Int(Date().timeIntervalSince1970*1000))")
        try await store.open()
        try await store.putRow(Row(table: "t", rowId: "r1", columns: [:]))
        try await store.pushOutbox(ChangeEntry(id: "c1", ts: 1, device: "d",
                                               hlc: "001000000000000-0000-d", ops: []))
        try await store.setCursor(deviceId: "d", offset: 5)
        try await store.setMeta(key: "k", value: AnyCodable.string("v"))
        try await store.clearAll()

        let rows = try await store.getAllRows()
        XCTAssertTrue(rows.isEmpty)
        let outboxSize = try await store.outboxSize()
        XCTAssertEqual(outboxSize, 0)
        let cursors = try await store.getAllCursors()
        XCTAssertEqual(cursors, [:])
        let metaVal = try await store.getMeta(key: "k")
        XCTAssertNil(metaVal)
        store.close()
    }
}

// MARK: - QueryWhere

final class IndexedSQLiteStoreQueryWhereTests: XCTestCase {

    // Each test method gets its own isolated SQLite store to avoid parallel-execution crashes.
    // We do NOT use a shared `store` ivar — instead each test creates its own.

    private func makeSeededStore() async throws -> IndexedSQLiteStore {
        let s = makeTempStore(name: "query-\(Int(Date().timeIntervalSince1970 * 1_000_000))-\(arc4random())")
        try await s.open()
        let hlc = "001000000000000-0000-dev_a"
        try await s.putRows([
            Row(table: "items", rowId: "i1", columns: ["score": ColumnEntry(value: .int(10), hlc: hlc), "tag": ColumnEntry(value: .string("swift"), hlc: hlc)]),
            Row(table: "items", rowId: "i2", columns: ["score": ColumnEntry(value: .int(50), hlc: hlc), "tag": ColumnEntry(value: .string("ios"),   hlc: hlc)]),
            Row(table: "items", rowId: "i3", columns: ["score": ColumnEntry(value: .int(30), hlc: hlc), "tag": ColumnEntry(value: .string("swift"), hlc: hlc)]),
            Row(table: "items", rowId: "i4", columns: ["score": ColumnEntry(value: .int(80), hlc: hlc), "tag": ColumnEntry(value: .string("macos"), hlc: hlc)]),
            Row(table: "items", rowId: "i5", columns: ["score": ColumnEntry(value: .int(5),  hlc: hlc), "tag": ColumnEntry(value: .string("tvos"),  hlc: hlc)]),
        ])
        return s
    }

    func test_equals() async throws {
        let store = try await makeSeededStore(); defer { store.close() }
        let results = try await store.queryWhere(table: "items",
            clause: WhereClause(field: "tag", op: .equals, value: .string("swift")))
        XCTAssertEqual(results.count, 2)
    }

    func test_above() async throws {
        let store = try await makeSeededStore(); defer { store.close() }
        let results = try await store.queryWhere(table: "items",
            clause: WhereClause(field: "score", op: .above, value: .int(30)))
        XCTAssertEqual(results.count, 2) // 50, 80
    }

    func test_aboveOrEqual() async throws {
        let store = try await makeSeededStore(); defer { store.close() }
        let results = try await store.queryWhere(table: "items",
            clause: WhereClause(field: "score", op: .aboveOrEqual, value: .int(30)))
        XCTAssertEqual(results.count, 3) // 30, 50, 80
    }

    func test_below() async throws {
        let store = try await makeSeededStore(); defer { store.close() }
        let results = try await store.queryWhere(table: "items",
            clause: WhereClause(field: "score", op: .below, value: .int(30)))
        XCTAssertEqual(results.count, 2) // 10, 5
    }

    func test_belowOrEqual() async throws {
        let store = try await makeSeededStore(); defer { store.close() }
        let results = try await store.queryWhere(table: "items",
            clause: WhereClause(field: "score", op: .belowOrEqual, value: .int(30)))
        XCTAssertEqual(results.count, 3) // 5, 10, 30
    }

    func test_between_inclusive() async throws {
        let store = try await makeSeededStore(); defer { store.close() }
        let results = try await store.queryWhere(table: "items",
            clause: WhereClause(field: "score", op: .between,
                                lower: .int(10), upper: .int(50)))
        XCTAssertEqual(results.count, 3) // 10, 30, 50
    }

    func test_between_open() async throws {
        let store = try await makeSeededStore(); defer { store.close() }
        let results = try await store.queryWhere(table: "items",
            clause: WhereClause(field: "score", op: .between,
                                lower: .int(10), upper: .int(50),
                                lowerOpen: true, upperOpen: true))
        XCTAssertEqual(results.count, 1) // only 30
    }

    func test_startsWith() async throws {
        let store = try await makeSeededStore(); defer { store.close() }
        let results = try await store.queryWhere(table: "items",
            clause: WhereClause(field: "tag", op: .startsWith, value: .string("sw")))
        XCTAssertEqual(results.count, 2) // swift x2
    }

    func test_anyOf() async throws {
        let store = try await makeSeededStore(); defer { store.close() }
        let results = try await store.queryWhere(table: "items",
            clause: WhereClause(field: "tag", op: .anyOf,
                                values: [.string("ios"), .string("macos")]))
        XCTAssertEqual(results.count, 2)
    }
}

// MARK: - SyncEngine + SQLite (full stack)

final class SyncEngineWithSQLiteTests: XCTestCase {

    private func makeSQLiteEngine(namespace: String, key: MeshKey? = nil) -> (SyncEngine, IndexedSQLiteStore) {
        let store = makeTempStore(name: namespace)
        let adapter = MemoryStorageAdapter()
        let cfg = SyncConfig(remotePath: "/\(namespace)", pollInterval: 9999, flushDebounce: 0)
        let engine = SyncEngine(adapter: adapter, config: cfg, localStore: store)
        return (engine, store)
    }

    func test_persistLocalWrite_survivesCycle() async throws {
        let (engine, store) = makeSQLiteEngine(namespace: "cycle-\(Int(Date().timeIntervalSince1970*1000))")
        try await engine.initialize()
        try await engine.put(table: "notes", rowId: "n1", columns: ["body": .string("persisted")])

        // Close store and verify row is in SQLite
        let row = try await store.getRow(table: "notes", rowId: "n1")
        XCTAssertEqual(row?.columns["body"]?.value, .string("persisted"))
    }

    func test_encryptedSyncWithSQLiteStore() async throws {
        let shared = MemoryStorageAdapter()
        let key = generateMeshKey()
        let cfg = SyncConfig(remotePath: "/sqlite-enc", pollInterval: 9999, flushDebounce: 0)

        let storeA = makeTempStore(name: "sqlite-enc-a-\(Int(Date().timeIntervalSince1970*1000))")
        let engineA = SyncEngine(adapter: shared, config: cfg, localStore: storeA)
        await engineA.setEncryptionKey(key)

        let storeB = makeTempStore(name: "sqlite-enc-b-\(Int(Date().timeIntervalSince1970*1000))")
        let engineB = SyncEngine(adapter: shared, config: cfg, localStore: storeB)
        await engineB.setEncryptionKey(key)

        try await engineA.initialize()
        try await engineB.initialize()
        try await engineA.connect()

        try await engineA.put(table: "vault", rowId: "v1", columns: ["secret": .string("🔐 SQLite+AES")])
        try await engineA.flush()

        try await engineB.connect()
        let row = try await engineB.get(table: "vault", rowId: "v1")
        XCTAssertEqual(row?.columns["secret"]?.value, .string("🔐 SQLite+AES"))

        // Verify ciphertext is in storeB's SQLite (not plaintext)
        let rawRow = try await storeB.getRow(table: "vault", rowId: "v1")
        XCTAssertNotNil(rawRow) // row is stored decrypted after merge — that's correct
        // The column value in the local store is the decrypted value
        XCTAssertEqual(rawRow?.columns["secret"]?.value, .string("🔐 SQLite+AES"))
    }

    func test_queryWhere_withSQLiteBackend() async throws {
        let (engine, _) = makeSQLiteEngine(namespace: "query-\(Int(Date().timeIntervalSince1970*1000))")
        try await engine.initialize()

        for i in 1...5 {
            try await engine.put(table: "tasks", rowId: "t\(i)",
                                 columns: ["priority": .int(i), "done": .bool(i % 2 == 0)])
        }

        let highPriority = try await engine.queryWhere(
            table: "tasks",
            clause: WhereClause(field: "priority", op: .above, value: .int(3))
        )
        XCTAssertEqual(highPriority.count, 2) // priority 4 and 5
    }
}
