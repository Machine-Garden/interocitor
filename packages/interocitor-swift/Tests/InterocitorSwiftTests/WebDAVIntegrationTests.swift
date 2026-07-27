/**
 * WebDAV Integration Tests
 *
 * These tests run against the repository's live WebDAV Node server
 * (packages/webdav/server.mjs --mode=memory).
 *
 * Skip when the server is not available (CI without Node, offline, etc.)
 * by setting the env var:
 *
 *   INTEROCITOR_WEBDAV_URL=http://127.0.0.1:4174
 *
 * The companion script `Scripts/run-integration-tests.sh` starts the
 * server, exports that variable, and tears it down afterwards.
 */

import XCTest
@testable import InterocitorSwift

// MARK: - Helpers

private func webdavURL() -> String? {
    ProcessInfo.processInfo.environment["INTEROCITOR_WEBDAV_URL"]
}

private func skipIfNoServer(file: StaticString = #file, line: UInt = #line) throws {
    try XCTSkipIf(webdavURL() == nil,
        "Set INTEROCITOR_WEBDAV_URL to run WebDAV integration tests")
}

private let WEBDAV_PREFIX = "/__webdav__"

private func makeWebDAVAdapter(subpath: String = "") -> WebDAVStorageAdapter {
    let base = (webdavURL() ?? "http://127.0.0.1:4174") + WEBDAV_PREFIX + subpath
    return WebDAVStorageAdapter(config: WebDAVConfig(
        baseURL: base,
        auth: .basic(username: "test", password: "test")
    ))
}

// MARK: - StorageAdapter Contract (WebDAV)

/// Verifies the StorageAdapter contract against a real WebDAV server.
/// Mirrors webdav.adapter.contract.spec.ts from the TypeScript suite.
final class WebDAVAdapterContractTests: XCTestCase {

    var adapter: WebDAVStorageAdapter!
    var root: String!

    override func setUp() async throws {
        try skipIfNoServer()
        // Each test gets its own isolated root path; adapter uses the plain WebDAV server root.
        // All paths passed to adapter methods below are absolute (starting with /contract-xxx).
        root = "/contract-\(Int(Date().timeIntervalSince1970 * 1000))-\(arc4random() % 9999)"
        adapter = makeWebDAVAdapter()
    }

    // MARK: Authentication

    func test_authenticate_succeedsWithValidCredentials() async throws {
        try skipIfNoServer()
        // Should not throw
        try await adapter.authenticate()
    }

    // MARK: Folders

    func test_ensureFolder_isIdempotent() async throws {
        try skipIfNoServer()
        let path = "\(root!)/folderA"
        try await adapter.ensureFolder(path: path)
        // Second call must not throw
        try await adapter.ensureFolder(path: path)
    }

    func test_ensureFolder_createsNestedPaths() async throws {
        try skipIfNoServer()
        try await adapter.ensureFolder(path: "\(root!)/a/b/c")
        // If it didn't throw we're good
    }

    // MARK: Write / Read

    func test_writeAndReadFile_utf8String() async throws {
        try skipIfNoServer()
        try await adapter.ensureFolder(path: root)
        let path = "\(root!)/hello.txt"
        let payload = Data("hello world 🌍".utf8)
        try await adapter.writeFile(path: path, data: payload)
        let read = try await adapter.readFile(path: path)
        XCTAssertEqual(read, payload)
    }

    func test_writeAndReadFile_binaryData() async throws {
        try skipIfNoServer()
        try await adapter.ensureFolder(path: root)
        let path = "\(root!)/binary.bin"
        let payload = Data((0..<256).map { UInt8($0) })
        try await adapter.writeFile(path: path, data: payload)
        let read = try await adapter.readFile(path: path)
        XCTAssertEqual(read, payload)
    }

    func test_writeFile_overwriteUpdatesContent() async throws {
        try skipIfNoServer()
        try await adapter.ensureFolder(path: root)
        let path = "\(root!)/overwrite.json"
        try await adapter.writeFile(path: path, data: Data("v1".utf8))
        try await adapter.writeFile(path: path, data: Data("v2".utf8))
        let read = try await adapter.readFile(path: path)
        XCTAssertEqual(String(data: read, encoding: .utf8), "v2")
    }

    func test_readFile_missingThrows() async throws {
        try skipIfNoServer()
        try await adapter.ensureFolder(path: root)
        do {
            _ = try await adapter.readFile(path: "\(root!)/missing.json")
            XCTFail("Expected error")
        } catch { /* expected */ }
    }

    // MARK: List

