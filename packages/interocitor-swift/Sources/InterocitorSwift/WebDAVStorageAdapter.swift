/**
 * WebDAVStorageAdapter
 *
 * StorageAdapter implementation for Nextcloud, ownCloud, and any
 * WebDAV-compatible server (including the bundled interocitor-webdav Node server).
 *
 * Mirrors packages/interocitor/src/adapters/webdav.ts
 *
 * Auth: Basic (username + password) or Bearer token.
 * All I/O is via URLSession — no external dependencies.
 */

import Foundation

// MARK: - Config

public struct WebDAVConfig: Sendable {
    public let baseURL: String
    public let auth: WebDAVAuth

    public init(baseURL: String, auth: WebDAVAuth) {
        self.baseURL = baseURL.hasSuffix("/") ? String(baseURL.dropLast()) : baseURL
        self.auth = auth
    }
}

public enum WebDAVAuth: Sendable {
    case basic(username: String, password: String)
    case bearer(token: String)

    var headerValue: String {
        switch self {
        case .basic(let u, let p):
            let credential = Data("\(u):\(p)".utf8).base64EncodedString()
            return "Basic \(credential)"
        case .bearer(let t):
            return "Bearer \(t)"
        }
    }
}

// MARK: - WebDAVStorageAdapter

public actor WebDAVStorageAdapter: StorageAdapter {
    public nonisolated let name = "webdav"

    private let config: WebDAVConfig
    private var _authenticated = false
    private let session: URLSession

    public init(config: WebDAVConfig, session: URLSession = .shared) {
        self.config = config
        self.session = session
    }

    // MARK: - Auth

    public func authenticate() async throws {
        // PROPFIND on the WebDAV server root (scheme+host+port only, path="/")
        // This tests that credentials are valid independently of whether the
        // subpath in baseURL already exists.
        guard let baseComponents = URLComponents(string: config.baseURL),
              var rootComponents = URLComponents(string: config.baseURL) else {
            throw WebDAVError.invalidURL(config.baseURL)
        }
        rootComponents.path = "/"
        rootComponents.query = nil
        guard let rootURL = rootComponents.url else {
            throw WebDAVError.invalidURL(config.baseURL)
        }
        var req = URLRequest(url: rootURL)
        req.httpMethod = "PROPFIND"
        req.addHeaders(auth: config.auth, extra: ["Depth": "0"])

        let (_, response) = try await session.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        switch status {
        case 207, 200...299:
            _authenticated = true
        case 401:
            throw WebDAVError.authFailed
        default:
            throw WebDAVError.httpError(status, "PROPFIND \(baseComponents.host ?? "")")
        }
    }

    public nonisolated func isAuthenticated() -> Bool { false } // actor state; checked lazily
    public func isAuthenticatedActor() -> Bool { _authenticated }

    // MARK: - Folders

    public func ensureFolder(path: String) async throws {
        let parts = path.split(separator: "/", omittingEmptySubsequences: true)
        var current = ""
        for part in parts {
            current += "/\(part)"
            let url = try makeURL(current)
            var req = URLRequest(url: url)
            req.httpMethod = "MKCOL"
            req.addHeaders(auth: config.auth)
            let (_, response) = try await session.data(for: req)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            // Acceptable statuses:
            //   201 — Created (including idempotent re-creation on interocitor-webdav)
            //   405 — Method Not Allowed (Nextcloud: folder already exists)
            //   409 — Conflict (Nextcloud/Apache: parent doesn't exist yet — we walk
            //          from root so this shouldn't happen, but treat as non-fatal)
            //   Any 2xx — success
            if status == 201 || status == 405 || status == 409 || (200...299).contains(status) {
                continue
            }
            throw WebDAVError.httpError(status, "MKCOL \(current)")
        }
    }

    public func listFiles(path: String) async throws -> [FileEntry] {
        let url = try makeURL(path)
        var req = URLRequest(url: url)
        req.httpMethod = "PROPFIND"
        req.addHeaders(auth: config.auth, extra: [
            "Depth": "1",
            "Content-Type": "application/xml",
        ])
        req.httpBody = Data(propfindAllBody.utf8)

        let (data, response) = try await session.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        // 404 on an empty folder is returned by some servers (incl. interocitor-webdav) when
        // the folder has no files — treat as empty listing rather than an error.
        if status == 404 { return [] }
        guard status == 207 else { throw WebDAVError.httpError(status, "PROPFIND \(path)") }
        return parsePropfindFiles(xml: data, basePath: path)
    }

    public func listFolders(path: String) async throws -> [String] {
        let url = try makeURL(path)
        var req = URLRequest(url: url)
        req.httpMethod = "PROPFIND"
        req.addHeaders(auth: config.auth, extra: [
            "Depth": "1",
            "Content-Type": "application/xml",
        ])
        req.httpBody = Data(propfindTypeBody.utf8)

        let (data, response) = try await session.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 207 else { return [] }
        return parsePropfindFolders(xml: data)
    }

    // MARK: - File I/O

    public func readFile(path: String) async throws -> Data {
        let url = try makeURL(path)
        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        req.addHeaders(auth: config.auth)

        let (data, response) = try await session.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200...299).contains(status) else {
            throw WebDAVError.httpError(status, "GET \(path)")
        }
        return data
    }

    public func writeFile(path: String, data: Data) async throws {
        let url = try makeURL(path)
        var req = URLRequest(url: url)
        req.httpMethod = "PUT"
        req.addHeaders(auth: config.auth, extra: ["Content-Type": "application/octet-stream"])
        req.httpBody = data

        let (_, response) = try await session.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status != 201 && status != 204 && !(200...299).contains(status) {
            throw WebDAVError.httpError(status, "PUT \(path)")
        }
    }

    public func deleteFile(path: String) async throws {
        let url = try makeURL(path)
        var req = URLRequest(url: url)
        req.httpMethod = "DELETE"
        req.addHeaders(auth: config.auth)

        let (_, response) = try await session.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        // 204 No Content — success; 404 Not Found — already gone (idempotent)
        // interocitor-webdav returns 404 for missing files; both are acceptable
        if status != 204 && status != 404 && !(200...299).contains(status) {
            throw WebDAVError.httpError(status, "DELETE \(path)")
        }
    }

    public func getFileMetadata(path: String) async throws -> FileEntry? {
        let url = try makeURL(path)
        var req = URLRequest(url: url)
        req.httpMethod = "PROPFIND"
        req.addHeaders(auth: config.auth, extra: [
            "Depth": "0",
            "Content-Type": "application/xml",
        ])
        req.httpBody = Data(propfindAllBody.utf8)

        let (data, response) = try await session.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 404 { return nil }
        guard status == 207 else { return nil }

        // Depth:0 on a file returns one response (itself); parse first entry
        return parsePropfindSingleFile(xml: data, path: path)
    }

    // MARK: - URL building

    private func makeURL(_ path: String) throws -> URL {
        let clean = path.hasPrefix("/") ? path : "/\(path)"
        guard let url = URL(string: config.baseURL + clean) else {
            throw WebDAVError.invalidURL(config.baseURL + clean)
        }
        return url
    }

    // MARK: - XML parsing (manual — no external dependency)

    private func parsePropfindFiles(xml data: Data, basePath: String) -> [FileEntry] {
        let parser = PropfindParser(data: data)
        let responses = parser.parse()
        guard responses.count > 1 else { return [] } // only the folder itself or empty
        var entries: [FileEntry] = []
        // responses[0] is the folder itself (Depth: 1 self-response)
        for response in responses.dropFirst() {
            if response.isCollection { continue }
            // Extract the filename from the href, URL-decoding it
            let rawName = response.href
                .split(separator: "/")
                .last
                .map(String.init) ?? ""
            let name = rawName.removingPercentEncoding ?? rawName
            if name.isEmpty { continue }
            let cleanBase = basePath.hasSuffix("/") ? String(basePath.dropLast()) : basePath
            entries.append(FileEntry(
                name: name,
                path: "\(cleanBase)/\(name)",
                size: response.contentLength,
                modifiedTime: response.lastModified,
                etag: response.etag
            ))
        }
        return entries
    }

    private func parsePropfindFolders(xml data: Data) -> [String] {
        let parser = PropfindParser(data: data)
        let responses = parser.parse()
        guard responses.count > 1 else { return [] }
        var folders: [String] = []
        for response in responses.dropFirst() {
            if !response.isCollection { continue }
            let rawName = response.href
                .split(separator: "/")
                .last
                .map(String.init) ?? ""
            let name = rawName.removingPercentEncoding ?? rawName
            if !name.isEmpty { folders.append(name) }
        }
        return folders
    }

    private func parsePropfindSingleFile(xml data: Data, path: String) -> FileEntry? {
        let parser = PropfindParser(data: data)
        let responses = parser.parse()
        guard let first = responses.first, !first.isCollection else { return nil }
        let rawName = path.split(separator: "/").last.map(String.init) ?? ""
        let name = rawName.removingPercentEncoding ?? rawName
        return FileEntry(
            name: name,
            path: path,
            size: first.contentLength,
            modifiedTime: first.lastModified,
            etag: first.etag
        )
    }
}

