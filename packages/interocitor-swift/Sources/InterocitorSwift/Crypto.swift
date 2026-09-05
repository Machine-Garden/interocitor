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
 * Wire format (EncryptedEnvelope):
 *  { "v": 1, "iv": "<base64-12-bytes>", "ct": "<base64-ciphertext+tag>" }
 */

import Foundation
import CryptoKit

// MARK: - Constants

private let IV_LENGTH = 12          // 96-bit nonce for AES-GCM
private let ENVELOPE_VERSION = 1

// MARK: - EncryptedEnvelope

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

/// Encrypt a plaintext string to a JSON envelope string.
/// Each call uses a freshly generated 96-bit random IV.
public func encryptEntry(_ key: MeshKey, plaintext: String) throws -> String {
    let data = Data(plaintext.utf8)
    var ivBytes = [UInt8](repeating: 0, count: IV_LENGTH)
    guard SecRandomCopyBytes(kSecRandomDefault, IV_LENGTH, &ivBytes) == errSecSuccess else {
        throw CryptoError.randomGenerationFailed
    }
    let iv = Data(ivBytes)
    let nonce = try AES.GCM.Nonce(data: iv)
    let sealed = try AES.GCM.seal(data, using: key, nonce: nonce)
    // sealed.ciphertext + sealed.tag is the "ct" field (mirrors TS: ciphertext includes tag)
    let ct = sealed.ciphertext + sealed.tag

    let envelope = EncryptedEnvelope(
        v: ENVELOPE_VERSION,
        iv: iv.base64EncodedString(),
        ct: ct.base64EncodedString()
    )
    return try String(data: JSONEncoder().encode(envelope), encoding: .utf8) ?? "{}"
}

/// Decrypt a JSON envelope string back to plaintext.
/// - Throws: `CryptoError.unknownEnvelopeVersion`, `CryptoError.decryptionFailed`, or
///           `CryptoError.malformedEnvelope` on bad input.
public func decryptEntry(_ key: MeshKey, envelopeStr: String) throws -> String {
    guard let data = envelopeStr.data(using: .utf8),
          let envelope = try? JSONDecoder().decode(EncryptedEnvelope.self, from: data) else {
        throw CryptoError.malformedEnvelope
    }
    guard envelope.v == ENVELOPE_VERSION else {
        throw CryptoError.unknownEnvelopeVersion(envelope.v)
    }
    guard let ivData = Data(base64Encoded: envelope.iv),
          let ctData = Data(base64Encoded: envelope.ct) else {
        throw CryptoError.malformedEnvelope
    }

    let tagSize = 16
    guard ctData.count >= tagSize else { throw CryptoError.malformedEnvelope }
    let ciphertext = ctData.dropLast(tagSize)
    let tag = ctData.suffix(tagSize)

    let nonce = try AES.GCM.Nonce(data: ivData)
    let sealed = try AES.GCM.SealedBox(nonce: nonce, ciphertext: ciphertext, tag: tag)
    let plainData = try AES.GCM.open(sealed, using: key)
    guard let plaintext = String(data: plainData, encoding: .utf8) else {
        throw CryptoError.malformedEnvelope
    }
    return plaintext
}

/// Try to decrypt; returns nil instead of throwing.
public func tryDecryptEntry(_ key: MeshKey, envelopeStr: String) -> String? {
    try? decryptEntry(key, envelopeStr: envelopeStr)
}

/// Verify that a key can decrypt a known ciphertext (sanity-check on mesh join).
public func verifyKey(_ key: MeshKey, sampleEncrypted: String) -> Bool {
    (try? decryptEntry(key, envelopeStr: sampleEncrypted)) != nil
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
    case decryptionFailed
    case keychainError(OSStatus)

    public var errorDescription: String? {
        switch self {
        case .invalidKeySize(let n):          return "Invalid key size: \(n) bytes (expected 32)"
        case .invalidBase58Character(let c):  return "Invalid Base58 character: '\(c)'"
        case .randomGenerationFailed:         return "Failed to generate random bytes"
        case .malformedEnvelope:              return "Malformed encrypted envelope"
        case .unknownEnvelopeVersion(let v):  return "Unknown envelope version: \(v)"
        case .decryptionFailed:               return "Decryption failed (wrong key or corrupted data)"
        case .keychainError(let s):           return "Keychain error: \(s)"
        }
    }
}
