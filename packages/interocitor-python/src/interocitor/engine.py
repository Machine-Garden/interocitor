"""Async Python implementation of Interocitor's encrypted mesh core.

This is intentionally a core library, not a task-queue abstraction.  A worker
uses the normal mesh APIs with a volatile ``MemoryLocalStore`` and its own
environment/secret provider.  The wire protocol (manifest, HLC, CRDT changes,
snapshots, and AES-GCM envelopes) matches ``@interocitor/core``.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from functools import cmp_to_key
from typing import Any

from .adapters import FileEntry, StorageAdapter, StoredFileMetadata
from .crdt import apply_change_entry, row_to_plain
from .crypto import (
    decrypt_bytes,
    decrypt_entry,
    encrypt_bytes,
    encrypt_entry,
    json_stringify,
    portable_key_to_bytes,
)
from .hlc import hlc_compare_str, hlc_init, hlc_now, hlc_parse, hlc_receive, hlc_serialize
from .ids import create_device_id, generate_id, uuidv7
from .key_source import MeshKeyContext, MeshKeySource
from .memory import MemoryLocalStore
from .schema import SchemaInput, normalize_schema
from .types import (
    ChangeEntry,
    ChangesHead,
    ColumnEntry,
    DeleteOp,
    HLC,
    Manifest,
    ManifestPointer,
    MeshChangePayload,
    MeshSnapshotPayload,
    Row,
    RowMeta,
    Snapshot,
    UpsertOp,
)




class InterocitorError(RuntimeError):
    """Base exception for the Python mesh engine."""


class MeshNotFoundError(InterocitorError):
    """Raised when a worker is configured to join, not create, a mesh."""


class MeshMismatchError(InterocitorError):
    """Raised when an object belongs to a different mesh than expected."""


class MeshEncryptionMismatchError(InterocitorError):
    """Raised when local key configuration differs from the remote manifest."""


@dataclass(frozen=True)
class _Paths:
    root: str

    @property
    def manifest_pointer(self) -> str:
        return f"{self.root}/manifest.json"

    def manifest_file(self, generation: int) -> str:
        return f"{self.root}/manifest-{generation}.json"

    @property
    def devices_folder(self) -> str:
        return f"{self.root}/devices"

    def device_file(self, device_id: str) -> str:
        return f"{self.devices_folder}/{device_id}.json"

    @property
    def mainline_folder(self) -> str:
        return f"{self.root}/mainline"

    @property
    def changes_folder(self) -> str:
        return f"{self.root}/changes"

    @property
    def changes_head(self) -> str:
        return f"{self.changes_folder}/head.json"

    def change_file(self, name: str) -> str:
        return f"{self.changes_folder}/{name}"


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _compact_json(value: object) -> str:
    """The JSON spelling used by JavaScript's ``JSON.stringify`` for protocol data."""

    return json_stringify(value)


def _pretty_json(value: object) -> bytes:
    """The human-readable form core writes for manifests, heads, and metadata."""

    return json_stringify(value, indent=2).encode("utf-8")


def _reject_non_json_constant(value: str) -> None:
    raise ValueError(f"Invalid JSON constant: {value}")


def _decode_json(data: bytes | str, description: str) -> object:
    raw = data if isinstance(data, str) else bytes(data).decode("utf-8", errors="replace")
    try:
        return json.loads(raw, parse_constant=_reject_non_json_constant)
    except (TypeError, ValueError, json.JSONDecodeError) as error:
        raise InterocitorError(f"Invalid {description}") from error


def _content_hash(payload: object) -> str:
    return "sha256:" + hashlib.sha256(_compact_json(payload).encode("utf-8")).hexdigest()


def _is_not_found(error: BaseException) -> bool:
    return isinstance(error, FileNotFoundError) or "HTTP 404" in str(error)


def _change_file_hlc(name: str) -> str | None:
    marker = name.rfind("-chg_")
    return None if marker < 0 else name[:marker]


def _utf16_compare(left: str, right: str) -> int:
    """Compare strings as JavaScript relational operators do."""

    left_units = left.encode("utf-16-be", errors="surrogatepass")
    right_units = right.encode("utf-16-be", errors="surrogatepass")
    if left_units < right_units:
        return -1
    if left_units > right_units:
        return 1
    return 0


def _compare_change_files(left: FileEntry, right: FileEntry) -> int:
    """Order changes by protocol HLC rather than locale-dependent names."""

    left_hlc = _change_file_hlc(left.name)
    right_hlc = _change_file_hlc(right.name)
    if left_hlc and right_hlc:
        try:
            compared = hlc_compare_str(left_hlc, right_hlc)
        except (TypeError, ValueError):
            # Keep malformed entries on the normal per-file decode/poison
            # path; only valid protocol HLCs influence merge order.
            compared = 0
        if compared:
            return compared
    return _utf16_compare(left.name, right.name)


def _validate_change_hlcs(entry: ChangeEntry) -> None:
    """Reject malformed remote clocks before they reach CRDT state."""

    hlc_parse(entry.hlc)
    for operation in entry.ops:
        if isinstance(operation, DeleteOp):
            hlc_parse(operation.hlc)
        else:
            for column in operation.columns.values():
                hlc_parse(column.hlc)


