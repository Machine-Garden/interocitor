// compass: interocitor.mailbox-sync.storage-adapters

/**
 * CloudflareStorageAdapter
 *
 * StorageAdapter implementation for interocitor-workers (Cloudflare Worker + D1).
 *
 * Base URL shape:  https://<worker>/io/<address>
 * WebSocket URL:   wss://<worker>/notify/<address>
 *
 * Includes WebSocket-driven invalidation via `subscribeToInvalidations(onInvalidate:)`
 * using URLSessionWebSocketTask with exponential-backoff reconnection.
 */

import Foundation

// MARK: - Config

public struct CloudflareAdapterConfig: Sendable {
    /// Worker IO base URL including a mesh address, e.g. "https://worker.example.com/io/main"
    public let baseURL: String
    /// Optional bearer token forwarded to the host Worker's mesh middleware.
    public let token: String?

    public init(baseURL: String, token: String? = nil) {
        self.baseURL = baseURL.hasSuffix("/") ? String(baseURL.dropLast()) : baseURL
        self.token = token
    }
}

// MARK: - Invalidation payload

public struct InvalidationPayload: Sendable {
    public let type: String
    public let path: String
    public let ts: Int
}

// MARK: - CloudflareStorageAdapter

public actor CloudflareStorageAdapter: StorageAdapter {
    public nonisolated let name = "cloudflare"

    private let config: CloudflareAdapterConfig
    private var _authenticated = false
    private let session: URLSession
    private let decoder = JSONDecoder()

    public init(config: CloudflareAdapterConfig, session: URLSession = .shared) {
        self.config = config
        self.session = session
    }

    // MARK: - Auth

    public func authenticate() async throws {
        let url = try ioURL("/health")
        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        addHeaders(to: &req)

        let (_, response) = try await session.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        switch status {
        case 200...299:
            _authenticated = true
        case 401, 403:
            throw CloudflareError.authFailed
        default:
            throw CloudflareError.httpError(status, "GET /health")
        }
    }

    public func isAuthenticated() async -> Bool { _authenticated }

    // MARK: - Folders

    public func ensureFolder(path: String) async throws {
        let url = try ioURL("/ensure-folder")
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        addHeaders(to: &req, contentType: "application/json; charset=utf-8")
        req.httpBody = try JSONEncoder().encode(["path": path])

        let (_, response) = try await session.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status != 405 && !(200...299).contains(status) {
            throw CloudflareError.httpError(status, "POST /ensure-folder")
        }
    }

    public func listFiles(path: String) async throws -> [FileEntry] {
        let url = try ioURL("/list-files")
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        addHeaders(to: &req, contentType: "application/json; charset=utf-8")
        req.httpBody = try JSONEncoder().encode(["path": path])

        let (data, response) = try await session.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200...299).contains(status) else {
            throw CloudflareError.httpError(status, "POST /list-files")
        }
        struct Payload: Decodable { var files: [IoFileMeta]? }
        let payload = (try? decoder.decode(Payload.self, from: data)) ?? Payload(files: nil)
        return (payload.files ?? []).map(\.asFileEntry)
    }

    public func listFolders(path: String) async throws -> [String] {
        let url = try ioURL("/list-folders")
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        addHeaders(to: &req, contentType: "application/json; charset=utf-8")
        req.httpBody = try JSONEncoder().encode(["path": path])

        let (data, response) = try await session.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200...299).contains(status) else { return [] }
        struct Payload: Decodable { var folders: [String]? }
        return (try? decoder.decode(Payload.self, from: data))?.folders ?? []
    }

    // MARK: - File I/O

    public func readFile(path: String) async throws -> Data {
        let url = try fileURL(path)
        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        addHeaders(to: &req)

        let (data, response) = try await session.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200...299).contains(status) else {
            throw CloudflareError.httpError(status, "GET file \(path)")
        }
        return data
    }

    public func writeFile(path: String, data: Data) async throws {
        let url = try fileURL(path)
        var req = URLRequest(url: url)
        req.httpMethod = "PUT"
        addHeaders(to: &req, contentType: "application/octet-stream")
        req.httpBody = data

        let (_, response) = try await session.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status != 201 && status != 204 && !(200...299).contains(status) {
            throw CloudflareError.httpError(status, "PUT file \(path)")
        }
    }

    public func deleteFile(path: String) async throws {
        let url = try fileURL(path)
        var req = URLRequest(url: url)
        req.httpMethod = "DELETE"
        addHeaders(to: &req)

        let (_, response) = try await session.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status != 404 && status != 405 && !(200...299).contains(status) {
            throw CloudflareError.httpError(status, "DELETE file \(path)")
        }
    }

    public func getFileMetadata(path: String) async throws -> FileEntry? {
        let url = try ioURL("/metadata")
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        addHeaders(to: &req, contentType: "application/json; charset=utf-8")
        req.httpBody = try JSONEncoder().encode(["path": path])

        let (data, response) = try await session.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 404 { return nil }
        guard (200...299).contains(status) else { return nil }
        struct Payload: Decodable { var file: IoFileMeta? }
        return (try? decoder.decode(Payload.self, from: data))?.file?.asFileEntry
    }

    // MARK: - WebSocket Invalidation

    /// Subscribe to real-time invalidation events from the Cloudflare Worker.
    ///
    /// Opens a WebSocket to `wss://<worker>/notify/<address>` and calls `onInvalidate`
    /// for each invalidation message. Reconnects with exponential backoff on close/error.
    ///
    /// - Returns: A cancellation closure — call it to stop the subscription.
    public nonisolated func subscribeToInvalidations(
        onInvalidate: @escaping @Sendable (InvalidationPayload) -> Void,
        onReady: (@Sendable () -> Void)? = nil,
        onError: (@Sendable () -> Void)? = nil
    ) -> () -> Void {
        guard let wsURL = buildWebSocketURL() else { return {} }

        let task = WSTask(
            url: wsURL,
            token: config.token,
            onInvalidate: onInvalidate,
            onReady: onReady,
            onError: onError
        )
        task.connect()
        return { task.cancel() }
    }

    // MARK: - URL helpers

    private func ioURL(_ path: String) throws -> URL {
        guard let u = URL(string: "\(config.baseURL)\(path)") else {
            throw CloudflareError.invalidURL("\(config.baseURL)\(path)")
        }
        return u
    }

    private func fileURL(_ path: String) throws -> URL {
        guard var comps = URLComponents(string: "\(config.baseURL)/file") else {
            throw CloudflareError.invalidURL(path)
        }
        comps.queryItems = [URLQueryItem(name: "path", value: path)]
        guard let u = comps.url else { throw CloudflareError.invalidURL(path) }
        return u
    }

    private nonisolated func buildWebSocketURL() -> URL? {
        guard config.baseURL.contains("/io/") else { return nil }
        var wsURLString = config.baseURL.replacingOccurrences(of: "/io/", with: "/notify/")
        // http -> ws, https -> wss
        if wsURLString.hasPrefix("https://") {
            wsURLString = "wss://" + wsURLString.dropFirst("https://".count)
        } else if wsURLString.hasPrefix("http://") {
            wsURLString = "ws://" + wsURLString.dropFirst("http://".count)
        }
        if let token = config.token,
           var comps = URLComponents(string: wsURLString) {
            comps.queryItems = [URLQueryItem(name: "access_token", value: token)]
            return comps.url
        }
        return URL(string: wsURLString)
    }

    private func addHeaders(to req: inout URLRequest, contentType: String? = nil) {
        if let token = config.token {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let ct = contentType {
            req.setValue(ct, forHTTPHeaderField: "Content-Type")
        }
    }
}

