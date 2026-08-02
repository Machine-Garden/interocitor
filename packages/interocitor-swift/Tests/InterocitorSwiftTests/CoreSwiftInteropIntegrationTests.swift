/**
 * Cross-runtime Core <-> Swift integration coverage.
 *
 * This suite is deliberately opt-in because it needs both a built Node core
 * package and a live loopback WebDAV process. Run it through:
 *
 *   bash Scripts/run-core-swift-interop.sh
 *
 * The shell runner exercises both directions: Core-created mesh → Swift
 * change → Core read → Core snapshot → Swift rehydrate, then Swift-created
 * mesh → Core read → Swift snapshot → Core rehydrate. Keeping the Core
 * process outside XCTest proves the runtimes exchange actual WebDAV
 * artifacts, not a shared in-memory test double.
 */

import XCTest
@testable import InterocitorSwift

private struct CoreSwiftInteropEnvironment {
    let serverURL: String
    let remotePath: String
    let passphrase: String
    let databaseName: String
}

private func coreSwiftInteropEnvironment(
    remotePathVariable: String = "INTEROCITOR_INTEROP_REMOTE_PATH",
    databaseNameVariable: String = "INTEROCITOR_INTEROP_DB_NAME"
) throws -> CoreSwiftInteropEnvironment {
    let environment = ProcessInfo.processInfo.environment
    guard let serverURL = environment["INTEROCITOR_WEBDAV_URL"],
          let remotePath = environment[remotePathVariable],
          let passphrase = environment["INTEROCITOR_INTEROP_PASSPHRASE"],
          let databaseName = environment[databaseNameVariable],
          !serverURL.isEmpty,
          !remotePath.isEmpty,
          !passphrase.isEmpty,
          !databaseName.isEmpty else {
        throw XCTSkip("Run with bash Scripts/run-core-swift-interop.sh")
    }
    return CoreSwiftInteropEnvironment(
        serverURL: serverURL,
        remotePath: remotePath,
        passphrase: passphrase,
        databaseName: databaseName
    )
}

private func swiftBootstrapInteropEnvironment() throws -> CoreSwiftInteropEnvironment {
    try coreSwiftInteropEnvironment(
        remotePathVariable: "INTEROCITOR_INTEROP_SWIFT_REMOTE_PATH",
        databaseNameVariable: "INTEROCITOR_INTEROP_SWIFT_DB_NAME"
    )
}

private func makeCoreInteropEngine(_ environment: CoreSwiftInteropEnvironment) -> Interocitor {
    let baseURL = environment.serverURL.hasSuffix("/__webdav__")
        ? environment.serverURL
        : environment.serverURL + "/__webdav__"
    let adapter = WebDAVStorageAdapter(config: WebDAVConfig(
        baseURL: baseURL,
        auth: .basic(username: "swift-interop", password: "swift-interop")
    ))
    return Interocitor(
        adapter: adapter,
        config: SyncConfig(
            remotePath: environment.remotePath,
            pollInterval: 9_999,
            flushDebounce: 0,
            // The test calls flush() explicitly. Keep the implicit threshold
            // above this one-row write so a background task cannot race test
            // teardown before the Core verification process starts.
            flushThreshold: 100,
            dbName: environment.databaseName
        ),
        localStore: MemoryLocalStore()
    )
}

private func connectCoreInteropEngine(_ environment: CoreSwiftInteropEnvironment) async throws -> Interocitor {
    let db = makeCoreInteropEngine(environment)
    await db.setEncryptionKey(try passphraseToKey(environment.passphrase))
    try await db.initialize()
    try await db.connect()
    return db
}

final class CoreSwiftInteropIntegrationTests: XCTestCase {

    /// Core creates the encrypted manifest and initial row. Swift must decrypt
    /// it, then publish a normal change file that a new Core client can merge.
    func test_coreCreatedEncryptedMesh_canBeReadAndWrittenBySwift() async throws {
        let environment = try coreSwiftInteropEnvironment()
        let db = try await connectCoreInteropEngine(environment)

        let encrypted = await db.isEncrypted()
        XCTAssertTrue(encrypted)
        let coreRow = try await db.get(table: "tasks", rowId: "core-created")
        XCTAssertEqual(coreRow?.columns["origin"]?.value, .string("core"))
        XCTAssertEqual(coreRow?.columns["title"]?.value, .string("Created by @interocitor/core"))
        XCTAssertEqual(coreRow?.columns["done"]?.value, .bool(false))

        try await db.put(
            table: "tasks",
            rowId: "swift-created",
            columns: [
                "origin": .string("swift"),
                "title": .string("Created by InterocitorSwift"),
                "done": .bool(true),
            ]
        )
        try await db.flush()

        let localSwiftRow = try await db.get(table: "tasks", rowId: "swift-created")
        XCTAssertEqual(localSwiftRow?.columns["origin"]?.value, .string("swift"))
        XCTAssertEqual(localSwiftRow?.columns["done"]?.value, .bool(true))
        try await db.disconnect()
    }

