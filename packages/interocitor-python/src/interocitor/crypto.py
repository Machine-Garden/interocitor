"""Portable mesh-key and encrypted-envelope primitives.

The functions in this module deliberately mirror ``@interocitor/core``'s
``crypto/encryption.ts`` wire format.  Envelopes are UTF-8 JSON with standard
base64 fields, not base64url::

    {"v":1,"iv":"<12-byte base64>","ct":"<ciphertext-and-tag base64>"}

Mesh keys are raw AES key bytes in Python.  ``portable_key_to_bytes`` converts
the high-entropy Bitcoin-base58 form used by other Interocitor clients.
"""

from __future__ import annotations

import base64
import json
import os
import re
from dataclasses import dataclass
from typing import Any, Mapping, TypeAlias

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


BytesLike: TypeAlias = bytes | bytearray | memoryview

BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
_BASE58_INDEX = {character: index for index, character in enumerate(BASE58_ALPHABET)}
_AES_KEY_SIZES = frozenset({16, 24, 32})
_IV_LENGTH = 12
_ENVELOPE_VERSION = 1
_ECMASCRIPT_WHITESPACE_RE = re.compile(
    r"[\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+"
)
_ECMASCRIPT_WHITESPACE_CHARS = "\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF"


class CryptoProtocolError(ValueError):
    """Raised when input does not match an Interocitor crypto wire format."""


def _as_bytes(value: BytesLike, *, name: str) -> bytes:
    if not isinstance(value, (bytes, bytearray, memoryview)):
        raise TypeError(f"{name} must be bytes-like")
    return bytes(value)


def ecmascript_trim(value: str) -> str:
    """Apply the whitespace set used by JavaScript ``String.prototype.trim``."""

    if not isinstance(value, str):
        raise TypeError("value must be a string")
    return value.strip(_ECMASCRIPT_WHITESPACE_CHARS)


def text_encode(value: str) -> bytes:
    """Encode text as a browser ``TextEncoder`` does, replacing lone UTF-16 units."""

    if not isinstance(value, str):
        raise TypeError("value must be a string")
    utf16 = value.encode("utf-16-le", errors="surrogatepass")
    return utf16.decode("utf-16-le", errors="replace").encode("utf-8")


def _well_formed_json_text(value: str) -> str:
    """Match well-formed ``JSON.stringify`` for Python strings with surrogates."""

    parts: list[str] = []
    index = 0
    while index < len(value):
        code_point = ord(value[index])
        if 0xD800 <= code_point <= 0xDBFF and index + 1 < len(value):
            following = ord(value[index + 1])
            if 0xDC00 <= following <= 0xDFFF:
                parts.append(chr(0x10000 + ((code_point - 0xD800) << 10) + following - 0xDC00))
                index += 2
                continue
        if 0xD800 <= code_point <= 0xDFFF:
            parts.append(f"\\u{code_point:04x}")
        else:
            parts.append(value[index])
        index += 1
    return "".join(parts)


def _require_aes_key(key: BytesLike) -> bytes:
    raw = _as_bytes(key, name="key")
    if len(raw) not in _AES_KEY_SIZES:
        raise CryptoProtocolError("AES-GCM keys must be 16, 24, or 32 bytes")
    return raw


def _standard_b64encode(value: bytes) -> str:
    return base64.b64encode(value).decode("ascii")


def _standard_b64decode(value: str, *, field: str) -> bytes:
    if not isinstance(value, str):
        raise CryptoProtocolError(f"Encrypted envelope {field} must be a string")
    try:
        return base64.b64decode(value.encode("ascii"), validate=True)
    except (UnicodeEncodeError, ValueError) as error:
        raise CryptoProtocolError(f"Encrypted envelope {field} is not valid base64") from error


def base58_encode(value: BytesLike) -> str:
    """Encode bytes with the Bitcoin base58 alphabet used by portable keys."""

    raw = _as_bytes(value, name="value")
    number = 0
    for byte in raw:
        number = number * 256 + byte

    encoded = ""
    while number:
        number, remainder = divmod(number, 58)
        encoded = BASE58_ALPHABET[remainder] + encoded

    # Match core's leading-zero handling exactly.  For an all-zero key this
    # produces one ``1`` per byte rather than a synthetic numeric digit.
    for byte in raw:
        if byte != 0:
            break
        encoded = "1" + encoded
    return encoded


