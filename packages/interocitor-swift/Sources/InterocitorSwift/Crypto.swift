// compass: interocitor.trust.encryption

/**
 * Crypto — AES-256-GCM encryption, key management, and transfer formats
 *
 * The sync actor uses this layer for change and snapshot payloads after an
 * application calls `setEncryptionKey(_:)`. Encryption is opt-in.
 *
 * Key formats:
 *  - Raw 32-byte SymmetricKey
 *  - Base58 passphrase (~43 chars, human-transferable)
 *  - URL fragment (#key=base64url, never hits a server)
 *
 * Wire format (binary envelope):
 *  byte 0       format tag: 0x02 seals the plaintext as given,
 *                           0x03 seals its raw DEFLATE (RFC 1951) form
 *  bytes 1-12   random AES-GCM IV
 *  bytes 13-    AES-GCM ciphertext followed by the 16-byte tag
 *
 * The tag byte is AES-GCM additional data, so relabelling an envelope fails
 * authentication. Writers choose 0x03 whenever it is smaller. Readers also
 * open the legacy JSON form `{"v":1,"iv":"<base64>","ct":"<base64>"}`,
 * recognised by its first byte (`{` or JSON whitespace).
 */

import Foundation
import CryptoKit
import Compression

// MARK: - Constants

private let IV_LENGTH = 12          // 96-bit nonce for AES-GCM
private let TAG_LENGTH = 16
private let PLAIN_FORMAT: UInt8 = 0x02
private let DEFLATE_FORMAT: UInt8 = 0x03
private let MIN_ENVELOPE_LENGTH = 1 + IV_LENGTH + TAG_LENGTH
private let JSON_ENVELOPE_VERSION = 1
private let JSON_ENVELOPE_FIRST_BYTES: Set<UInt8> = [0x7B, 0x20, 0x09, 0x0A, 0x0D]

/// Largest plaintext a compressed envelope may hold. Writers seal anything
/// larger uncompressed, so readers refuse to inflate past it and a hostile key
/// holder cannot exhaust another device's memory.
public let MAX_INFLATED_BYTES = 256 * 1024 * 1024

// MARK: - Raw DEFLATE (COMPRESSION_ZLIB is RFC 1951 without a zlib header)

private func runCompression(
    _ input: Data,
    operation: compression_stream_operation,
    limit: Int
) throws -> Data {
    let stream = UnsafeMutablePointer<compression_stream>.allocate(capacity: 1)
    defer { stream.deallocate() }
    guard compression_stream_init(stream, operation, COMPRESSION_ZLIB) == COMPRESSION_STATUS_OK else {
        throw CryptoError.malformedEnvelope
    }
    defer { compression_stream_destroy(stream) }

    let bufferSize = 64 * 1024
    let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bufferSize)
    defer { buffer.deallocate() }
    var output = Data()

    return try input.withUnsafeBytes { (raw: UnsafeRawBufferPointer) -> Data in
        stream.pointee.src_ptr = raw.bindMemory(to: UInt8.self).baseAddress ?? UnsafePointer(buffer)
        stream.pointee.src_size = raw.count
        let flags = Int32(COMPRESSION_STREAM_FINALIZE.rawValue)
        while true {
            stream.pointee.dst_ptr = buffer
            stream.pointee.dst_size = bufferSize
            let status = compression_stream_process(stream, flags)
            output.append(buffer, count: bufferSize - stream.pointee.dst_size)
            if output.count > limit { throw CryptoError.inflatedTooLarge(limit) }
            switch status {
            case COMPRESSION_STATUS_OK:
                // Input exhausted with no output progress means the stream
                // never reached its final block.
                if stream.pointee.src_size == 0 && stream.pointee.dst_size == bufferSize {
                    throw CryptoError.malformedEnvelope
                }
            case COMPRESSION_STATUS_END:
                if stream.pointee.src_size != 0 { throw CryptoError.malformedEnvelope }
                return output
            default:
                throw CryptoError.malformedEnvelope
            }
        }
    }
}

func deflateRaw(_ data: Data) throws -> Data {
    try runCompression(data, operation: COMPRESSION_STREAM_ENCODE, limit: Int.max)
}

func inflateRaw(_ data: Data) throws -> Data {
    try runCompression(data, operation: COMPRESSION_STREAM_DECODE, limit: MAX_INFLATED_BYTES)
}

