"""Recovery-wrapper primitives compatible with ``@interocitor/core``.

Recovery phrases derive an opaque locator and an AES-GCM key-encryption key.
The wrapper contains only public KDF parameters and ciphertext; the phrase and
the portable mesh key remain local to the caller.
"""

from __future__ import annotations

import base64
import hmac
import inspect
import json
import os
import re
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timezone
from hashlib import sha256
from typing import Any, Awaitable, Callable, Mapping, Protocol, TypeAlias, runtime_checkable

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

from .crypto import (
    _ECMASCRIPT_WHITESPACE_RE,
    CryptoProtocolError,
    canonical_portable_key,
    ecmascript_trim,
    json_stringify,
    text_encode,
)


BytesLike: TypeAlias = bytes | bytearray | memoryview
RandomBytes: TypeAlias = Callable[[int], bytes]

RECOVERY_ROOT_SALT = b"interocitor.recovery.root.v1"
LOCATOR_INFO = b"interocitor.recovery.locator.v1"
KEK_INFO = b"interocitor.recovery.kek.v1"
ROOT_ITERATIONS = 600_000
RECOVERY_FOLDER = "/.interocitor/recovery"
_LOCATOR_RE = re.compile(r"^[A-Za-z0-9_-]{43}$")


class RecoveryError(ValueError):
    """Raised when a phrase or recovery wrapper cannot be used safely."""


def _reject_non_json_constant(value: str) -> None:
    raise ValueError(f"Invalid JSON constant: {value}")


def _to_base64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _from_base64url(value: str, *, field: str) -> bytes:
    if not isinstance(value, str):
        raise RecoveryError(f"Recovery wrapper {field} must be a string")
    padded = value + "=" * ((4 - len(value) % 4) % 4)
    try:
        # ``validate=True`` keeps malformed lookup capabilities from being
        # silently accepted by Python's otherwise permissive decoder.
        return base64.b64decode(padded.encode("ascii"), altchars=b"-_", validate=True)
    except (UnicodeEncodeError, ValueError) as error:
        raise RecoveryError(f"Recovery wrapper {field} is not valid base64url") from error


def normalize_recovery_phrase(phrase: str) -> str:
    """Apply core's NFKD, trim, and whitespace normalization."""

    if not isinstance(phrase, str):
        raise TypeError("phrase must be a string")
    return ecmascript_trim(_ECMASCRIPT_WHITESPACE_RE.sub(" ", unicodedata.normalize("NFKD", phrase)))


def _require_phrase(phrase: str) -> str:
    normalized = normalize_recovery_phrase(phrase)
    if not normalized:
        raise RecoveryError("Recovery phrase must not be empty")
    return normalized


def _derive_recovery_root(phrase: str) -> bytes:
    return PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=RECOVERY_ROOT_SALT,
        iterations=ROOT_ITERATIONS,
    ).derive(text_encode(_require_phrase(phrase)))


def _derive_locator(root: bytes) -> str:
    return _to_base64url(hmac.new(root, LOCATOR_INFO, sha256).digest())


def _derive_kek(root: bytes, salt: bytes) -> bytes:
    return HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        info=KEK_INFO,
    ).derive(root)


def _wrapper_aad(locator: str, salt: str) -> bytes:
    return f"interocitor.recovery.wrapper.v1|{locator}|{salt}".encode("utf-8")


def recovery_path(locator: str) -> str:
    """Return the generic adapter path used by core for a recovery wrapper."""

    if not _LOCATOR_RE.fullmatch(locator):
        raise RecoveryError("Invalid recovery locator")
    return f"{RECOVERY_FOLDER}/{locator}.json"


@dataclass(frozen=True)
class RecoveredMeshCredentials:
    """Portable mesh credentials recovered from a phrase-protected wrapper."""

    remote_path: str
    portable_key: str
    mesh_id: str | None = None

    def to_dict(self) -> dict[str, str]:
        value: dict[str, str] = {
            "remotePath": self.remote_path,
            "portableKey": self.portable_key,
        }
        if self.mesh_id:
            value["meshId"] = self.mesh_id
        return value

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "RecoveredMeshCredentials":
        if not isinstance(value, Mapping):
            raise RecoveryError("Recovery wrapper contains invalid credentials")
        remote_path = value.get("remotePath", value.get("remote_path"))
        portable_key = value.get("portableKey", value.get("portable_key"))
        mesh_id = value.get("meshId", value.get("mesh_id"))
        if not isinstance(remote_path, str) or not isinstance(portable_key, str):
            raise RecoveryError("Recovery wrapper contains invalid credentials")
        try:
            portable_key = canonical_portable_key(portable_key)
        except (CryptoProtocolError, TypeError) as error:
            raise RecoveryError("Recovery wrapper contains invalid credentials") from error
        return cls(
            remote_path=remote_path,
            portable_key=portable_key,
            mesh_id=mesh_id if isinstance(mesh_id, str) and mesh_id else None,
        )


