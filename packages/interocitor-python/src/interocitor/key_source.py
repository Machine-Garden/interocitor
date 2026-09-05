# compass: interocitor.trust.key-sources

"""Client-owned mesh-key sources.

The portable source intentionally keeps no state outside the object.  A caller
can place the portable key in an environment variable, inject it from another
secret provider, or obtain it from a recovery wrapper before constructing the
engine.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from .crypto import canonical_portable_key, generate_portable_key, portable_key_to_bytes


@dataclass(frozen=True)
class MeshKeyContext:
    db_name: str
    remote_path: str | None
    mesh_id: str | None
    device_id: str


@dataclass(frozen=True)
class MeshKeyMaterial:
    encrypted: bool
    key: bytes | None
    portable_key: str | None = None


class MeshKeySource(Protocol):
    async def load(self, context: MeshKeyContext) -> MeshKeyMaterial: ...
    async def persist(self, context: MeshKeyContext, portable_key: str, mesh_id: str | None = None) -> None: ...
    async def clear(self) -> None: ...


class PortablePassphraseKeySource:
    """A full-mesh portable key supplied by the host application.

    This is the Python equivalent of the core portable key source.  It does
    not read ``.env`` files itself: configuration ownership stays with the
    application importing Interocitor.
    """

    def __init__(self, *, portable_key: str | None = None, generate_if_missing: bool = True) -> None:
        self._portable_key = portable_key
        self._generate_if_missing = generate_if_missing

    def get_portable_key(self) -> str | None:
        return self._portable_key

    def set_portable_key(self, portable_key: str | None) -> None:
        self._portable_key = portable_key

    async def load(self, _context: MeshKeyContext) -> MeshKeyMaterial:
        if self._portable_key is not None:
            portable_key = canonical_portable_key(self._portable_key)
            self._portable_key = portable_key
            return MeshKeyMaterial(True, portable_key_to_bytes(portable_key), portable_key)
        if not self._generate_if_missing:
            return MeshKeyMaterial(False, None, None)
        portable_key = generate_portable_key()
        self._portable_key = portable_key
        return MeshKeyMaterial(True, portable_key_to_bytes(portable_key), portable_key)

    async def persist(self, _context: MeshKeyContext, portable_key: str, _mesh_id: str | None = None) -> None:
        self._portable_key = canonical_portable_key(portable_key)

    async def clear(self) -> None:
        self._portable_key = None