    func test_listFiles_returnsOnlyDirectChildren() async throws {
        try skipIfNoServer()
        try await adapter.ensureFolder(path: "\(root!)/changes")
        let files = ["a.json", "b.json", "c.json"]
        for f in files {
            try await adapter.writeFile(path: "\(root!)/changes/\(f)", data: Data("{}".utf8))
        }
        // Sub-folder should NOT appear
        try await adapter.ensureFolder(path: "\(root!)/changes/sub")
        let listed = try await adapter.listFiles(path: "\(root!)/changes")
        let names = listed.map(\.name).sorted()
        XCTAssertEqual(names, files.sorted())
    }

    func test_listFiles_emptyFolder() async throws {
        try skipIfNoServer()
        try await adapter.ensureFolder(path: "\(root!)/empty")
        let listed = try await adapter.listFiles(path: "\(root!)/empty")
        XCTAssertEqual(listed.count, 0)
    }

    func test_listFiles_includeSizeAndName() async throws {
        try skipIfNoServer()
        try await adapter.ensureFolder(path: "\(root!)/meta")
        let content = Data("hello".utf8)
        try await adapter.writeFile(path: "\(root!)/meta/file.txt", data: content)
        let listed = try await adapter.listFiles(path: "\(root!)/meta")
        XCTAssertEqual(listed.count, 1)
        XCTAssertEqual(listed[0].name, "file.txt")
        XCTAssertEqual(listed[0].size, content.count)
    }

    // MARK: Metadata

    func test_getFileMetadata_existingFile() async throws {
        try skipIfNoServer()
        try await adapter.ensureFolder(path: root)
        let path = "\(root!)/meta.json"
        let data = Data("metadata test".utf8)
        try await adapter.writeFile(path: path, data: data)
        let meta = try await adapter.getFileMetadata(path: path)
        XCTAssertNotNil(meta)
        XCTAssertEqual(meta?.name, "meta.json")
        XCTAssertEqual(meta?.size, data.count)
    }

    func test_getFileMetadata_missingFileReturnsNil() async throws {
        try skipIfNoServer()
        try await adapter.ensureFolder(path: root)
        let meta = try await adapter.getFileMetadata(path: "\(root!)/ghost.json")
        XCTAssertNil(meta)
    }

    // MARK: Delete

    func test_deleteFile_removesFile() async throws {
        try skipIfNoServer()
        try await adapter.ensureFolder(path: root)
        let path = "\(root!)/todelete.txt"
        try await adapter.writeFile(path: path, data: Data("bye".utf8))
        try await adapter.deleteFile(path: path)
        let meta = try await adapter.getFileMetadata(path: path)
        XCTAssertNil(meta)
    }

    func test_deleteFile_missingFileIsIdempotent() async throws {
        try skipIfNoServer()
        try await adapter.ensureFolder(path: root)
        // Must not throw
        try await adapter.deleteFile(path: "\(root!)/nonexistent.json")
    }
}

// MARK: - Interocitor WebDAV Integration

/// End-to-end sync tests using a real WebDAV server + MemoryLocalStore.
/// Mirrors sync-engine.webdav.spec.ts from the TypeScript suite.
final class SyncEngineWebDAVIntegrationTests: XCTestCase {

    var serverBase: String { webdavURL() ?? "http://127.0.0.1:4174" }

    private func makeEngine(namespace: String, key: MeshKey? = nil) -> Interocitor {
        let adapter = WebDAVStorageAdapter(config: WebDAVConfig(
            baseURL: serverBase + WEBDAV_PREFIX,
            auth: .basic(username: "test", password: "test")
        ))
        let cfg = SyncConfig(
            remotePath: "/interocitor-\(namespace)",
            pollInterval: 9999,
            flushDebounce: 0,
            dbName: "webdav-test-\(namespace)"
        )
        let engine = Interocitor(adapter: adapter, config: cfg, localStore: MemoryLocalStore())
        if let key { Task { await engine.setEncryptionKey(key) } }
        return engine
    }

    // MARK: Basic sync

    func test_basicWrite_syncedToSecondDevice() async throws {
        try skipIfNoServer()
        let ns = "basic-\(Int(Date().timeIntervalSince1970 * 1000))"
        let a = makeEngine(namespace: ns)
        let b = makeEngine(namespace: ns)

        try await a.initialize()
        try await a.connect()
        try await a.put(table: "tasks", rowId: "t1", columns: ["title": .string("Hello WebDAV")])
        try await a.flush()

        try await b.initialize()
        try await b.connect()

        let row = try await b.get(table: "tasks", rowId: "t1")
        XCTAssertEqual(row?.columns["title"]?.value, .string("Hello WebDAV"))
    }