@dataclass(frozen=True)
class RecoveryKdf:
    """Version-1 public KDF parameters from a recovery wrapper."""

    salt: str
    iterations: int = ROOT_ITERATIONS

    def to_dict(self) -> dict[str, object]:
        return {
            "root": {"name": "PBKDF2-HMAC-SHA-256", "iterations": self.iterations},
            "kek": {"name": "HKDF-SHA-256", "salt": self.salt},
        }

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "RecoveryKdf":
        if not isinstance(value, Mapping):
            raise RecoveryError("Invalid recovery wrapper")
        root = value.get("root")
        kek = value.get("kek")
        if not isinstance(root, Mapping) or not isinstance(kek, Mapping):
            raise RecoveryError("Invalid recovery wrapper")
        iterations = root.get("iterations")
        salt = kek.get("salt")
        if (
            root.get("name") != "PBKDF2-HMAC-SHA-256"
            or type(iterations) is not int
            or iterations != ROOT_ITERATIONS
            or kek.get("name") != "HKDF-SHA-256"
            or not isinstance(salt, str)
        ):
            raise RecoveryError("Invalid recovery wrapper")
        return cls(salt=salt, iterations=iterations)


@dataclass(frozen=True)
class RecoveryWrapper:
    """Version-1 recovery wrapper with camel-case wire serialization helpers."""

    v: int
    alg: str
    kdf: RecoveryKdf
    locator: str
    iv: str
    ciphertext: str
    created_at: str

    def to_dict(self) -> dict[str, object]:
        return {
            "v": self.v,
            "alg": self.alg,
            "kdf": self.kdf.to_dict(),
            "locator": self.locator,
            "iv": self.iv,
            "ciphertext": self.ciphertext,
            "createdAt": self.created_at,
        }

    def to_json(self) -> str:
        return json_stringify(self.to_dict())

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "RecoveryWrapper":
        if not isinstance(value, Mapping):
            raise RecoveryError("Invalid recovery wrapper")
        version = value.get("v")
        alg = value.get("alg")
        locator = value.get("locator")
        iv = value.get("iv")
        ciphertext = value.get("ciphertext")
        created_at = value.get("createdAt", value.get("created_at"))
        if (
            type(version) is not int
            or version != 1
            or alg != "AES-GCM"
            or not isinstance(locator, str)
            or not _LOCATOR_RE.fullmatch(locator)
            or not isinstance(iv, str)
            or not isinstance(ciphertext, str)
            or not isinstance(created_at, str)
        ):
            raise RecoveryError("Invalid recovery wrapper")
        return cls(
            v=version,
            alg=alg,
            kdf=RecoveryKdf.from_dict(value.get("kdf")),
            locator=locator,
            iv=iv,
            ciphertext=ciphertext,
            created_at=created_at,
        )

    @classmethod
    def from_json(cls, value: str | BytesLike) -> "RecoveryWrapper":
        if isinstance(value, str):
            text = value
        elif isinstance(value, (bytes, bytearray, memoryview)):
            text = bytes(value).decode("utf-8", errors="replace")
        else:
            raise TypeError("Recovery wrapper must be text or bytes-like")
        try:
            parsed = json.loads(text, parse_constant=_reject_non_json_constant)
        except (TypeError, ValueError, json.JSONDecodeError) as error:
            raise RecoveryError("Invalid recovery wrapper") from error
        if not isinstance(parsed, Mapping):
            raise RecoveryError("Invalid recovery wrapper")
        return cls.from_dict(parsed)


def _coerce_credentials(
    credentials: RecoveredMeshCredentials | Mapping[str, Any],
) -> RecoveredMeshCredentials:
    if isinstance(credentials, RecoveredMeshCredentials):
        return RecoveredMeshCredentials.from_dict(credentials.to_dict())
    return RecoveredMeshCredentials.from_dict(credentials)


def _coerce_wrapper(wrapper: RecoveryWrapper | Mapping[str, Any]) -> RecoveryWrapper:
    if isinstance(wrapper, RecoveryWrapper):
        # A caller can construct a dataclass directly, so run the wire-format
        # validator here just as core's unwrap function always calls assertWrapper.
        return RecoveryWrapper.from_dict(wrapper.to_dict())
    return RecoveryWrapper.from_dict(wrapper)


def _exact_random_bytes(random_bytes: RandomBytes, length: int) -> bytes:
    value = random_bytes(length)
    if not isinstance(value, (bytes, bytearray, memoryview)):
        raise TypeError("random_bytes must return bytes-like data")
    raw = bytes(value)
    if len(raw) != length:
        raise RecoveryError(f"random_bytes returned {len(raw)} bytes; expected {length}")
    return raw


def _created_at_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def recovery_locator(phrase: str) -> str:
    """Derive the stable opaque locator for a normalized recovery phrase."""

    return _derive_locator(_derive_recovery_root(phrase))