def _validate_snapshot_hlcs(snapshot: Snapshot) -> None:
    """Reject malformed snapshot clocks before rehydrating local state."""

    if snapshot.hlc:
        hlc_parse(snapshot.hlc)
    for rows in snapshot.tables.values():
        for row in rows.values():
            if row._meta.deleted_hlc:
                hlc_parse(row._meta.deleted_hlc)
            for column in row.payload.values():
                hlc_parse(column.hlc)


def _validate_manifest_hlcs(manifest: Manifest) -> None:
    """Validate the manifest clock used for state ordering."""

    if manifest.watermark_hlc:
        hlc_parse(manifest.watermark_hlc)


class Table:
    """Small async façade over one table in an :class:`Interocitor` mesh."""

    def __init__(self, engine: "Interocitor", name: str) -> None:
        self._engine = engine
        self.name = name

    async def row(self, row_id: str) -> dict[str, Any] | None:
        return await self._engine.get(self.name, row_id)

    async def get(self, row_id: str) -> dict[str, Any] | None:
        return await self.row(row_id)

    async def query(self) -> list[dict[str, Any]]:
        return await self._engine.query(self.name)

    async def where(self, clause: Mapping[str, Any]) -> list[dict[str, Any]]:
        return await self._engine.query_where(self.name, clause)

    async def put(self, row_id: str, columns: Mapping[str, Any]) -> dict[str, Any]:
        return await self._engine.put(self.name, row_id, columns)

    async def patch(self, row_id: str, columns: Mapping[str, Any]) -> dict[str, Any]:
        return await self._engine.put(self.name, row_id, columns)

    async def add(self, columns: Mapping[str, Any], *, row_id: str | None = None) -> dict[str, Any]:
        return await self._engine.add(self.name, columns, row_id=row_id)

    async def delete(self, row_id: str) -> None:
        await self._engine.delete(self.name, row_id)