    func test_multipleWrites_allSynced() async throws {
        try skipIfNoServer()
        let ns = "multi-\(Int(Date().timeIntervalSince1970 * 1000))"
        let a = makeEngine(namespace: ns)
        let b = makeEngine(namespace: ns)

        try await a.initialize()
        try await a.connect()

        // Flush after each write so each change file gets a distinct HLC
        for i in 1...5 {
            try await a.put(table: "items", rowId: "item_\(i)",
                            columns: ["n": .int(i), "label": .string("Item \(i)")])
            try await a.flush()
        }

        try await b.initialize()
        try await b.connect()
        let rows = try await b.query(table: "items")
        XCTAssertEqual(rows.count, 5)
    }

    func test_delete_syncedToSecondDevice() async throws {
        try skipIfNoServer()
        let ns = "delete-\(Int(Date().timeIntervalSince1970 * 1000))"
        let a = makeEngine(namespace: ns)
        let b = makeEngine(namespace: ns)

        try await a.initialize()
        try await a.connect()
        try await a.put(table: "tasks", rowId: "t1", columns: ["title": .string("Deleteme")])
        try await a.flush()

        try await b.initialize()
        try await b.connect()

        let beforeDelete = try await b.get(table: "tasks", rowId: "t1")
        XCTAssertNotNil(beforeDelete)

        try await a.delete(table: "tasks", rowId: "t1")
        try await a.flush()
        try await b.pull()

        let afterDelete = try await b.get(table: "tasks", rowId: "t1")
        XCTAssertNil(afterDelete)
    }

    // MARK: LWW merge

    func test_concurrentWrite_latestHLCWins() async throws {
        try skipIfNoServer()
        let ns = "lww-\(Int(Date().timeIntervalSince1970 * 1000))"
        let a = makeEngine(namespace: ns)
        let b = makeEngine(namespace: ns)

        try await a.initialize()
        try await b.initialize()
        try await a.connect()
        try await b.connect()

        // A writes first
        try await a.put(table: "notes", rowId: "n1", columns: ["body": .string("from A")])
        try await a.flush()
        // Give B a moment to get a later wall clock
        try await Task.sleep(nanoseconds: 5_000_000) // 5ms
        // B writes the same row later → should win
        try await b.put(table: "notes", rowId: "n1", columns: ["body": .string("from B")])
        try await b.flush()

        try await a.pull()
        let row = try await a.get(table: "notes", rowId: "n1")
        XCTAssertEqual(row?.columns["body"]?.value, .string("from B"))
    }

    // MARK: Encryption over WebDAV

    func test_encryptedSync_plainTextNotVisibleOnServer() async throws {
        try skipIfNoServer()
        let ns = "enc-opacity-\(Int(Date().timeIntervalSince1970 * 1000))"
        let key = generateMeshKey()
        let adapter = WebDAVStorageAdapter(config: WebDAVConfig(
            baseURL: serverBase + WEBDAV_PREFIX,
            auth: .basic(username: "test", password: "test")
        ))
        let cfg = SyncConfig(remotePath: "/interocitor-\(ns)", pollInterval: 9999, flushDebounce: 0)
        let engine = Interocitor(adapter: adapter, config: cfg, localStore: MemoryLocalStore())
        await engine.setEncryptionKey(key)
        try await engine.initialize()
        try await engine.connect()

        let secret = "TOP SECRET \(UUID().uuidString)"
        try await engine.put(table: "vault", rowId: "v1", columns: ["secret": .string(secret)])
        try await engine.flush()

        // Read the raw change file from WebDAV — should NOT contain the plaintext secret
        let files = try await adapter.listFiles(path: "/interocitor-\(ns)/changes")
        let changeFiles = files.filter { $0.name != "head.json" }
        XCTAssertFalse(changeFiles.isEmpty, "Expected at least one change file")

        for file in changeFiles {
            let raw = try await adapter.readFile(path: file.path)
            let rawStr = String(data: raw, encoding: .utf8) ?? ""
            XCTAssertFalse(rawStr.contains(secret),
                "Plaintext secret must not appear in cloud storage")
            // But it should look like an encrypted envelope
            XCTAssertTrue(rawStr.contains("\"v\"") && rawStr.contains("\"iv\"") && rawStr.contains("\"ct\""),
                "Expected encrypted envelope JSON in cloud file")
        }
    }

    func test_encryptedSync_twoDevicesShareKey() async throws {
        try skipIfNoServer()
        let ns = "enc-sync-\(Int(Date().timeIntervalSince1970 * 1000))"
        let key = generateMeshKey()
        let a = makeEngine(namespace: ns, key: key)
        let b = makeEngine(namespace: ns, key: key)
        await a.setEncryptionKey(key)
        await b.setEncryptionKey(key)

        try await a.initialize()
        try await b.initialize()
        try await a.connect()

        try await a.put(table: "notes", rowId: "enc1", columns: ["body": .string("Encrypted over WebDAV")])
        try await a.flush()

        try await b.connect()
        let row = try await b.get(table: "notes", rowId: "enc1")
        XCTAssertEqual(row?.columns["body"]?.value, .string("Encrypted over WebDAV"))
    }