// MARK: - PROPFIND XML bodies

private let propfindAllBody = """
<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:getcontentlength/>
    <d:getlastmodified/>
    <d:resourcetype/>
    <d:getetag/>
  </d:prop>
</d:propfind>
"""

private let propfindTypeBody = """
<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:resourcetype/>
  </d:prop>
</d:propfind>
"""

// MARK: - Minimal PROPFIND XML parser (XMLParser delegate)

private struct PropfindResponse {
    var href: String = ""
    var isCollection: Bool = false
    var contentLength: Int = 0
    var lastModified: String = ""
    var etag: String? = nil
}

private class PropfindParser: NSObject, XMLParserDelegate {
    private let data: Data
    private var responses: [PropfindResponse] = []
    private var current: PropfindResponse?
    private var currentText: String = ""
    private var inProp = false

    init(data: Data) { self.data = data }

    func parse() -> [PropfindResponse] {
        let parser = XMLParser(data: data)
        parser.delegate = self
        parser.parse()
        return responses
    }

    func parser(_ parser: XMLParser, didStartElement elementName: String,
                namespaceURI: String?, qualifiedName: String?,
                attributes: [String: String] = [:]) {
        currentText = ""
        let local = elementName.components(separatedBy: ":").last ?? elementName
        switch local {
        case "response": current = PropfindResponse()
        case "collection": current?.isCollection = true
        case "prop": inProp = true
        default: break
        }
    }