// MARK: - Internal types

private struct IoFileMeta: Decodable {
    var name: String
    var path: String
    var size: Int
    var modifiedTime: String
    var etag: String?

    var asFileEntry: FileEntry {
        FileEntry(name: name, path: path, size: size, modifiedTime: modifiedTime, etag: etag)
    }
}

private func parseInvalidation(_ data: String) -> InvalidationPayload? {
    guard let jsonData = data.data(using: .utf8),
          let dict = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any] else {
        return nil
    }
    return InvalidationPayload(
        type: dict["type"] as? String ?? "unknown",
        path: dict["path"] as? String ?? "/",
        ts: dict["ts"] as? Int ?? 0
    )
}

// MARK: - WSTask (WebSocket client with exponential-backoff reconnection)

/// Connects to the relay WebSocket, dispatches invalidation messages, and
/// reconnects automatically with exponential backoff on close or error.
private final class WSTask: @unchecked Sendable {
    private let url: URL
    private let token: String?
    private let onInvalidate: @Sendable (InvalidationPayload) -> Void
    private let onReady: (@Sendable () -> Void)?
    private let onError: (@Sendable () -> Void)?

    private var wsTask: URLSessionWebSocketTask?
    private var cancelled = false
    private var backoffMs: UInt64 = 1_000
    private let maxBackoffMs: UInt64 = 30_000
    private let session: URLSession

    init(url: URL,
         token: String?,
         onInvalidate: @escaping @Sendable (InvalidationPayload) -> Void,
         onReady: (@Sendable () -> Void)?,
         onError: (@Sendable () -> Void)?) {
        self.url = url
        self.token = token
        self.onInvalidate = onInvalidate
        self.onReady = onReady
        self.onError = onError
        self.session = URLSession(configuration: .default)
    }

    func connect() {
        guard !cancelled else { return }
        var req = URLRequest(url: url)
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let task = session.webSocketTask(with: req)
        wsTask = task
        task.resume()
        onReady?()
        receiveLoop(task: task)
    }

    func cancel() {
        cancelled = true
        wsTask?.cancel(with: .goingAway, reason: nil)
        wsTask = nil
    }

    private func receiveLoop(task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            guard let self, !self.cancelled else { return }
            switch result {
            case .success(let message):
                self.handle(message: message)
                self.receiveLoop(task: task)
            case .failure:
                self.onError?()
                self.scheduleReconnect()
            }
        }
    }

    private func handle(message: URLSessionWebSocketTask.Message) {
        let text: String
        switch message {
        case .string(let s): text = s
        case .data(let d):   text = String(data: d, encoding: .utf8) ?? ""
        @unknown default:    return
        }
        if let payload = parseInvalidation(text) {
            onInvalidate(payload)
        }
    }

    private func scheduleReconnect() {
        guard !cancelled else { return }
        let delay = backoffMs
        backoffMs = min(backoffMs * 2, maxBackoffMs)
        Task {
            try? await Task.sleep(nanoseconds: delay * 1_000_000)
            guard !self.cancelled else { return }
            self.backoffMs = 1_000  // reset after successful reconnect attempt
            self.connect()
        }
    }
}

// MARK: - CloudflareError

public enum CloudflareError: Error, LocalizedError {
    case authFailed
    case httpError(Int, String)
    case invalidURL(String)

    public var errorDescription: String? {
        switch self {
        case .authFailed:                return "Cloudflare Worker auth failed — check access token"
        case .httpError(let s, let op): return "Cloudflare \(op) HTTP \(s)"
        case .invalidURL(let u):         return "Invalid Cloudflare URL: \(u)"
        }
    }
}