def create_recovery_wrapper(
    phrase: str,
    credentials: RecoveredMeshCredentials | Mapping[str, Any],
    *,
    random_bytes: RandomBytes = os.urandom,
    created_at: str | None = None,
) -> RecoveryWrapper:
    """Encrypt portable mesh credentials under a client-provided phrase.

    ``random_bytes`` and ``created_at`` are injectable to support interoperability
    vectors; production callers should use their secure defaults.
    """

    recovered = _coerce_credentials(credentials)
    if not recovered.remote_path or not recovered.portable_key:
        raise RecoveryError("Recovery credentials require remotePath and portableKey")
    if created_at is not None and not isinstance(created_at, str):
        raise TypeError("created_at must be a string or None")

    root = _derive_recovery_root(phrase)
    locator = _derive_locator(root)
    salt = _exact_random_bytes(random_bytes, 16)
    iv = _exact_random_bytes(random_bytes, 12)
    salt_text = _to_base64url(salt)
    plaintext = json_stringify(recovered.to_dict()).encode("utf-8")
    ciphertext = AESGCM(_derive_kek(root, salt)).encrypt(
        iv,
        plaintext,
        _wrapper_aad(locator, salt_text),
    )
    return RecoveryWrapper(
        v=1,
        alg="AES-GCM",
        kdf=RecoveryKdf(salt=salt_text),
        locator=locator,
        iv=_to_base64url(iv),
        ciphertext=_to_base64url(ciphertext),
        created_at=created_at if created_at is not None else _created_at_now(),
    )


def unwrap_recovery_wrapper(
    phrase: str,
    wrapper: RecoveryWrapper | Mapping[str, Any],
) -> RecoveredMeshCredentials:
    """Validate and decrypt a core-compatible phrase recovery wrapper."""

    parsed = _coerce_wrapper(wrapper)
    root = _derive_recovery_root(phrase)
    locator = _derive_locator(root)
    if not hmac.compare_digest(locator, parsed.locator):
        raise RecoveryError("Recovery phrase does not match this wrapper")

    try:
        salt = _from_base64url(parsed.kdf.salt, field="kdf.kek.salt")
        iv = _from_base64url(parsed.iv, field="iv")
        ciphertext = _from_base64url(parsed.ciphertext, field="ciphertext")
        plaintext = AESGCM(_derive_kek(root, salt)).decrypt(
            iv,
            ciphertext,
            _wrapper_aad(parsed.locator, parsed.kdf.salt),
        )
        value = json.loads(
            plaintext.decode("utf-8", errors="replace"),
            parse_constant=_reject_non_json_constant,
        )
        return RecoveredMeshCredentials.from_dict(value)
    except RecoveryError as error:
        if str(error).startswith("Recovery wrapper contains"):
            raise
        # Match core's intentionally non-specific message for malformed
        # ciphertext, KDF material, or failed GCM authentication.
        raise RecoveryError("Recovery phrase could not unlock this wrapper") from error
    except Exception as error:
        raise RecoveryError("Recovery phrase could not unlock this wrapper") from error


@runtime_checkable
class RecoveryReader(Protocol):
    """The minimal adapter capability used by :func:`recover_mesh_credentials`."""

    def read_recovery_wrapper(self, locator: str) -> Awaitable[BytesLike]:
        """Read a serialized wrapper by its validated opaque locator."""


async def _maybe_await(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value


def _adapter_method(adapter: object, *names: str) -> Callable[..., Any] | None:
    for name in names:
        method = getattr(adapter, name, None)
        if callable(method):
            return method
    return None


async def recover_mesh_credentials(adapter: object, phrase: str) -> RecoveredMeshCredentials:
    """Read, validate, and unlock credentials through an async-capable adapter.

    Python adapters normally expose ``read_recovery_wrapper(locator)``.  The
    camel-case core spelling and the generic ``read_file`` fallback are accepted
    too, which makes this usable with a small storage adapter rather than a
    recovery-specific endpoint.
    """

    locator = recovery_locator(phrase)
    reader = _adapter_method(adapter, "read_recovery_wrapper", "readRecoveryWrapper")
    if reader is not None:
        data = await _maybe_await(reader(locator))
    else:
        read_file = _adapter_method(adapter, "read_file", "readFile")
        if read_file is None:
            raise TypeError("adapter must provide read_recovery_wrapper or read_file")
        data = await _maybe_await(read_file(recovery_path(locator)))

    try:
        wrapper = RecoveryWrapper.from_json(data)
    except (TypeError, RecoveryError) as error:
        raise RecoveryError("Invalid recovery wrapper") from error
    return unwrap_recovery_wrapper(phrase, wrapper)


async def publish_recovery_wrapper(adapter: object, wrapper: RecoveryWrapper | Mapping[str, Any]) -> None:
    """Serialize and write a wrapper through a recovery or generic adapter."""

    parsed = _coerce_wrapper(wrapper)
    data = parsed.to_json().encode("utf-8")
    writer = _adapter_method(adapter, "write_recovery_wrapper", "writeRecoveryWrapper")
    if writer is not None:
        await _maybe_await(writer(parsed.locator, data))
        return

    ensure_folder = _adapter_method(adapter, "ensure_folder", "ensureFolder")
    write_file = _adapter_method(adapter, "write_file", "writeFile")
    if ensure_folder is None or write_file is None:
        raise TypeError("adapter must provide write_recovery_wrapper or ensure_folder and write_file")
    await _maybe_await(ensure_folder(RECOVERY_FOLDER))
    await _maybe_await(write_file(recovery_path(parsed.locator), data))
