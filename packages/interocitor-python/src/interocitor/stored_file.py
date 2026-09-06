"""Durable-file framing shared with the TypeScript core.

The remote learns nothing about a durable file beyond the object it stores:
the application path is replaced by a keyed hash under a key derived from
the mesh key, and the content type, plaintext size, and digest travel inside
the stored object, under the mesh key.

A file may additionally be sealed under an extra key: its body is an
AES-GCM envelope under that key, the frame header names the seal with a
human-readable taint, and a guard derived from the seal key accompanies
writes and deletes so a remote that understands guards refuses to replace or
delete the object without it.
"""

from __future__ import annotations

import hashlib
import hmac
import json
from dataclasses import dataclass

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from .crypto import decrypt_bytes, encrypt_bytes

_PATH_INFO = b"interocitor/durable-file-path/v1"
_GUARD_INFO = b"interocitor/durable-file-guard/v1"
_FRAME_VERSION = 1


@dataclass(frozen=True)
class StoredFileHeader:
    """Plaintext-side description of a stored file, kept inside the frame."""

    size: int
    digest: str
    content_type: str | None = None
    taint: str | None = None


@dataclass(frozen=True)
class FileSeal:
    """An extra key a file is sealed under, plus the label the row carries."""

    taint: str
    key: bytes

    def __post_init__(self) -> None:
        if not isinstance(self.taint, str) or not self.taint:
            raise ValueError("A file seal needs a non-empty taint")
        if len(self.key) != 32:
            raise ValueError("A file seal key must be 32 bytes")


def _derive_hmac_key(secret: bytes, info: bytes) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=info).derive(bytes(secret))


def derive_file_path_key(mesh_key: bytes) -> bytes:
    """HKDF-SHA256 of the raw mesh key with a fixed info string."""
    return _derive_hmac_key(mesh_key, _PATH_INFO)


def derive_file_guard(seal_key: bytes, object_name: str) -> str:
    """Lowercase hex HMAC-SHA256 of the stored object name under the seal key.

    Matches ``deriveFileGuard`` in the TypeScript core; the remote stores it
    with the object and demands it again before an overwrite or delete.
    """
    guard_key = _derive_hmac_key(seal_key, _GUARD_INFO)
    return hmac.new(guard_key, object_name.encode("utf-8"), hashlib.sha256).hexdigest()


def seal_stored_body(seal: FileSeal, plaintext: bytes) -> bytes:
    """Wrap a plaintext body in an envelope under the seal key."""
    return encrypt_bytes(seal.key, plaintext)


def open_stored_body(key: bytes, body: bytes) -> bytes:
    """Undo :func:`seal_stored_body`; raises when the key is wrong."""
    return decrypt_bytes(key, body)


def clean_file_path(path: str) -> str:
    if not isinstance(path, str):
        raise TypeError("Stored file path must be a string")
    clean = "/".join(part for part in path.split("/") if part)
    if not clean:
        raise ValueError("Stored object path must not be empty")
    return clean


def hide_file_path(path_key: bytes, path: str) -> str:
    """Lowercase hex HMAC-SHA256 of the cleaned application path."""
    return hmac.new(path_key, clean_file_path(path).encode("utf-8"), hashlib.sha256).hexdigest()


def encode_stored_frame(header: StoredFileHeader, body: bytes) -> bytes:
    """4-byte big-endian header length, UTF-8 JSON header, body."""
    fields: dict[str, object] = {"v": _FRAME_VERSION, "size": header.size, "digest": header.digest}
    if header.content_type is not None:
        fields["contentType"] = header.content_type
    if header.taint is not None:
        fields["taint"] = header.taint
    header_bytes = json.dumps(fields, separators=(",", ":")).encode("utf-8")
    return len(header_bytes).to_bytes(4, "big") + header_bytes + bytes(body)


def decode_stored_frame(frame: bytes) -> tuple[StoredFileHeader, bytes]:
    if len(frame) < 4:
        raise ValueError("Stored file frame is truncated")
    header_length = int.from_bytes(frame[:4], "big")
    if 4 + header_length > len(frame):
        raise ValueError("Stored file frame is truncated")
    parsed = json.loads(frame[4 : 4 + header_length].decode("utf-8"))
    if parsed.get("v") != _FRAME_VERSION:
        raise ValueError(f"Unknown stored file frame version: {parsed.get('v')}")
    header = StoredFileHeader(
        size=int(parsed["size"]),
        digest=str(parsed["digest"]),
        content_type=parsed.get("contentType"),
        taint=parsed.get("taint"),
    )
    return header, bytes(frame[4 + header_length :])