// MARK: - EncryptedEnvelope

/// The legacy JSON envelope (version 1). Readers still open it; writers
/// produce the binary envelope.
public struct EncryptedEnvelope: Codable, Sendable {
    public let v: Int       // envelope version
    public let iv: String   // base64-encoded 12-byte nonce
    public let ct: String   // base64-encoded ciphertext + 16-byte GCM tag

    public init(v: Int, iv: String, ct: String) {
        self.v = v; self.iv = iv; self.ct = ct
    }
}

// MARK: - MeshKey (type alias for clarity)

/// A 256-bit AES-GCM symmetric key shared across all mesh devices.
public typealias MeshKey = SymmetricKey

// MARK: - Key generation

/// Generate a new 256-bit AES-GCM mesh key.
public func generateMeshKey() -> MeshKey {
    MeshKey(size: .bits256)
}

// MARK: - Raw export / import

/// Export key to raw 32-byte Data.
public func exportKeyRaw(_ key: MeshKey) -> Data {
    key.withUnsafeBytes { Data($0) }
}

/// Import key from raw 32 bytes.
/// - Throws: `CryptoError.invalidKeySize` if `raw` is not 32 bytes.
public func importKeyRaw(_ raw: Data) throws -> MeshKey {
    guard raw.count == 32 else { throw CryptoError.invalidKeySize(raw.count) }
    return MeshKey(data: raw)
}

// MARK: - Base58 (Bitcoin alphabet)

private let BASE58_ALPHABET = Array("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz")

/// Encode bytes to a Base58 string (Bitcoin alphabet).
/// Uses a proven digit-array algorithm identical to the TypeScript reference.
public func base58Encode(_ bytes: Data) -> String {
    // digits[i] is in base-58, little-endian
    var digits = [Int](repeating: 0, count: 1)
    for byte in bytes {
        var carry = Int(byte)
        for i in 0..<digits.count {
            carry += digits[i] * 256
            digits[i] = carry % 58
            carry /= 58
        }
        while carry > 0 {
            digits.append(carry % 58)
            carry /= 58
        }
    }
    var result = ""
    for byte in bytes { if byte == 0 { result += "1" } else { break } }
    for d in digits.reversed() { result.append(BASE58_ALPHABET[d]) }
    return result
}

/// Decode a Base58 string back to bytes (exactly 32 bytes for a 256-bit key).
/// - Throws: `CryptoError.invalidBase58Character` on bad input.
public func base58Decode(_ str: String) throws -> Data {
    var bytes = [Int](repeating: 0, count: 1)
    for ch in str {
        guard let idx = BASE58_ALPHABET.firstIndex(of: ch) else {
            throw CryptoError.invalidBase58Character(ch)
        }
        var carry = idx
        for i in 0..<bytes.count {
            carry += bytes[i] * 58
            bytes[i] = carry % 256
            carry /= 256
        }
        while carry > 0 {
            bytes.append(carry % 256)
            carry /= 256
        }
    }
    var result = Data()
    for ch in str { if ch == "1" { result.append(0) } else { break } }
    for b in bytes.reversed() { result.append(UInt8(b)) }
    // Pad or trim to exactly 32 bytes for a 256-bit key
    if result.count < 32 {
        result = Data(repeating: 0, count: 32 - result.count) + result
    } else if result.count > 32 {
        result = result.suffix(32)
    }
    return result
}

// MARK: - Human-transferable formats

/// Export a mesh key as a Base58 passphrase (~43 chars, copy-pasteable).
public func keyToPassphrase(_ key: MeshKey) -> String {
    base58Encode(exportKeyRaw(key))
}

/// Import a mesh key from a Base58 passphrase (produced by `keyToPassphrase`).
/// - Throws: `CryptoError.invalidBase58Character` for bad input.
public func passphraseToKey(_ passphrase: String) throws -> MeshKey {
    let raw = try base58Decode(passphrase.trimmingCharacters(in: .whitespaces))
    return try importKeyRaw(raw)
}

/// Build a share URL with the key embedded in the fragment (`#key=<base64url>`).
/// The key never reaches any server.
public func keyToShareURL(_ key: MeshKey, baseURL: String) -> String {
    let raw = exportKeyRaw(key)
    let b64url = raw.base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
    return "\(baseURL)#key=\(b64url)"
}