def base58_decode(value: str) -> bytes:
    """Decode a core portable-key base58 value to its at-least-256-bit bytes.

    ``@interocitor/core`` pads decoded values to 32 bytes before importing them
    as AES key material.  This function intentionally preserves that behavior,
    including decoding ``""`` to 32 zero bytes.  Use
    :func:`portable_key_to_bytes` when the value must be a valid 256-bit mesh
    key.
    """

    if not isinstance(value, str):
        raise TypeError("value must be a string")

    number = 0
    for character in value:
        try:
            digit = _BASE58_INDEX[character]
        except KeyError as error:
            raise CryptoProtocolError(f"Invalid base58 character: {character}") from error
        number = number * 58 + digit

    hexadecimal = format(number, "x").rjust(64, "0")
    # Valid 256-bit portable keys always take the path above with an even
    # number of hex characters.  Reject values outside the portable-key domain
    # rather than silently truncating them.
    if len(hexadecimal) % 2:
        raise CryptoProtocolError("Base58 value exceeds the portable-key size")
    return bytes.fromhex(hexadecimal)


def portable_key_from_bytes(key: BytesLike) -> str:
    """Convert exactly 32 bytes of mesh key material to portable base58."""

    raw = _as_bytes(key, name="key")
    if len(raw) != 32:
        raise CryptoProtocolError("Portable mesh keys must be exactly 32 bytes")
    return base58_encode(raw)


def canonical_portable_key(portable_key: str) -> str:
    """Validate and normalize a portable mesh key suitable for worker config.

    Core accepts surrounding JavaScript whitespace when importing a portable
    key, and older core data can use a noncanonical 43-character spelling for
    a 32-byte value with a leading zero.  Keep that wire compatibility, but
    reject shortened/weak values: the low-level decoder left-pads them to 32
    bytes, which would otherwise turn a blank or mistyped environment value
    into predictable AES key material.
    """

    if not isinstance(portable_key, str):
        raise TypeError("portable_key must be a string")
    normalized = ecmascript_trim(portable_key)
    if not normalized:
        raise CryptoProtocolError("Portable mesh key must not be empty")
    if not 42 <= len(normalized) <= 44:
        raise CryptoProtocolError("Portable mesh keys must use 42 to 44 base58 characters")
    raw = base58_decode(normalized)
    if len(raw) != 32:
        raise CryptoProtocolError("Portable mesh keys must decode to exactly 32 bytes")
    # Reject a value that only appears long because of surplus ``1`` prefix
    # characters.  The canonical re-encoding is still allowed to differ by
    # one leading ``1`` for compatibility with core's historic input form.
    if not 42 <= len(base58_encode(raw)) <= 44:
        raise CryptoProtocolError("Portable mesh key has insufficient key material")
    return normalized


def portable_key_to_bytes(portable_key: str) -> bytes:
    """Convert a validated core portable key to its 32-byte AES-256 material."""

    return base58_decode(canonical_portable_key(portable_key))


def portable_key_to_key(portable_key: str) -> bytes:
    """Alias for :func:`portable_key_to_bytes` for key-source call sites."""

    return portable_key_to_bytes(portable_key)


def key_to_passphrase(key: BytesLike) -> str:
    """Core naming alias for :func:`portable_key_from_bytes`."""

    return portable_key_from_bytes(key)


def passphrase_to_key(passphrase: str) -> bytes:
    """Core naming alias for :func:`portable_key_to_bytes`."""

    return portable_key_to_bytes(passphrase)


def generate_key() -> bytes:
    """Generate a new 256-bit AES-GCM mesh key."""

    return os.urandom(32)


def generate_portable_key() -> str:
    """Generate a new 256-bit mesh key in portable base58 form."""

    return portable_key_from_bytes(generate_key())


