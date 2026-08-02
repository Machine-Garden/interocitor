"""Remote storage adapters used by the Python Interocitor core.

The adapter contract deliberately mirrors ``@interocitor/core``: sync objects
are opaque bytes addressed by path, while durable application files may use a
backend's richer stored-file operations when it provides them.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Protocol
from urllib.parse import urlencode

import httpx


_RECOVERY_LOCATOR_RE = re.compile(r"^[A-Za-z0-9_-]{43}$")


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


@dataclass(frozen=True)
class FileEntry:
    """Metadata returned for an opaque object stored by an adapter."""

    name: str
    path: str
    size: int
    modified_time: str
    etag: str | None = None
    revision: str | None = None

    @classmethod
    def from_wire(cls, value: dict[str, Any]) -> "FileEntry":
        return cls(
            name=str(value["name"]),
            path=str(value["path"]),
            size=int(value["size"]),
            modified_time=str(value["modifiedTime"]),
            etag=value.get("etag"),
            revision=value.get("revision"),
        )

    def to_wire(self) -> dict[str, Any]:
        value: dict[str, Any] = {
            "name": self.name,
            "path": self.path,
            "size": self.size,
            "modifiedTime": self.modified_time,
        }
        if self.etag is not None:
            value["etag"] = self.etag
        if self.revision is not None:
            value["revision"] = self.revision
        return value


@dataclass(frozen=True)
class StoredFileMetadata(FileEntry):
    """Durable-file metadata, including optional Worker-maintained fields."""

    uploaded_by_device_id: str | None = None
    uploaded_at: str | None = None
    last_accessed_at: str | None = None
    use_count: int | None = None
    plaintext_size: int | None = None
    stored_size: int | None = None
    content_type: str | None = None
    taint: str | None = None

    @classmethod
    def from_wire(cls, value: dict[str, Any]) -> "StoredFileMetadata":
        return cls(
            name=str(value["name"]),
            path=str(value["path"]),
            size=int(value["size"]),
            modified_time=str(value["modifiedTime"]),
            etag=value.get("etag"),
            revision=value.get("revision"),
            uploaded_by_device_id=value.get("uploadedByDeviceId"),
            uploaded_at=value.get("uploadedAt"),
            last_accessed_at=value.get("lastAccessedAt"),
            use_count=int(value["useCount"]) if value.get("useCount") is not None else None,
            plaintext_size=int(value["plaintextSize"]) if value.get("plaintextSize") is not None else None,
            stored_size=int(value["storedSize"]) if value.get("storedSize") is not None else None,
            content_type=value.get("contentType"),
            taint=value.get("taint"),
        )

    def to_wire(self) -> dict[str, Any]:
        value = super().to_wire()
        optional = {
            "uploadedByDeviceId": self.uploaded_by_device_id,
            "uploadedAt": self.uploaded_at,
            "lastAccessedAt": self.last_accessed_at,
            "useCount": self.use_count,
            "plaintextSize": self.plaintext_size,
            "storedSize": self.stored_size,
            "contentType": self.content_type,
            "taint": self.taint,
        }
        value.update({key: item for key, item in optional.items() if item is not None})
        return value


class StorageAdapter(Protocol):
    """The byte-oriented remote contract shared with the TypeScript core."""

    name: str

    async def authenticate(self) -> None: ...
    def is_authenticated(self) -> bool: ...
    async def ensure_folder(self, path: str) -> None: ...
    async def list_files(self, path: str) -> list[FileEntry]: ...
    async def list_folders(self, path: str) -> list[str]: ...
    async def read_file(self, path: str) -> bytes: ...
    async def write_file(self, path: str, data: bytes | str) -> None: ...
    async def delete_file(self, path: str) -> None: ...
    async def get_file_metadata(self, path: str) -> FileEntry | None: ...


class MemoryAdapter:
    """Volatile adapter useful for protocol tests and local-only examples."""

    name = "memory"

    def __init__(self) -> None:
        self._files: dict[str, tuple[bytes, str]] = {}
        self._stored: dict[str, StoredFileMetadata] = {}
        self._folders: set[str] = set()
        self._ensured: set[str] = set()
        self._authenticated = False

    async def authenticate(self) -> None:
        self._authenticated = True

    def is_authenticated(self) -> bool:
        return self._authenticated

    async def ensure_folder(self, path: str) -> None:
        if path not in self._ensured:
            self._folders.add(path)
            self._ensured.add(path)

    def reset_folder_cache(self) -> None:
        self._ensured.clear()

    async def list_files(self, folder_path: str) -> list[FileEntry]:
        prefix = folder_path if folder_path.endswith("/") else f"{folder_path}/"
        entries: list[FileEntry] = []
        for path, (data, modified_time) in self._files.items():
            if not path.startswith(prefix):
                continue
            name = path[len(prefix):]
            if "/" not in name:
                entries.append(FileEntry(name, path, len(data), modified_time))
        return entries

    async def list_folders(self, folder_path: str) -> list[str]:
        prefix = folder_path if folder_path.endswith("/") else f"{folder_path}/"
        names: set[str] = set()
        for path in [*self._files, *self._folders]:
            if not path.startswith(prefix):
                continue
            remainder = path[len(prefix):]
            if "/" in remainder:
                names.add(remainder.split("/", 1)[0])
        return sorted(names)

    async def read_file(self, path: str) -> bytes:
        try:
            return self._files[path][0]
        except KeyError as error:
            raise FileNotFoundError(f"Object not found: {path}") from error

    async def write_file(self, path: str, data: bytes | str) -> None:
        bytes_data = data.encode("utf-8") if isinstance(data, str) else bytes(data)
        self._files[path] = (bytes_data, _now())

    async def delete_file(self, path: str) -> None:
        self._files.pop(path, None)
        self._stored.pop(path, None)

    async def get_file_metadata(self, path: str) -> FileEntry | None:
        item = self._files.get(path)
        if item is None:
            return None
        data, modified_time = item
        return FileEntry(path.rsplit("/", 1)[-1], path, len(data), modified_time)

    async def put_stored_file(
        self,
        path: str,
        data: bytes | str,
        *,
        uploaded_by_device_id: str | None = None,
        plaintext_size: int | None = None,
        content_type: str | None = None,
        taint: str | None = None,
    ) -> StoredFileMetadata:
        bytes_data = data.encode("utf-8") if isinstance(data, str) else bytes(data)
        await self.write_file(path, bytes_data)
        now = _now()
        metadata = StoredFileMetadata(
            name=path.rsplit("/", 1)[-1],
            path=path,
            size=len(bytes_data),
            modified_time=now,
            uploaded_by_device_id=uploaded_by_device_id,
            uploaded_at=now,
            use_count=0,
            plaintext_size=plaintext_size,
            stored_size=len(bytes_data),
            content_type=content_type,
            taint=taint,
        )
        self._stored[path] = metadata
        return metadata

    async def get_stored_file(self, path: str) -> bytes:
        data = await self.read_file(path)
        metadata = self._stored.get(path)
        if metadata:
            self._stored[path] = StoredFileMetadata(
                **{**metadata.__dict__, "last_accessed_at": _now(), "use_count": (metadata.use_count or 0) + 1}
            )
        return data

    async def delete_stored_file(self, path: str) -> None:
        await self.delete_file(path)

    async def get_stored_file_metadata(self, path: str) -> StoredFileMetadata | None:
        if path in self._stored:
            return self._stored[path]
        metadata = await self.get_file_metadata(path)
        if metadata is None:
            return None
        return StoredFileMetadata(**metadata.__dict__, stored_size=metadata.size)

    def dump(self) -> dict[str, bytes]:
        """Test helper returning a copy of the remote object namespace."""
        return {path: data for path, (data, _modified) in self._files.items()}


class CloudflareAdapter:
    """Async adapter for the ``@interocitor/workers`` I/O and recovery routes."""

    name = "cloudflare"

    def __init__(
        self,
        *,
        base_url: str,
        token: str | None = None,
        recovery_base_url: str | None = None,
        recovery_token: str | None = None,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        base_url = base_url.rstrip("/")
        if "/io/" not in base_url:
            raise ValueError("CloudflareAdapter base_url must include /io/<address>")
        self.base_url = base_url
        self.token = token
        self.recovery_base_url = recovery_base_url.rstrip("/") if recovery_base_url else None
        self.recovery_token = recovery_token
        self._client = client
        self._owns_client = client is None
        self._authenticated = False
        self._ensured: set[str] = set()

    async def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(follow_redirects=True)
        return self._client

    async def aclose(self) -> None:
        if self._client is not None and self._owns_client:
            await self._client.aclose()
        self._client = None

    def _headers(self, extra: dict[str, str] | None = None) -> dict[str, str]:
        headers: dict[str, str] = {}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        if extra:
            headers.update(extra)
        return headers

    def _recovery_headers(self) -> dict[str, str]:
        token = self.recovery_token if self.recovery_token is not None else self.token
        return {"Authorization": f"Bearer {token}"} if token else {}

    def _io_url(self, suffix: str) -> str:
        return f"{self.base_url}/{suffix.lstrip('/')}"

    def _file_url(self, path: str, *, stored: bool = False) -> str:
        endpoint = "stored-file" if stored else "file"
        return f"{self._io_url(endpoint)}?{urlencode({'path': path})}"

    @staticmethod
    def _raise(response: httpx.Response, operation: str) -> None:
        if not response.is_success:
            raise RuntimeError(f"Cloudflare Worker {operation} failed: HTTP {response.status_code}")

    async def authenticate(self) -> None:
        response = await (await self._http()).get(self._io_url("health"), headers=self._headers())
        self._raise(response, "GET /health")
        self._authenticated = True

    def is_authenticated(self) -> bool:
        return self._authenticated

    async def ensure_folder(self, path: str) -> None:
        if path in self._ensured:
            return
        response = await (await self._http()).post(
            self._io_url("ensure-folder"),
            headers=self._headers({"Content-Type": "application/json; charset=utf-8"}),
            json={"path": path},
        )
        if not response.is_success and response.status_code != 405:
            self._raise(response, "POST /ensure-folder")
        self._ensured.add(path)

    def reset_folder_cache(self) -> None:
        self._ensured.clear()

    async def list_files(self, path: str) -> list[FileEntry]:
        response = await (await self._http()).post(
            self._io_url("list-files"),
            headers=self._headers({"Content-Type": "application/json; charset=utf-8"}),
            json={"path": path},
        )
        self._raise(response, "POST /list-files")
        return [FileEntry.from_wire(item) for item in response.json().get("files", [])]

    async def list_folders(self, path: str) -> list[str]:
        response = await (await self._http()).post(
            self._io_url("list-folders"),
            headers=self._headers({"Content-Type": "application/json; charset=utf-8"}),
            json={"path": path},
        )
        self._raise(response, "POST /list-folders")
        return [str(item) for item in response.json().get("folders", [])]

    async def read_file(self, path: str) -> bytes:
        response = await (await self._http()).get(self._file_url(path), headers=self._headers())
        self._raise(response, f"GET file {path}")
        return response.content

    async def write_file(self, path: str, data: bytes | str) -> None:
        bytes_data = data.encode("utf-8") if isinstance(data, str) else bytes(data)
        response = await (await self._http()).put(
            self._file_url(path), headers=self._headers({"Content-Type": "application/octet-stream"}), content=bytes_data
        )
        self._raise(response, f"PUT file {path}")

    async def delete_file(self, path: str) -> None:
        response = await (await self._http()).delete(self._file_url(path), headers=self._headers())
        if not response.is_success and response.status_code not in {404, 405}:
            self._raise(response, f"DELETE file {path}")

    async def get_file_metadata(self, path: str) -> FileEntry | None:
        response = await (await self._http()).post(
            self._io_url("metadata"),
            headers=self._headers({"Content-Type": "application/json; charset=utf-8"}),
            json={"path": path},
        )
        if response.status_code == 404:
            return None
        if not response.is_success:
            return None
        value = response.json().get("file")
        return FileEntry.from_wire(value) if value else None

    async def read_recovery_wrapper(self, locator: str) -> bytes:
        if self.recovery_base_url is None:
            raise RuntimeError("Cloudflare recovery requires recovery_base_url")
        if not isinstance(locator, str) or _RECOVERY_LOCATOR_RE.fullmatch(locator) is None:
            raise ValueError("Invalid recovery locator")
        response = await (await self._http()).get(f"{self.recovery_base_url}/{locator}", headers=self._recovery_headers())
        self._raise(response, "GET recovery wrapper")
        return response.content

    async def write_recovery_wrapper(self, locator: str, data: bytes) -> None:
        if self.recovery_base_url is None:
            raise RuntimeError("Cloudflare recovery requires recovery_base_url")
        if not isinstance(locator, str) or _RECOVERY_LOCATOR_RE.fullmatch(locator) is None:
            raise ValueError("Invalid recovery locator")
        response = await (await self._http()).put(
            f"{self.recovery_base_url}/{locator}", headers=self._recovery_headers(), content=data
        )
        self._raise(response, "PUT recovery wrapper")

    async def put_stored_file(
        self,
        path: str,
        data: bytes | str,
        *,
        uploaded_by_device_id: str | None = None,
        plaintext_size: int | None = None,
        content_type: str | None = None,
        taint: str | None = None,
    ) -> StoredFileMetadata:
        bytes_data = data.encode("utf-8") if isinstance(data, str) else bytes(data)
        headers = self._headers(
            {
                "Content-Type": content_type or "application/octet-stream",
                "X-Interocitor-Device-Id": uploaded_by_device_id or "",
                "X-Interocitor-Plaintext-Size": str(plaintext_size if plaintext_size is not None else len(bytes_data)),
            }
        )
        if taint:
            headers["X-Interocitor-Taint"] = taint
        response = await (await self._http()).put(self._file_url(path, stored=True), headers=headers, content=bytes_data)
        self._raise(response, f"PUT stored file {path}")
        return StoredFileMetadata.from_wire(response.json()["file"])

    async def get_stored_file(self, path: str) -> bytes:
        response = await (await self._http()).get(self._file_url(path, stored=True), headers=self._headers())
        self._raise(response, f"GET stored file {path}")
        return response.content

    async def delete_stored_file(self, path: str) -> None:
        response = await (await self._http()).delete(self._file_url(path, stored=True), headers=self._headers())
        if not response.is_success and response.status_code != 404:
            self._raise(response, f"DELETE stored file {path}")

    async def get_stored_file_metadata(self, path: str) -> StoredFileMetadata | None:
        response = await (await self._http()).post(
            self._io_url("stored-file-metadata"),
            headers=self._headers({"Content-Type": "application/json; charset=utf-8"}),
            json={"path": path},
        )
        if response.status_code == 404 or not response.is_success:
            return None
        value = response.json().get("file")
        return StoredFileMetadata.from_wire(value) if value else None
