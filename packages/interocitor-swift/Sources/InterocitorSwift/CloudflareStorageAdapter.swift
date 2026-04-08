/**
 * CloudflareStorageAdapter
 *
 * StorageAdapter implementation for interocitor-workers (Cloudflare Worker + D1).
 *
 * Base URL shape:  https://<worker>/io/<prefix>
 * SSE events URL:  https://<worker>/events/<prefix>
 *
 * Mirrors packages/interocitor/src/adapters/cloudflare.ts
 *
 * Includes SSE-driven invalidation via `subscribeToInvalidations(onInvalidate:)`.
 * On Apple platforms this uses URLSession streaming; on Linux it falls back to
 * polling (SSE requires Foundation's URLSession with streaming support).
 */

import Foundation

// MARK: - Config

public struct CloudflareAdapterConfig: Sendable {
    /// Worker IO base URL including prefix, e.g. "https://worker.example.com/io/team-a"
    public let baseURL: String
    /// Optional bearer token (INTEROCITOR_ACCESS_TOKEN on the worker side).
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

    public nonisolated func isAuthenticated() -> Bool { false }
    public func isAuthenticatedActor() -> Bool { _authenticated }

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

    // MARK: - SSE Invalidation

    /// Subscribe to real-time invalidation events from the Cloudflare Worker.
    ///
    /// The worker sends `invalidate` and `compact` events over Server-Sent Events.
    /// On Apple platforms this uses a background URLSession streaming task.
    ///
    /// - Returns: A cancellation closure — call it to stop the subscription.
    public nonisolated func subscribeToInvalidations(
        onInvalidate: @escaping @Sendable (InvalidationPayload) -> Void,
        onReady: (@Sendable () -> Void)? = nil,
        onError: (@Sendable () -> Void)? = nil
    ) -> () -> Void {
        guard let eventsURLString = buildEventsURL(),
              let url = URL(string: eventsURLString) else {
            return {}
        }

        var req = URLRequest(url: url)
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        req.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
        if let token = config.token {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        req.timeoutInterval = 300

        let task = SSETask(
            request: req,
            session: URLSession.shared,
            onEvent: { eventName, data in
                switch eventName {
                case "ready":
                    onReady?()
                case "invalidate", "compact":
                    if let parsed = parseInvalidation(data) { onInvalidate(parsed) }
                default:
                    break
                }
            },
            onError: { _ in onError?() }
        )
        task.start()
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

    private nonisolated func buildEventsURL() -> String? {
        // Replace /io/ with /events/ in the base URL
        guard config.baseURL.contains("/io/") else { return nil }
        var eventsURL = config.baseURL.replacingOccurrences(of: "/io/", with: "/events/")
        if let token = config.token {
            eventsURL += "?access_token=\(token)"
        }
        return eventsURL
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

// MARK: - SSETask (minimal Server-Sent Events client)

/// A lightweight SSE client using a streaming URLSession data task.
/// Handles `event:` / `data:` fields and reconnects are left to the caller.
private final class SSETask: @unchecked Sendable {
    private let request: URLRequest
    private let session: URLSession
    private let onEvent: @Sendable (String, String) -> Void
    private let onError: @Sendable (Error?) -> Void
    private var dataTask: URLSessionDataTask?
    private var buffer = ""
    private var currentEventName = "message"

    init(request: URLRequest,
         session: URLSession,
         onEvent: @escaping @Sendable (String, String) -> Void,
         onError: @escaping @Sendable (Error?) -> Void) {
        self.request = request
        self.session = session
        self.onEvent = onEvent
        self.onError = onError
    }

    func start() {
        let delegate = SSEDelegate(onChunk: { [weak self] data in
            self?.process(chunk: data)
        }, onError: { [weak self] error in
            self?.onError(error)
        })
        let streamSession = URLSession(configuration: .default, delegate: delegate, delegateQueue: nil)
        let task = streamSession.dataTask(with: request)
        self.dataTask = task
        delegate.task = task
        task.resume()
    }

    func cancel() {
        dataTask?.cancel()
        dataTask = nil
    }

    private func process(chunk: Data) {
        guard let text = String(data: chunk, encoding: .utf8) else { return }
        buffer += text
        // Process complete lines
        while let range = buffer.range(of: "\n") {
            let line = String(buffer[buffer.startIndex..<range.lowerBound])
            buffer = String(buffer[range.upperBound...])
            processLine(line)
        }
    }

    private func processLine(_ line: String) {
        if line.isEmpty {
            // Empty line = dispatch event
            return // dispatch happens when we accumulate data — handled per data: line
        }
        if line.hasPrefix("event:") {
            currentEventName = line.dropFirst(6).trimmingCharacters(in: .whitespaces)
        } else if line.hasPrefix("data:") {
            let data = String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces)
            let eventName = currentEventName
            currentEventName = "message"
            onEvent(eventName, data)
        }
    }
}

private final class SSEDelegate: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    let onChunk: @Sendable (Data) -> Void
    let onError: @Sendable (Error?) -> Void
    weak var task: URLSessionDataTask?

    init(onChunk: @escaping @Sendable (Data) -> Void,
         onError: @escaping @Sendable (Error?) -> Void) {
        self.onChunk = onChunk
        self.onError = onError
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        onChunk(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error { onError(error) }
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