    /// The runner asks Core to compact the mixed-runtime mesh before this
    /// fresh Swift client connects. This covers the snapshot row shape as well
    /// as encrypted change-file compatibility.
    func test_coreCompactedSnapshot_canBeRehydratedBySwift() async throws {
        let environment = try coreSwiftInteropEnvironment()
        let db = try await connectCoreInteropEngine(environment)

        let coreRow = try await db.get(table: "tasks", rowId: "core-created")
        let swiftRow = try await db.get(table: "tasks", rowId: "swift-created")
        XCTAssertEqual(coreRow?.columns["origin"]?.value, .string("core"))
        XCTAssertEqual(swiftRow?.columns["origin"]?.value, .string("swift"))
        XCTAssertEqual(swiftRow?.columns["title"]?.value, .string("Created by InterocitorSwift"))
        XCTAssertEqual(swiftRow?.columns["done"]?.value, .bool(true))
        try await db.disconnect()
    }

    /// Swift bootstraps this separate encrypted mesh. A fresh Core process
    /// validates that manifest, decrypts its change, and checks recursive JSON
    /// columns before the next test asks Swift to compact it.
    func test_swiftBootstrappedEncryptedMesh_canBeReadByCore() async throws {
        let environment = try swiftBootstrapInteropEnvironment()
        let db = try await connectCoreInteropEngine(environment)

        let manifest = await db.getManifest()
        XCTAssertTrue(manifest?.encrypted == true)
        XCTAssertTrue(manifest?.contentHash.hasPrefix("sha256:") == true)

        let details: AnyCodable = .object([
            "attempt": .int(3),
            "labels": .array([
                .string("mesh"),
                .object([
                    "retries": .int(2),
                    "enabled": .bool(true),
                ]),
                .null,
            ]),
            "owner": .object([
                "id": .string("worker-7"),
            ]),
        ])
        try await db.put(
            table: "tasks",
            rowId: "swift-bootstrap-nested",
            columns: [
                "origin": .string("swift-bootstrap"),
                "title": .string("Swift bootstrapped encrypted mesh"),
                "details": details,
            ]
        )
        try await db.flush()

        let row = try await db.get(table: "tasks", rowId: "swift-bootstrap-nested")
        XCTAssertEqual(row?.columns["details"]?.value, details)
        try await db.disconnect()
    }

    /// Core first compacts the Swift-created mesh at epoch 1. This fresh Swift
    /// client rehydrates and acknowledges that canonical watermark before it
    /// publishes epoch 2, so its manifest must carry a non-empty GC floor.
    /// A fresh Core client then validates the metadata and rehydrates the
    /// encrypted snapshot in the runner's final phase.
    func test_swiftBootstrappedMesh_canBeCompactedForCore() async throws {
        let environment = try swiftBootstrapInteropEnvironment()
        let db = try await connectCoreInteropEngine(environment)

        let firstManifest = await db.getManifest()
        XCTAssertEqual(firstManifest?.epoch, 1)
        XCTAssertTrue(firstManifest?.gcFloorHlc?.isEmpty ?? true)

        let row = try await db.get(table: "tasks", rowId: "swift-bootstrap-nested")
        XCTAssertEqual(row?.columns["origin"]?.value, .string("swift-bootstrap"))

        try await db.compact()
        let manifest = await db.getManifest()
        XCTAssertEqual(manifest?.epoch, 2)
        XCTAssertFalse(manifest?.snapshotPath?.isEmpty ?? true)
        XCTAssertFalse(manifest?.gcFloorHlc?.isEmpty ?? true)
        XCTAssertEqual(manifest?.gcEpoch, 2)
        XCTAssertFalse(manifest?.gcCreatedAt?.isEmpty ?? true)
        XCTAssertNotNil(manifest?.offlineGraceMs)
        try await db.disconnect()
    }
}