@dataclass(frozen=True)
class EncryptedEnvelope:
    """The version-1 JSON envelope shared by all Interocitor clients."""

    v: int
    iv: str
    ct: str

    def to_dict(self) -> dict[str, object]:
        """Return the exact camel-case JSON object written by core."""

        return {"v": self.v, "iv": self.iv, "ct": self.ct}

    def to_json(self) -> str:
        """Serialize with the compact JSON form emitted by ``JSON.stringify``."""

        return _json_stringify(self.to_dict())

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "EncryptedEnvelope":
        if not isinstance(value, Mapping):
            raise CryptoProtocolError("Encrypted envelope must be an object")
        version = value.get("v")
        iv = value.get("iv")
        ciphertext = value.get("ct")
        # JavaScript's strict ``!==`` also distinguishes 1 from 1.0 and true.
        if type(version) is not int or version != _ENVELOPE_VERSION:
            raise CryptoProtocolError(f"Unknown envelope version: {version}")
        if not isinstance(iv, str) or not isinstance(ciphertext, str):
            raise CryptoProtocolError("Encrypted envelope fields must be strings")
        return cls(v=version, iv=iv, ct=ciphertext)

    @classmethod
    def from_json(cls, value: str | BytesLike) -> "EncryptedEnvelope":
        parsed = _json_parse(value, description="Encrypted envelope")
        if not isinstance(parsed, Mapping):
            raise CryptoProtocolError("Encrypted envelope must be an object")
        return cls.from_dict(parsed)


def json_stringify(value: object, *, indent: int | None = None) -> str:
    # JSON.stringify writes compact UTF-8 JSON and does not ASCII-escape normal
    # Unicode. It also emits valid surrogate pairs as scalar Unicode while
    # escaping lone surrogate code units. That matters for encrypted JSON.
    kwargs: dict[str, object] = {"ensure_ascii": False, "allow_nan": False}
    if indent is None:
        kwargs["separators"] = (",", ":")
    else:
        kwargs["indent"] = indent
    return _well_formed_json_text(json.dumps(value, **kwargs))


def _json_stringify(value: object) -> str:
    return json_stringify(value)


def _reject_non_json_constant(value: str) -> None:
    raise ValueError(f"Invalid JSON constant: {value}")


def _json_parse(value: str | BytesLike, *, description: str) -> object:
    if isinstance(value, str):
        text = value
    else:
        raw = _as_bytes(value, name=description)
        # TextDecoder's default mode replaces malformed UTF-8 rather than
        # throwing; JSON parsing then decides whether the resulting text works.
        text = raw.decode("utf-8", errors="replace")
    try:
        return json.loads(text, parse_constant=_reject_non_json_constant)
    except (TypeError, ValueError, json.JSONDecodeError) as error:
        raise CryptoProtocolError(f"Invalid {description}") from error


def encrypt_bytes(key: BytesLike, plaintext: BytesLike) -> bytes:
    """Encrypt bytes into core's UTF-8 JSON AES-GCM envelope."""

    raw_key = _require_aes_key(key)
    raw_plaintext = _as_bytes(plaintext, name="plaintext")
    iv = os.urandom(_IV_LENGTH)
    ciphertext = AESGCM(raw_key).encrypt(iv, raw_plaintext, None)
    envelope = EncryptedEnvelope(
        v=_ENVELOPE_VERSION,
        iv=_standard_b64encode(iv),
        ct=_standard_b64encode(ciphertext),
    )
    return envelope.to_json().encode("utf-8")


def decrypt_bytes(key: BytesLike, envelope: str | BytesLike) -> bytes:
    """Decrypt bytes produced by :func:`encrypt_bytes` or core's equivalent."""

    raw_key = _require_aes_key(key)
    parsed = EncryptedEnvelope.from_json(envelope)
    iv = _standard_b64decode(parsed.iv, field="iv")
    ciphertext = _standard_b64decode(parsed.ct, field="ct")
    if len(iv) != _IV_LENGTH:
        raise CryptoProtocolError("Encrypted envelope IV must be 12 bytes")
    return AESGCM(raw_key).decrypt(iv, ciphertext, None)


def encrypt_entry(key: BytesLike, plaintext: str) -> str:
    """Encrypt a UTF-8 string into a core-compatible JSON envelope string."""

    if not isinstance(plaintext, str):
        raise TypeError("plaintext must be a string")
    return encrypt_bytes(key, text_encode(plaintext)).decode("utf-8")


def decrypt_entry(key: BytesLike, envelope: str | BytesLike) -> str:
    """Decrypt an entry envelope to text using TextDecoder-compatible decoding."""

    return decrypt_bytes(key, envelope).decode("utf-8", errors="replace")