    func parser(_ parser: XMLParser, foundCharacters string: String) {
        currentText += string
    }

    func parser(_ parser: XMLParser, didEndElement elementName: String,
                namespaceURI: String?, qualifiedName: String?) {
        let local = elementName.components(separatedBy: ":").last ?? elementName
        switch local {
        case "response":
            if let r = current { responses.append(r) }
            current = nil
        case "href":
            current?.href = currentText.trimmingCharacters(in: .whitespacesAndNewlines)
        case "getcontentlength":
            current?.contentLength = Int(currentText.trimmingCharacters(in: .whitespaces)) ?? 0
        case "getlastmodified":
            let raw = currentText.trimmingCharacters(in: .whitespaces)
            // Convert RFC 1123 → ISO8601 if possible
            if let date = rfc1123Formatter.date(from: raw) {
                current?.lastModified = iso8601Formatter.string(from: date)
            } else {
                current?.lastModified = raw
            }
        case "getetag":
            let e = currentText.trimmingCharacters(in: .whitespaces)
            current?.etag = e.isEmpty ? nil : e
        case "prop": inProp = false
        default: break
        }
        currentText = ""
    }
}

private let rfc1123Formatter: DateFormatter = {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
    return f
}()

private let iso8601Formatter: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    return f
}()

// MARK: - URLRequest helpers

private extension URLRequest {
    mutating func addHeaders(auth: WebDAVAuth, extra: [String: String] = [:]) {
        setValue(auth.headerValue, forHTTPHeaderField: "Authorization")
        for (k, v) in extra { setValue(v, forHTTPHeaderField: k) }
    }
}

// MARK: - WebDAVError

public enum WebDAVError: Error, LocalizedError {
    case authFailed
    case httpError(Int, String)
    case invalidURL(String)

    public var errorDescription: String? {
        switch self {
        case .authFailed:            return "WebDAV authentication failed (401)"
        case .httpError(let s, let op): return "WebDAV \(op) failed: HTTP \(s)"
        case .invalidURL(let u):     return "Invalid WebDAV URL: \(u)"
        }
    }
}