/// Extract raw key bytes from a URL fragment produced by `keyToShareURL`.
public func keyFromFragment(_ fragment: String) -> Data? {
    guard let match = fragment.range(of: "key=([A-Za-z0-9_-]+)", options: .regularExpression) else {
        return nil
    }
    let b64url = String(fragment[match]).dropFirst(4)
    var b64 = b64url
        .replacingOccurrences(of: "-", with: "+")
        .replacingOccurrences(of: "_", with: "/")
    let pad = (4 - b64.count % 4) % 4
    b64 += String(repeating: "=", count: pad)
    return Data(base64Encoded: b64)
}

// MARK: - Encrypt / Decrypt entries

/// Encrypt a plaintext string to a binary envelope.
/// Each call uses a freshly generated 96-bit random IV. The plaintext is
/// compressed first whenever that makes it smaller.
public func encryptEntry(_ key: MeshKey, plaintext: String) throws -> Data {
    try encryptBytes(key, plaintext: Data(plaintext.utf8))
}

/// Encrypt bytes to a binary envelope.
public func encryptBytes(_ key: MeshKey, plaintext data: Data) throws -> Data {
    var ivBytes = [UInt8](repeating: 0, count: IV_LENGTH)
    guard SecRandomCopyBytes(kSecRandomDefault, IV_LENGTH, &ivBytes) == errSecSuccess else {
        throw CryptoError.randomGenerationFailed
    }
    let iv = Data(ivBytes)
    let compressed = data.count <= MAX_INFLATED_BYTES ? try deflateRaw(data) : nil
    let format: UInt8
    let body: Data
    if let compressed, compressed.count < data.count {
        format = DEFLATE_FORMAT
        body = compressed
    } else {
        format = PLAIN_FORMAT
        body = data
    }
    let sealed = try AES.GCM.seal(
        body, using: key, nonce: try AES.GCM.Nonce(data: iv), authenticating: Data([format])
    )
    var out = Data(capacity: MIN_ENVELOPE_LENGTH + body.count)
    out.append(format)
    out.append(iv)
    out.append(sealed.ciphertext)
    out.append(sealed.tag)
    return out
}

/// Decrypt an envelope back to a plaintext string.
/// - Throws: `CryptoError.unknownEnvelopeFormat`, `CryptoError.unknownEnvelopeVersion`,
///           `CryptoError.malformedEnvelope`, or a CryptoKit authentication error.
public func decryptEntry(_ key: MeshKey, envelope: Data) throws -> String {
    let plainData = try decryptBytes(key, envelope: envelope)
    guard let plaintext = String(data: plainData, encoding: .utf8) else {
        throw CryptoError.malformedEnvelope
    }
    return plaintext
}

/// Decrypt an envelope produced by any Interocitor client.
public func decryptBytes(_ key: MeshKey, envelope data: Data) throws -> Data {
    let bytes = Data(data) // rebase indices to 0
    guard let first = bytes.first else { throw CryptoError.malformedEnvelope }
    if JSON_ENVELOPE_FIRST_BYTES.contains(first) { return try openJsonEnvelope(key, bytes) }
    guard first == PLAIN_FORMAT || first == DEFLATE_FORMAT else {
        throw CryptoError.unknownEnvelopeFormat(first)
    }
    guard bytes.count >= MIN_ENVELOPE_LENGTH else { throw CryptoError.malformedEnvelope }
    let sealed = try AES.GCM.SealedBox(
        nonce: try AES.GCM.Nonce(data: bytes[1..<(1 + IV_LENGTH)]),
        ciphertext: bytes[(1 + IV_LENGTH)..<(bytes.count - TAG_LENGTH)],
        tag: bytes.suffix(TAG_LENGTH)
    )
    let body = try AES.GCM.open(sealed, using: key, authenticating: Data([first]))
    return first == DEFLATE_FORMAT ? try inflateRaw(body) : body
}