    func test_encryptedSync_wrongKeyCannotRead() async throws {
        try skipIfNoServer()
        let ns = "enc-wrong-\(Int(Date().timeIntervalSince1970 * 1000))"
        let keyA = generateMeshKey()
        let keyB = generateMeshKey()

        let a = makeEngine(namespace: ns)
        await a.setEncryptionKey(keyA)
        let b = makeEngine(namespace: ns)
        await b.setEncryptionKey(keyB)

        try await a.initialize()
        try await b.initialize()
        try await a.connect()
        try await a.put(table: "vault", rowId: "v1", columns: ["secret": .string("shhh")])
        try await a.flush()

        do {
            try await b.connect()
            XCTFail("Expected connect() to reject the encrypted manifest with the wrong key")
        } catch {
            XCTAssertTrue(
                String(describing: error).contains("authenticationFailure")
                    || String(describing: error).contains("Remote poisoned"),
                "Wrong-key rejection should surface as an authentication or poisoned-remote error"
            )
        }
    }

    // MARK: Compaction + rehydration

    func test_compaction_newDeviceRehydratesFromSnapshot() async throws {
        try skipIfNoServer()
        let ns = "compact-\(Int(Date().timeIntervalSince1970 * 1000))"
        let a = makeEngine(namespace: ns)
        let b = makeEngine(namespace: ns)

        try await a.initialize()
        try await a.connect()

        for i in 1...10 {
            try await a.put(table: "tasks", rowId: "t\(i)",
                            columns: ["n": .int(i)])
        }
        try await a.flush()
        try await a.compact()

        try await b.initialize()
        try await b.connect()

        let rows = try await b.query(table: "tasks")
        XCTAssertEqual(rows.count, 10)
    }

    func test_compaction_encryptedSnapshot() async throws {
        try skipIfNoServer()
        let ns = "compact-enc-\(Int(Date().timeIntervalSince1970 * 1000))"
        let key = generateMeshKey()
        let a = makeEngine(namespace: ns, key: key)
        let b = makeEngine(namespace: ns, key: key)
        await a.setEncryptionKey(key)
        await b.setEncryptionKey(key)

        try await a.initialize()
        try await a.connect()
        try await a.put(table: "tasks", rowId: "t1", columns: ["title": .string("Snap me")])
        try await a.flush()
        try await a.compact()

        try await b.initialize()
        try await b.connect()
        let row = try await b.get(table: "tasks", rowId: "t1")
        XCTAssertEqual(row?.columns["title"]?.value, .string("Snap me"))
    }

    // MARK: Offline-then-sync

    func test_offlineWrites_flushedAfterConnect() async throws {
        try skipIfNoServer()
        let ns = "offline-\(Int(Date().timeIntervalSince1970 * 1000))"
        let a = makeEngine(namespace: ns)
        let b = makeEngine(namespace: ns)

        // A writes offline (no connect yet)
        try await a.initialize()
        try await a.put(table: "notes", rowId: "n1", columns: ["body": .string("written offline")])
        try await a.put(table: "notes", rowId: "n2", columns: ["body": .string("also offline")])

        // Now connect — flush should happen automatically
        try await a.connect()
        try await a.flush()

        try await b.initialize()
        try await b.connect()

        let n1 = try await b.get(table: "notes", rowId: "n1")
        let n2 = try await b.get(table: "notes", rowId: "n2")
        XCTAssertEqual(n1?.columns["body"]?.value, .string("written offline"))
        XCTAssertEqual(n2?.columns["body"]?.value, .string("also offline"))
    }

    // MARK: setRemoteStorage swap

    func test_setRemoteStorage_switchAdapter_resumesSync() async throws {
        try skipIfNoServer()
        let ns = "swap-\(Int(Date().timeIntervalSince1970 * 1000))"

        // Start with memory adapter
        let memAdapter = MemoryStorageAdapter()
        let cfg = SyncConfig(remotePath: "/interocitor-\(ns)", pollInterval: 9999, flushDebounce: 0)
        let engine = Interocitor(adapter: memAdapter, config: cfg, localStore: MemoryLocalStore())
        try await engine.initialize()
        try await engine.connect()
        try await engine.put(table: "tasks", rowId: "t1", columns: ["v": .string("original")])
        try await engine.flush()

        // Swap to WebDAV
        let webdavAdapter = WebDAVStorageAdapter(config: WebDAVConfig(
            baseURL: serverBase + WEBDAV_PREFIX,
            auth: .basic(username: "test", password: "test")
        ))
        try await engine.setRemoteStorage(webdavAdapter)

        // The row should still be readable locally
        let row = try await engine.get(table: "tasks", rowId: "t1")
        XCTAssertEqual(row?.columns["v"]?.value, .string("original"))
    }
}