class Interocitor:
    """A native, async Interocitor core client.

    ``adapter`` is the mailbox transport, ``remote_path`` identifies the mesh
    namespace, and ``key_source`` supplies the full shared mesh key when the
    mesh is encrypted.  The class never reads a ``.env`` file itself; the
    application owns configuration and passes the resulting values in.
    """

    def __init__(
        self,
        adapter: StorageAdapter | None = None,
        *,
        remote_path: str | None = None,
        local_store: MemoryLocalStore | Any | None = None,
        key_source: MeshKeySource | None = None,
        schema: SchemaInput = None,
        db_name: str = "interocitor",
        device_id: str | None = None,
        device_name: str | None = None,
        device_type: str | None = None,
        server_id: str = "server_relay_1",
        server_managed: bool = False,
        expected_mesh_id: str | None = None,
        require_existing_mesh: bool = False,
        require_encryption: bool = False,
    ) -> None:
        if not db_name:
            raise ValueError("db_name must not be empty")
        if not server_id:
            raise ValueError("server_id must not be empty")
        self._adapter = adapter
        self._remote_path = remote_path
        self._local = local_store or MemoryLocalStore()
        self._key_source = key_source
        self._schema = normalize_schema(schema)
        self._db_name = db_name
        self._device_id_configured = device_id is not None
        self._device_id = device_id or create_device_id()
        self._device_name = device_name
        self._device_type = device_type
        self._server_id = server_id
        self._server_managed = server_managed
        self._expected_mesh_id = expected_mesh_id
        self._require_existing_mesh = require_existing_mesh
        self._require_encryption = require_encryption
        self._initialized = False
        self._connected = False
        self._encrypted = key_source is not None
        self._key: bytes | None = None
        self._portable_key: str | None = None
        self._manifest: Manifest | None = None
        self._remote_poison_error: InterocitorError | None = None
        self._tables: dict[str, dict[str, Row]] = {}
        self._known_tables: set[str] = set()
        self._hlc: HLC = hlc_init(self._device_id)
        self._init_lock = asyncio.Lock()
        self._connect_lock = asyncio.Lock()
        # Row writes, remote merge, snapshot replacement, and compaction all
        # mutate the same local CRDT state. They must serialize together: a
        # write interleaved with rehydration can otherwise be cleared or built
        # from a stale row after a remote merge.
        self._state_lock = asyncio.Lock()

    # ── Lifecycle and configuration ─────────────────────────────────

    async def init(self) -> None:
        """Open local state and resolve the configured key source.

        This local-only boundary mirrors ``core.init()``.  It does not contact
        the adapter, so a program may prepare rows before connecting. Queued
        mutations are rebased over a newer remote snapshot during ``connect``
        rather than being discarded.
        """

        if self._initialized:
            return
        async with self._init_lock:
            if self._initialized:
                return
            await self._init_once()

    async def _init_once(self) -> None:
        await self._local.open()
        if self._schema_version is not None:
            await self._local.set_meta("schema:version", self._schema_version)
        if not self._device_id_configured:
            saved = await self._local.get_meta("deviceId")
            if isinstance(saved, str) and saved:
                self._device_id = saved
                self._hlc.node_id = saved
        await self._local.set_meta("deviceId", self._device_id)

        if self._key_source is not None:
            material = await self._key_source.load(self._key_context())
            self._encrypted = material.encrypted
            self._key = material.key
            self._portable_key = material.portable_key
            if self._encrypted and self._key is None and self._portable_key:
                self._key = portable_key_to_bytes(self._portable_key)
        else:
            self._encrypted = False
            self._key = None
            self._portable_key = None
        if self._encrypted and self._key is None:
            raise InterocitorError("Encrypted meshes require a key from key_source")
        if self._require_encryption and not self._encrypted:
            raise InterocitorError("This client requires an encrypted mesh key")

        saved_hlc = await self._local.get_meta("hlc")
        if isinstance(saved_hlc, str) and saved_hlc:
            self._hlc = hlc_parse(saved_hlc)
            self._hlc.node_id = self._device_id
        await self._load_tables_from_local()
        self._initialized = True

    async def connect(self) -> None:
        """Authenticate, load/join the manifest, rehydrate if needed, and pull."""

        async with self._connect_lock:
            if self._connected:
                return
            await self.init()
            async with self._state_lock:
                if self._connected:
                    return
                adapter = self._require_adapter("connect")
                paths = self._paths("connect")
                if not adapter.is_authenticated():
                    await adapter.authenticate()
                for folder in (paths.root, paths.devices_folder, paths.mainline_folder, paths.changes_folder):
                    await adapter.ensure_folder(folder)
                manifest, bootstrapped = await self._load_or_create_manifest()
                await self._upsert_device_metadata(bootstrap=bootstrapped)

                local_epoch = await self._local.get_meta("epoch")
                if not isinstance(local_epoch, int):
                    local_epoch = 0
                if manifest.epoch > local_epoch:
                    await self._flush()
                    await self._rehydrate()
                else:
                    await self._pull(reload_manifest=False)
                await self._flush()
                await self._acknowledge_manifest()
                self._connected = True

    async def disconnect(self) -> None:
        """Tear down a session and clear a volatile store.

        Match core's convenience behavior by attempting a final flush, but do
        not treat it as the job-success boundary: callers should explicitly
        ``await flush()`` before reporting a completed task.
        """

        async with self._connect_lock:
            async with self._state_lock:
                if not self._initialized:
                    return
                try:
                    if self._adapter is not None and self._remote_path:
                        try:
                            await self._flush()
                        except Exception:
                            # This follows core's disconnect behavior. The
                            # explicit flush above an application's success
                            # acknowledgement is the reliable delivery
                            # boundary.
                            pass
                finally:
                    self._local.close()
                    self._initialized = False
                    self._connected = False
                    self._manifest = None
                    self._remote_poison_error = None
                    self._tables.clear()
                    self._known_tables.clear()

    async def aclose(self) -> None:
        await self.disconnect()

    async def __aenter__(self) -> "Interocitor":
        await self.connect()
        return self

    async def __aexit__(self, _type: object, _value: object, _traceback: object) -> None:
        await self.disconnect()

    # ── Core row API ─────────────────────────────────────────────────

    def table(self, name: str) -> Table:
        if not isinstance(name, str) or not name:
            raise ValueError("Table name must be a non-empty string")
        return Table(self, name)

    async def get(self, table: str, row_id: str) -> dict[str, Any] | None:
        await self.init()
        async with self._state_lock:
            row = await self._local.get_row(table, row_id)
            return None if row is None or row._meta.deleted else row_to_plain(row)

    async def query(self, table: str) -> list[dict[str, Any]]:
        await self.init()
        async with self._state_lock:
            return [row_to_plain(row) for row in await self._local.get_table(table)]

    async def query_where(self, table: str, clause: Mapping[str, Any]) -> list[dict[str, Any]]:
        await self.init()
        async with self._state_lock:
            return [row_to_plain(row) for row in await self._local.query_where(table, clause)]

    async def put(self, table: str, row_id: str, columns: Mapping[str, Any]) -> dict[str, Any]:
        """Upsert fields and append a CRDT change entry to the local outbox."""

        if not isinstance(table, str) or not table:
            raise ValueError("Table name must be a non-empty string")
        if not isinstance(row_id, str) or not row_id:
            raise ValueError("row_id must be a non-empty string")
        if not isinstance(columns, Mapping):
            raise TypeError("columns must be a mapping")
        await self.init()
        async with self._state_lock:
            current = await self._local.get_row(table, row_id)
            if current is None:
                row = Row(
                    _meta=RowMeta(table=table, row_id=row_id, deleted=False, schema_version=self._local_schema_version),
                    payload={},
                )
            else:
                # A row resurrection starts a fresh payload, exactly as core
                # avoids accidentally republishing pre-tombstone columns.
                row = Row.from_wire(current.to_wire())
                if row._meta.deleted:
                    row.payload = {}
            self._hlc = hlc_now(self._hlc)
            stamp = hlc_serialize(self._hlc)
            for name, value in columns.items():
                if not isinstance(name, str):
                    raise TypeError("column names must be strings")
                row.payload[name] = ColumnEntry(value=value, hlc=stamp)
            row._meta.deleted = False
            row._meta.deleted_hlc = None
            row._meta.owner = self._device_id
            entry = self._change_for_row(row)
            if entry is None:
                return row_to_plain(row)
            await self._local.commit_local_mutation(row, entry)
            self._tables.setdefault(table, {})[row_id] = row
            self._known_tables.add(table)
            return row_to_plain(row)

    async def add(self, table: str, columns: Mapping[str, Any], *, row_id: str | None = None) -> dict[str, Any]:
        return await self.put(table, row_id or uuidv7(), columns)

    async def delete(self, table: str, row_id: str) -> None:
        await self.init()
        async with self._state_lock:
            current = await self._local.get_row(table, row_id)
            if current is None or current._meta.deleted:
                return
            self._hlc = hlc_now(self._hlc)
            current._meta.deleted = True
            current._meta.deleted_hlc = hlc_serialize(self._hlc)
            current._meta.owner = self._device_id
            current.payload = {}
            entry = self._change_for_row(current)
            if entry is None:
                return
            await self._local.commit_local_mutation(current, entry)
            self._tables.setdefault(table, {})[row_id] = current

    # ── Sync ─────────────────────────────────────────────────────────

    async def pull(self) -> None:
        await self.init()
        async with self._state_lock:
            manifest, _ = await self._load_or_create_manifest()
            local_epoch = await self._local.get_meta("epoch")
            if not isinstance(local_epoch, int):
                local_epoch = 0
            # A snapshot is the canonical base for a newer manifest epoch.
            if manifest.epoch > local_epoch:
                await self._flush()
                await self._rehydrate()
            else:
                await self._pull(reload_manifest=False)
            await self._acknowledge_manifest()

    async def flush(self) -> None:
        await self.init()
        async with self._state_lock:
            await self._flush()

    async def compact(self) -> Manifest:
        """Publish a snapshot and remove covered changes and superseded snapshots.

        The caller must serialize compaction across processes because storage
        adapters do not provide a distributed lease or compare-and-swap write.
        """

        await self.init()
        async with self._state_lock:
            self._require_adapter("compact")
            if self._manifest is None:
                raise InterocitorError("compact() requires a connected mesh")
            await self._pull(reload_manifest=True)
            await self._acknowledge_manifest()
            manifest = self._manifest
            if manifest is None:
                raise InterocitorError("Manifest disappeared during compaction")
            if manifest.server.get("managed") and self._device_id != self._server_id:
                raise InterocitorError("Compaction is allowed only for the authorized server writer")

            paths = self._paths("compact")
            next_epoch = manifest.epoch + 1
            now = _now()
            snapshot_tables: dict[str, dict[str, Row]] = {}
            for row in await self._local.get_all_rows():
                snapshot_tables.setdefault(row._meta.table, {})[row._meta.row_id] = row
            seen_raw = await self._local.get_meta("seenChangeFiles")
            covered_change_files = sorted(
                name for name in seen_raw if isinstance(name, str)
            ) if isinstance(seen_raw, list) else []
            snapshot = Snapshot(
                snapshot_id=generate_id("snap"),
                timestamp=now,
                hlc=hlc_serialize(self._hlc),
                epoch=next_epoch,
                schema_version=manifest.schema,
                tables=snapshot_tables,
                covered_change_files=covered_change_files,
            )
            snapshot_path = f"{paths.mainline_folder}/snapshot-{next_epoch}-{self._server_id}.json"
            await self._require_adapter("compact").write_file(
                snapshot_path,
                self._encode_snapshot_payload(snapshot).encode("utf-8"),
            )

            next_manifest = Manifest(
                generation=manifest.generation + 1,
                parent_generation=manifest.generation,
                written_by=self._server_id,
                written_at=now,
                content_hash="",
                version=3,
                mesh_id=manifest.mesh_id,
                schema=manifest.schema,
                encrypted=manifest.encrypted,
                server=manifest.server,
                created_at=manifest.created_at,
                epoch=next_epoch,
                watermark_hlc=hlc_serialize(self._hlc),
                snapshot_path=snapshot_path,
                delta_path=None,
                retention=manifest.retention,
            )
            next_manifest.content_hash = _content_hash(next_manifest.payload_wire())
            await self._write_json(paths.manifest_file(next_manifest.generation), next_manifest.to_wire())
            await self._write_json(
                paths.manifest_pointer,
                ManifestPointer(next_manifest.generation, f"manifest-{next_manifest.generation}.json").to_wire(),
            )
            self._manifest = next_manifest
            await self._local.set_meta("epoch", next_epoch)
            await self._local.set_meta("manifestCache", next_manifest.to_wire())

            for file_name in covered_change_files:
                try:
                    await self._require_adapter("compact").delete_file(
                        f"{paths.changes_folder}/{file_name}"
                    )
                except Exception:
                    pass

            # The manifest names the only authoritative full-state snapshot.
            # Once its pointer is published, every older snapshot is
            # superseded and can be retried safely on the next compaction.
            try:
                active_snapshot_name = snapshot_path.rsplit("/", 1)[-1]
                snapshots = await self._require_adapter("compact").list_files(paths.mainline_folder)
                for entry in snapshots:
                    if (
                        entry.name != active_snapshot_name
                        and entry.name.startswith("snapshot-")
                        and entry.name.endswith(".json")
                    ):
                        try:
                            await self._require_adapter("compact").delete_file(entry.path)
                        except Exception:
                            pass
            except Exception:
                pass

            await self._acknowledge_manifest()
            return Manifest.from_wire(next_manifest.to_wire())

    # ── Durable application files ────────────────────────────────────

    async def put_file(
        self,
        path: str,
        data: bytes | bytearray | memoryview | str,
        content_type: str | None = None,
    ) -> StoredFileMetadata:
        await self.init()
        adapter = self._require_adapter("put_file")
        file_path = self._stored_file_path(path)
        plaintext = data.encode("utf-8") if isinstance(data, str) else bytes(data)
        stored = self._encode_bytes(plaintext)
        put_stored = getattr(adapter, "put_stored_file", None)
        if callable(put_stored):
            return await put_stored(
                file_path,
                stored,
                uploaded_by_device_id=self._device_id,
                plaintext_size=len(plaintext),
                content_type=content_type,
            )
        await adapter.ensure_folder(f"{self._paths('put_file').root}/files")
        await adapter.write_file(file_path, stored)
        metadata = await adapter.get_file_metadata(file_path)
        now = _now()
        if metadata is None:
            return StoredFileMetadata(
                name=file_path.rsplit("/", 1)[-1],
                path=file_path,
                size=len(stored),
                modified_time=now,
                uploaded_by_device_id=self._device_id,
                plaintext_size=len(plaintext),
                stored_size=len(stored),
                content_type=content_type,
            )
        return StoredFileMetadata(
            name=metadata.name,
            path=metadata.path,
            size=metadata.size,
            modified_time=metadata.modified_time,
            etag=metadata.etag,
            revision=metadata.revision,
            uploaded_by_device_id=self._device_id,
            plaintext_size=len(plaintext),
            stored_size=len(stored),
            content_type=content_type,
        )

    async def get_file(self, path: str) -> bytes:
        await self.init()
        adapter = self._require_adapter("get_file")
        file_path = self._stored_file_path(path)
        getter = getattr(adapter, "get_stored_file", None)
        stored = await getter(file_path) if callable(getter) else await adapter.read_file(file_path)
        return self._decode_bytes(stored)

    async def delete_file(self, path: str) -> None:
        await self.init()
        adapter = self._require_adapter("delete_file")
        file_path = self._stored_file_path(path)
        deleter = getattr(adapter, "delete_stored_file", None)
        if callable(deleter):
            await deleter(file_path)
        else:
            await adapter.delete_file(file_path)

    async def get_file_metadata(self, path: str) -> StoredFileMetadata | None:
        await self.init()
        adapter = self._require_adapter("get_file_metadata")
        file_path = self._stored_file_path(path)
        getter = getattr(adapter, "get_stored_file_metadata", None)
        if callable(getter):
            return await getter(file_path)
        metadata = await adapter.get_file_metadata(file_path)
        if metadata is None:
            return None
        return StoredFileMetadata(
            name=metadata.name,
            path=metadata.path,
            size=metadata.size,
            modified_time=metadata.modified_time,
            etag=metadata.etag,
            revision=metadata.revision,
            stored_size=metadata.size,
        )

    # ── Core state inspection ────────────────────────────────────────

    def get_device_id(self) -> str:
        return self._device_id

    def get_mesh_id(self) -> str | None:
        return self._manifest.mesh_id if self._manifest is not None else None

    def get_manifest(self) -> Manifest | None:
        return Manifest.from_wire(self._manifest.to_wire()) if self._manifest is not None else None

    def is_encrypted(self) -> bool:
        return self._encrypted

    @property
    def connected(self) -> bool:
        return self._connected

    # ── Internal protocol implementation ─────────────────────────────

    @property
    def _schema_version(self) -> int | None:
        if self._schema is None:
            return None
        value = self._schema.get("version")
        return value if type(value) is int else None

    @property
    def _local_schema_version(self) -> int:
        return self._schema_version if self._schema_version is not None else 0

    def _key_context(self) -> MeshKeyContext:
        return MeshKeyContext(
            db_name=self._db_name,
            remote_path=self._remote_path,
            mesh_id=self._manifest.mesh_id if self._manifest is not None else None,
            device_id=self._device_id,
        )

    def _require_adapter(self, operation: str) -> StorageAdapter:
        if self._remote_poison_error is not None:
            raise self._remote_poison_error
        if self._adapter is None:
            raise InterocitorError(f"{operation} requires a remote storage adapter")
        return self._adapter

    def _poison_remote(self, error: BaseException) -> InterocitorError:
        """Stop using a mesh after evidence of corrupt or wrong-key state.

        Continuing to flush after a failed change/snapshot decode can mix new
        writes into a mesh the client no longer understands.  Core treats this
        as a session boundary; callers must disconnect before attempting a new
        connection.
        """

        if self._remote_poison_error is None:
            if isinstance(error, InterocitorError):
                poisoned = error
            else:
                poisoned = InterocitorError(f"Remote sync halted: {error}")
                poisoned.__cause__ = error
            self._remote_poison_error = poisoned
            self._connected = False
            reset = getattr(self._adapter, "reset_folder_cache", None)
            if callable(reset):
                reset()
        return self._remote_poison_error

    def _paths(self, operation: str) -> _Paths:
        if not self._remote_path:
            raise InterocitorError(f"{operation} requires remote_path")
        root = self._remote_path.rstrip("/")
        return _Paths(root=root)

    def _stored_file_path(self, path: str) -> str:
        if not isinstance(path, str):
            raise TypeError("Stored file path must be a string")
        clean = "/".join(part for part in path.split("/") if part)
        if not clean:
            raise ValueError("Stored file path must not be empty")
        return f"{self._paths('file storage').root}/files/{clean}"

    async def _load_tables_from_local(self) -> None:
        self._tables = {}
        self._known_tables = set()
        for row in await self._local.get_all_rows():
            self._tables.setdefault(row._meta.table, {})[row._meta.row_id] = row
            self._known_tables.add(row._meta.table)

    async def _read_json_if_exists(self, path: str, description: str) -> object | None:
        try:
            return _decode_json(await self._require_adapter("read").read_file(path), description)
        except Exception as error:
            if _is_not_found(error):
                return None
            raise

    async def _write_json(self, path: str, value: object) -> None:
        await self._require_adapter("write").write_file(path, _pretty_json(value))

    async def _load_or_create_manifest(self) -> tuple[Manifest, bool]:
        paths = self._paths("manifest")
        pointer_wire = await self._read_json_if_exists(paths.manifest_pointer, "manifest pointer")
        bootstrapped = pointer_wire is None
        if pointer_wire is None:
            if self._require_existing_mesh:
                raise MeshNotFoundError(
                    f"No manifest exists at {paths.manifest_pointer}; this client is configured to join an existing mesh"
                )
            manifest = await self._create_manifest()
        else:
            pointer = ManifestPointer.from_wire(pointer_wire)
            manifest_wire = await self._read_json_if_exists(f"{paths.root}/{pointer.file}", "manifest")
            if manifest_wire is None:
                raise InterocitorError(f"Manifest pointer references a missing file: {pointer.file}")
            manifest = Manifest.from_wire(manifest_wire)
            _validate_manifest_hlcs(manifest)
            expected_hash = _content_hash(manifest.payload_wire())
            if manifest.content_hash != expected_hash:
                raise InterocitorError("Manifest content hash mismatch")
        if manifest.version != 3:
            raise InterocitorError(f"Unsupported manifest version {manifest.version} (expected 3)")
        if manifest.server.get("managed") and manifest.written_by != self._server_id:
            raise InterocitorError(f"Unauthorized manifest writer: {manifest.written_by}")
        if self._schema_version is not None and manifest.schema != self._schema_version:
            raise InterocitorError(f"Schema version mismatch: local={self._schema_version}, remote={manifest.schema}")
        if manifest.encrypted != self._encrypted:
            raise MeshEncryptionMismatchError(
                f"Remote mesh encryption is {manifest.encrypted}; local key configuration is {self._encrypted}"
            )
        if self._expected_mesh_id and manifest.mesh_id != self._expected_mesh_id:
            raise MeshMismatchError(f"Expected mesh {self._expected_mesh_id}, got {manifest.mesh_id}")
        stored_mesh_id = await self._local.get_meta("meshId")
        if isinstance(stored_mesh_id, str) and stored_mesh_id and stored_mesh_id != manifest.mesh_id:
            raise MeshMismatchError(f"Expected mesh {stored_mesh_id}, got {manifest.mesh_id}")
        await self._local.set_meta("meshId", manifest.mesh_id)
        await self._local.set_meta("manifestCache", manifest.to_wire())
        self._manifest = manifest
        if self._key_source is not None and self._portable_key:
            await self._key_source.persist(self._key_context(), self._portable_key, manifest.mesh_id)
        return manifest, bootstrapped

    async def _create_manifest(self) -> Manifest:
        paths = self._paths("manifest")
        now = _now()
        manifest = Manifest(
            generation=1,
            parent_generation=0,
            written_by=self._server_id,
            written_at=now,
            content_hash="",
            version=3,
            mesh_id=generate_id("mesh"),
            schema=self._schema_version if self._schema_version is not None else 1,
            encrypted=self._encrypted,
            server={"managed": self._server_managed, "relayUrl": None, "serverId": self._server_id},
            created_at=now,
            epoch=0,
            watermark_hlc="",
            snapshot_path=None,
            delta_path=None,
        )
        manifest.content_hash = _content_hash(manifest.payload_wire())
        await self._write_json(paths.manifest_file(1), manifest.to_wire())
        await self._write_json(paths.manifest_pointer, ManifestPointer(1, "manifest-1.json").to_wire())
        return manifest

    async def _upsert_device_metadata(self, *, bootstrap: bool = False) -> None:
        if self._adapter is None or not self._remote_path:
            return
        paths = self._paths("device metadata")
        existing = None if bootstrap else await self._read_json_if_exists(paths.device_file(self._device_id), "device metadata")
        old = existing if isinstance(existing, Mapping) else {}
        now = _now()
        manifest = self._manifest
        metadata: dict[str, Any] = {
            "deviceId": self._device_id,
            "registeredAt": old.get("registeredAt", now),
            "lastSeenAt": now,
        }
        for key in ("userId", "name", "retired", "cutOffAt", "cutOffReason"):
            if key in old:
                metadata[key] = old[key]
        if self._device_name is not None:
            metadata["displayName"] = self._device_name
        elif "displayName" in old:
            metadata["displayName"] = old["displayName"]
        if self._device_type is not None:
            metadata["deviceType"] = self._device_type
        elif "deviceType" in old:
            metadata["deviceType"] = old["deviceType"]
        if manifest is not None and (manifest.epoch or manifest.watermark_hlc):
            metadata["observedManifestGeneration"] = manifest.generation
            metadata["observedEpoch"] = manifest.epoch
            metadata["observedWatermarkHlc"] = manifest.watermark_hlc
            metadata["observedAt"] = now
        await self._write_json(paths.device_file(self._device_id), metadata)

    async def _acknowledge_manifest(self) -> None:
        """Record that this device has incorporated the current manifest base."""

        manifest = self._manifest
        if manifest is None or (manifest.epoch == 0 and not manifest.watermark_hlc):
            return
        await self._upsert_device_metadata()

    def _encode_text(self, plaintext: str) -> str:
        if not self._encrypted:
            return plaintext
        if self._key is None:
            raise InterocitorError("Encrypted mesh has no active key")
        return encrypt_entry(self._key, plaintext)

    def _decode_text(self, payload: bytes | str) -> str:
        if not self._encrypted:
            return payload if isinstance(payload, str) else bytes(payload).decode("utf-8", errors="replace")
        if self._key is None:
            raise InterocitorError("Encrypted mesh has no active key")
        try:
            return decrypt_entry(self._key, payload)
        except Exception as error:
            raise InterocitorError("Decryption failed: payload is not decryptable with the active mesh key") from error

    def _encode_bytes(self, plaintext: bytes) -> bytes:
        if not self._encrypted:
            return plaintext
        if self._key is None:
            raise InterocitorError("Encrypted mesh has no active key")
        return encrypt_bytes(self._key, plaintext)

    def _decode_bytes(self, payload: bytes) -> bytes:
        if not self._encrypted:
            return bytes(payload)
        if self._key is None:
            raise InterocitorError("Encrypted mesh has no active key")
        try:
            return decrypt_bytes(self._key, payload)
        except Exception as error:
            raise InterocitorError("Decryption failed: file is not decryptable with the active mesh key") from error

    def _encode_change_payload(self, entry: ChangeEntry) -> str:
        if self._manifest is None:
            raise InterocitorError("Cannot encode a change before manifest is loaded")
        return self._encode_text(_compact_json(MeshChangePayload(self._manifest.mesh_id, entry).to_wire()))

    def _decode_change_payload(self, payload: bytes | str, path: str) -> ChangeEntry:
        wire = _decode_json(self._decode_text(payload), f"change payload at {path}")
        try:
            decoded = MeshChangePayload.from_wire(wire)
        except ValueError as error:
            raise InterocitorError(f"Remote change payload has invalid shape: {path}") from error
        self._assert_payload_mesh(decoded.mesh_id)
        _validate_change_hlcs(decoded.entry)
        return decoded.entry

    def _encode_snapshot_payload(self, snapshot: Snapshot) -> str:
        if self._manifest is None:
            raise InterocitorError("Cannot encode a snapshot before manifest is loaded")
        return self._encode_text(_compact_json(MeshSnapshotPayload(self._manifest.mesh_id, snapshot).to_wire()))

    def _decode_snapshot_payload(self, payload: bytes | str, path: str) -> Snapshot:
        wire = _decode_json(self._decode_text(payload), f"snapshot payload at {path}")
        try:
            decoded = MeshSnapshotPayload.from_wire(wire)
        except ValueError as error:
            raise InterocitorError(f"Remote snapshot payload has invalid shape: {path}") from error
        self._assert_payload_mesh(decoded.mesh_id)
        _validate_snapshot_hlcs(decoded.snapshot)
        return decoded.snapshot

    def _assert_payload_mesh(self, mesh_id: str) -> None:
        if self._manifest is None or mesh_id != self._manifest.mesh_id:
            expected = self._manifest.mesh_id if self._manifest is not None else "<no manifest>"
            raise MeshMismatchError(f"Remote mesh mismatch: expected {expected}, got {mesh_id}")

    async def _pull(self, *, reload_manifest: bool) -> None:
        if self._adapter is None or not self._remote_path:
            return
        if reload_manifest or self._manifest is None:
            await self._load_or_create_manifest()
        paths = self._paths("pull")
        cursor = await self._local.get_meta("cursor")
        cursor = cursor if isinstance(cursor, str) else ""
        seen_raw = await self._local.get_meta("seenChangeFiles")
        seen_change_files = (
            set(seen_raw)
            if isinstance(seen_raw, list) and all(isinstance(name, str) for name in seen_raw)
            else set()
        )
        head_wire = await self._read_json_if_exists(paths.changes_head, "changes head")
        if head_wire is not None:
            try:
                ChangesHead.from_wire(head_wire)
            except (ValueError, TypeError):
                # A malformed head is merely an optimization miss. Listing
                # change files is still authoritative.
                pass
        try:
            files = await self._require_adapter("pull").list_files(paths.changes_folder)
        except Exception as error:
            if _is_not_found(error):
                return
            raise
        latest = cursor
        for file in sorted(files, key=cmp_to_key(_compare_change_files)):
            if file.name == "head.json":
                continue
            try:
                marker = file.name.rfind("-chg_")
                if marker < 0:
                    continue
                file_hlc = file.name[:marker]
                hlc_parse(file_hlc)
                if file.name in seen_change_files:
                    continue
                entry = self._decode_change_payload(await self._require_adapter("pull").read_file(file.path), file.path)
                if entry.hlc != file_hlc:
                    raise InterocitorError(
                        f"Remote change filename does not match payload HLC: {file.path}"
                    )
                self._hlc = hlc_receive(self._hlc, hlc_parse(entry.hlc))
                affected = apply_change_entry(
                    self._tables,
                    entry,
                    self._manifest.schema if self._manifest is not None else 1,
                    self._schema,
                )
                if affected:
                    await self._local.put_rows(affected)
                    self._known_tables.update(row._meta.table for row in affected)
                if not latest or hlc_compare_str(entry.hlc, latest) > 0:
                    latest = entry.hlc
                seen_change_files.add(file.name)
            except Exception as error:
                raise self._poison_remote(error) from error
        if latest and latest != cursor:
            await self._local.set_meta("cursor", latest)
        await self._local.set_meta("seenChangeFiles", sorted(seen_change_files))
        await self._local.set_meta("hlc", hlc_serialize(self._hlc))

    async def _flush(self) -> None:
        if self._adapter is None:
            return
        self._require_adapter("flush")
        entries = await self._local.peek_outbox()
        if not entries:
            return
        await self._load_or_create_manifest()
        paths = self._paths("flush")
        adapter = self._require_adapter("flush")
        await adapter.ensure_folder(paths.changes_folder)
        highest = ""
        for entry in entries:
            name = f"{entry.hlc}-{entry.id}.json"
            await adapter.write_file(paths.change_file(name), self._encode_change_payload(entry).encode("utf-8"))
            if not highest or hlc_compare_str(entry.hlc, highest) > 0:
                highest = entry.hlc
        if highest:
            prior_wire = await self._read_json_if_exists(paths.changes_head, "changes head")
            prior = ""
            if prior_wire is not None:
                try:
                    prior = ChangesHead.from_wire(prior_wire).latest_hlc
                except (ValueError, TypeError):
                    prior = ""
            if not prior or hlc_compare_str(highest, prior) > 0:
                await self._write_json(paths.changes_head, ChangesHead(highest).to_wire())
            cursor = await self._local.get_meta("cursor")
            if not isinstance(cursor, str) or not cursor or hlc_compare_str(highest, cursor) > 0:
                await self._local.set_meta("cursor", highest)
            seen_raw = await self._local.get_meta("seenChangeFiles")
            seen_change_files = (
                set(seen_raw)
                if isinstance(seen_raw, list) and all(isinstance(name, str) for name in seen_raw)
                else set()
            )
            seen_change_files.update(f"{entry.hlc}-{entry.id}.json" for entry in entries if entry.hlc)
            await self._local.set_meta("seenChangeFiles", sorted(seen_change_files))
        await self._upsert_device_metadata()
        await self._local.acknowledge_outbox([entry.id for entry in entries])

    async def _rehydrate(self) -> None:
        if self._manifest is None:
            return
        snapshot_path = self._manifest.snapshot_path
        if not snapshot_path:
            await self._pull(reload_manifest=False)
            return
        async def restore(path: str) -> None:
            snapshot = self._decode_snapshot_payload(
                await self._require_adapter("rehydrate").read_file(path), path
            )
            await self._local.clear_rows()
            await self._local.set_meta("cursor", "")
            await self._local.set_meta("seenChangeFiles", snapshot.covered_change_files or [])
            self._tables = {}
            self._known_tables = set()
            for table, rows in snapshot.tables.items():
                self._known_tables.add(table)
                for row in rows.values():
                    await self._local.put_row(row)
                    self._tables.setdefault(table, {})[row._meta.row_id] = row
            if snapshot.hlc:
                self._hlc = hlc_parse(snapshot.hlc)
                self._hlc.node_id = self._device_id
            await self._local.set_meta("meshId", self._manifest.mesh_id)
            await self._local.set_meta("epoch", snapshot.epoch)
            await self._local.set_meta("hlc", hlc_serialize(self._hlc))

        for attempt in range(2):
            try:
                await restore(snapshot_path)
                break
            except BaseException as error:
                # ``CancelledError`` inherits from BaseException in supported
                # Python versions. It is a lifecycle signal, not evidence that
                # the remote mesh is corrupt.
                if isinstance(error, asyncio.CancelledError):
                    raise
                if not isinstance(error, Exception):
                    raise
                if attempt == 0:
                    previous_path = snapshot_path
                    try:
                        await self._load_or_create_manifest()
                    except Exception:
                        raise self._poison_remote(error) from error
                    refreshed_path = self._manifest.snapshot_path if self._manifest is not None else None
                    if refreshed_path and refreshed_path != previous_path:
                        snapshot_path = refreshed_path
                        continue
                raise self._poison_remote(error) from error
        await self._pull(reload_manifest=False)

    def _change_for_row(self, row: Row) -> ChangeEntry | None:
        if row._meta.deleted:
            hlc = row._meta.deleted_hlc
            operation = DeleteOp(row._meta.table, row._meta.row_id, hlc or "") if hlc else None
        else:
            columns = {name: entry for name, entry in row.payload.items() if entry.hlc}
            hlc = self._row_hlc(row)
            operation = UpsertOp(row._meta.table, row._meta.row_id, columns) if columns else None
        if operation is None or not hlc:
            return None
        return ChangeEntry(id=generate_id("chg"), ts=self._hlc.ts, device=self._device_id, hlc=hlc, ops=[operation])

    @staticmethod
    def _row_hlc(row: Row) -> str:
        latest = row._meta.deleted_hlc or ""
        for entry in row.payload.values():
            if entry.hlc and (not latest or hlc_compare_str(entry.hlc, latest) > 0):
                latest = entry.hlc
        return latest