private func openJsonEnvelope(_ key: MeshKey, _ data: Data) throws -> Data {
    guard let envelope = try? JSONDecoder().decode(EncryptedEnvelope.self, from: data) else {
        throw CryptoError.malformedEnvelope
    }
    guard envelope.v == JSON_ENVELOPE_VERSION else {
        throw CryptoError.unknownEnvelopeVersion(envelope.v)
    }
    guard let ivData = Data(base64Encoded: envelope.iv),
          let ctData = Data(base64Encoded: envelope.ct),
          ctData.count >= TAG_LENGTH else {
        throw CryptoError.malformedEnvelope
    }
    let sealed = try AES.GCM.SealedBox(
        nonce: try AES.GCM.Nonce(data: ivData),
        ciphertext: ctData.dropLast(TAG_LENGTH),
        tag: ctData.suffix(TAG_LENGTH)
    )
    return try AES.GCM.open(sealed, using: key)
}

/// Try to decrypt; returns nil instead of throwing.
public func tryDecryptEntry(_ key: MeshKey, envelope: Data) -> String? {
    try? decryptEntry(key, envelope: envelope)
}

/// Verify that a key can decrypt a known ciphertext (sanity-check on mesh join).
public func verifyKey(_ key: MeshKey, sampleEncrypted: Data) -> Bool {
    (try? decryptEntry(key, envelope: sampleEncrypted)) != nil
}

// MARK: - Key persistence (Keychain)

private let KEYCHAIN_SERVICE = "interocitor"
private let KEYCHAIN_ACCOUNT = "mesh-key"

/// Persist the mesh key in the Keychain (replaces any previously stored key).
public func storeKeyInKeychain(_ key: MeshKey) throws {
    let raw = exportKeyRaw(key)
    let query: [String: Any] = [
        kSecClass as String:       kSecClassGenericPassword,
        kSecAttrService as String: KEYCHAIN_SERVICE,
        kSecAttrAccount as String: KEYCHAIN_ACCOUNT,
        kSecValueData as String:   raw,
    ]
    SecItemDelete(query as CFDictionary)
    let status = SecItemAdd(query as CFDictionary, nil)
    guard status == errSecSuccess else { throw CryptoError.keychainError(status) }
}

/// Load the mesh key from the Keychain. Returns nil if not found.
public func loadKeyFromKeychain() throws -> MeshKey? {
    let query: [String: Any] = [
        kSecClass as String:            kSecClassGenericPassword,
        kSecAttrService as String:      KEYCHAIN_SERVICE,
        kSecAttrAccount as String:      KEYCHAIN_ACCOUNT,
        kSecReturnData as String:       true,
        kSecMatchLimit as String:       kSecMatchLimitOne,
    ]
    var result: AnyObject?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = result as? Data else {
        throw CryptoError.keychainError(status)
    }
    return try importKeyRaw(data)
}

/// Remove the stored mesh key from the Keychain.
public func clearKeyFromKeychain() {
    let query: [String: Any] = [
        kSecClass as String:       kSecClassGenericPassword,
        kSecAttrService as String: KEYCHAIN_SERVICE,
        kSecAttrAccount as String: KEYCHAIN_ACCOUNT,
    ]
    SecItemDelete(query as CFDictionary)
}

// MARK: - CryptoError

public enum CryptoError: Error, LocalizedError {
    case invalidKeySize(Int)
    case invalidBase58Character(Character)
    case randomGenerationFailed
    case malformedEnvelope
    case unknownEnvelopeVersion(Int)
    case unknownEnvelopeFormat(UInt8)
    case inflatedTooLarge(Int)
    case decryptionFailed
    case keychainError(OSStatus)

    public var errorDescription: String? {
        switch self {
        case .invalidKeySize(let n):          return "Invalid key size: \(n) bytes (expected 32)"
        case .invalidBase58Character(let c):  return "Invalid Base58 character: '\(c)'"
        case .randomGenerationFailed:         return "Failed to generate random bytes"
        case .malformedEnvelope:              return "Malformed encrypted envelope"
        case .unknownEnvelopeVersion(let v):  return "Unknown envelope version: \(v)"
        case .unknownEnvelopeFormat(let f):   return String(format: "Unknown envelope format: 0x%02x", f)
        case .inflatedTooLarge(let limit):    return "Compressed payload inflates past \(limit) bytes"
        case .decryptionFailed:               return "Decryption failed (wrong key or corrupted data)"
        case .keychainError(let s):           return "Keychain error: \(s)"
        }
    }
}
