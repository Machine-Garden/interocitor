"""Wire types shared by the Python and TypeScript Interocitor cores.

The public protocol is JSON rather than a Python object graph.  These small
dataclasses keep the Python implementation pleasant to use while preserving
the camel-case and ``_meta`` shapes emitted by ``@interocitor/core``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping, TypeAlias


JsonValue: TypeAlias = str | int | float | bool | None | list["JsonValue"] | dict[str, "JsonValue"]


def _mapping(value: object, description: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ValueError(f"{description} must be an object")
    return value


def _string(value: object, description: str) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{description} must be a string")
    return value


def _integer(value: object, description: str) -> int:
    if type(value) is not int:
        raise ValueError(f"{description} must be an integer")
    return value


@dataclass
class HLC:
    ts: int
    counter: int
    node_id: str

    def to_wire(self) -> dict[str, object]:
        return {"ts": self.ts, "counter": self.counter, "nodeId": self.node_id}

    @classmethod
    def from_wire(cls, value: object) -> "HLC":
        record = _mapping(value, "HLC")
        return cls(
            ts=_integer(record.get("ts"), "HLC timestamp"),
            counter=_integer(record.get("counter"), "HLC counter"),
            node_id=_string(record.get("nodeId"), "HLC nodeId"),
        )

    def copy(self, **updates: object) -> "HLC":
        return HLC(
            ts=updates.get("ts", self.ts),  # type: ignore[arg-type]
            counter=updates.get("counter", self.counter),  # type: ignore[arg-type]
            node_id=updates.get("node_id", self.node_id),  # type: ignore[arg-type]
        )


@dataclass(frozen=True)
class ColumnEntry:
    value: Any
    hlc: str

    def to_wire(self) -> dict[str, Any]:
        return {"value": self.value, "hlc": self.hlc}

    @classmethod
    def from_wire(cls, value: object) -> "ColumnEntry":
        record = _mapping(value, "Column entry")
        return cls(value=record.get("value"), hlc=_string(record.get("hlc"), "Column entry hlc"))


@dataclass
class RowMeta:
    table: str
    row_id: str
    deleted: bool
    schema_version: int
    deleted_hlc: str | None = None
    owner: str | None = None
    key: str | None = None

    def to_wire(self) -> dict[str, Any]:
        value: dict[str, Any] = {
            "table": self.table,
            "rowId": self.row_id,
            "deleted": self.deleted,
        }
        if self.deleted_hlc is not None:
            value["deletedHlc"] = self.deleted_hlc
        value["schemaVersion"] = self.schema_version
        if self.owner is not None:
            value["owner"] = self.owner
        if self.key is not None:
            value["key"] = self.key
        return value

    @classmethod
    def from_wire(cls, value: object) -> "RowMeta":
        record = _mapping(value, "Row metadata")
        deleted = record.get("deleted")
        if type(deleted) is not bool:
            raise ValueError("Row metadata deleted must be a boolean")
        deleted_hlc = record.get("deletedHlc")
        owner = record.get("owner")
        key = record.get("key")
        return cls(
            table=_string(record.get("table"), "Row metadata table"),
            row_id=_string(record.get("rowId"), "Row metadata rowId"),
            deleted=deleted,
            deleted_hlc=deleted_hlc if isinstance(deleted_hlc, str) else None,
            schema_version=_integer(record.get("schemaVersion"), "Row metadata schemaVersion"),
            owner=owner if isinstance(owner, str) else None,
            key=key if isinstance(key, str) else None,
        )


@dataclass
class Row:
    """Internal CRDT row shape with core-compatible ``_meta`` serialization."""

    _meta: RowMeta
    payload: dict[str, ColumnEntry]

    @property
    def meta(self) -> RowMeta:
        """Python-friendly alias for the protocol's ``_meta`` namespace."""

        return self._meta

    def to_wire(self) -> dict[str, Any]:
        return {
            "_meta": self._meta.to_wire(),
            "payload": {name: entry.to_wire() for name, entry in self.payload.items()},
        }

    @classmethod
    def from_wire(cls, value: object) -> "Row":
        record = _mapping(value, "Row")
        payload = _mapping(record.get("payload"), "Row payload")
        return cls(
            _meta=RowMeta.from_wire(record.get("_meta")),
            payload={str(name): ColumnEntry.from_wire(entry) for name, entry in payload.items()},
        )


@dataclass(frozen=True)
class UpsertOp:
    table: str
    row_id: str
    columns: dict[str, ColumnEntry]
    type: str = field(default="upsert", init=False)

    def to_wire(self) -> dict[str, Any]:
        return {
            "type": "upsert",
            "table": self.table,
            "rowId": self.row_id,
            "columns": {name: entry.to_wire() for name, entry in self.columns.items()},
        }

    @classmethod
    def from_wire(cls, value: object) -> "UpsertOp":
        record = _mapping(value, "Upsert operation")
        if record.get("type") != "upsert":
            raise ValueError("Expected an upsert operation")
        columns = _mapping(record.get("columns"), "Upsert operation columns")
        return cls(
            table=_string(record.get("table"), "Upsert operation table"),
            row_id=_string(record.get("rowId"), "Upsert operation rowId"),
            columns={str(name): ColumnEntry.from_wire(entry) for name, entry in columns.items()},
        )


@dataclass(frozen=True)
class DeleteOp:
    table: str
    row_id: str
    hlc: str
    type: str = field(default="delete", init=False)

    def to_wire(self) -> dict[str, Any]:
        return {"type": "delete", "table": self.table, "rowId": self.row_id, "hlc": self.hlc}

    @classmethod
    def from_wire(cls, value: object) -> "DeleteOp":
        record = _mapping(value, "Delete operation")
        if record.get("type") != "delete":
            raise ValueError("Expected a delete operation")
        return cls(
            table=_string(record.get("table"), "Delete operation table"),
            row_id=_string(record.get("rowId"), "Delete operation rowId"),
            hlc=_string(record.get("hlc"), "Delete operation hlc"),
        )


Op: TypeAlias = UpsertOp | DeleteOp


def op_from_wire(value: object) -> Op:
    record = _mapping(value, "Operation")
    if record.get("type") == "upsert":
        return UpsertOp.from_wire(record)
    if record.get("type") == "delete":
        return DeleteOp.from_wire(record)
    raise ValueError("Operation type must be upsert or delete")


@dataclass(frozen=True)
class ChangeEntry:
    id: str
    ts: int
    device: str
    hlc: str
    ops: list[Op]
    user: str | None = None

    def to_wire(self) -> dict[str, Any]:
        value: dict[str, Any] = {
            "id": self.id,
            "ts": self.ts,
            "device": self.device,
        }
        if self.user is not None:
            value["user"] = self.user
        value["hlc"] = self.hlc
        value["ops"] = [op.to_wire() for op in self.ops]
        return value

    @classmethod
    def from_wire(cls, value: object) -> "ChangeEntry":
        record = _mapping(value, "Change entry")
        operations = record.get("ops")
        if not isinstance(operations, list):
            raise ValueError("Change entry ops must be an array")
        user = record.get("user")
        return cls(
            id=_string(record.get("id"), "Change entry id"),
            ts=_integer(record.get("ts"), "Change entry ts"),
            device=_string(record.get("device"), "Change entry device"),
            user=user if isinstance(user, str) else None,
            hlc=_string(record.get("hlc"), "Change entry hlc"),
            ops=[op_from_wire(item) for item in operations],
        )


@dataclass(frozen=True)
class Snapshot:
    snapshot_id: str
    timestamp: str
    hlc: str
    epoch: int
    schema_version: int
    tables: dict[str, dict[str, Row]]
    covered_change_files: list[str] | None = None

    def to_wire(self) -> dict[str, Any]:
        value = {
            "snapshotId": self.snapshot_id,
            "timestamp": self.timestamp,
            "hlc": self.hlc,
            "epoch": self.epoch,
            "schemaVersion": self.schema_version,
            "tables": {
                table: {row_id: row.to_wire() for row_id, row in rows.items()}
                for table, rows in self.tables.items()
            },
        }
        if self.covered_change_files is not None:
            value["coveredChangeFiles"] = list(self.covered_change_files)
        return value

    @classmethod
    def from_wire(cls, value: object) -> "Snapshot":
        record = _mapping(value, "Snapshot")
        tables = _mapping(record.get("tables"), "Snapshot tables")
        converted: dict[str, dict[str, Row]] = {}
        for table, rows in tables.items():
            row_map = _mapping(rows, "Snapshot table")
            converted[str(table)] = {str(row_id): Row.from_wire(row) for row_id, row in row_map.items()}
        covered = record.get("coveredChangeFiles")
        if covered is not None and (not isinstance(covered, list) or not all(isinstance(name, str) for name in covered)):
            raise ValueError("Snapshot coveredChangeFiles must be an array of strings")
        return cls(
            snapshot_id=_string(record.get("snapshotId"), "Snapshot snapshotId"),
            timestamp=_string(record.get("timestamp"), "Snapshot timestamp"),
            hlc=_string(record.get("hlc"), "Snapshot hlc"),
            epoch=_integer(record.get("epoch"), "Snapshot epoch"),
            schema_version=_integer(record.get("schemaVersion"), "Snapshot schemaVersion"),
            tables=converted,
            covered_change_files=list(covered) if isinstance(covered, list) else None,
        )


@dataclass(frozen=True)
class MeshChangePayload:
    mesh_id: str
    entry: ChangeEntry
    kind: str = field(default="change", init=False)

    def to_wire(self) -> dict[str, Any]:
        return {"meshId": self.mesh_id, "kind": "change", "entry": self.entry.to_wire()}

    @classmethod
    def from_wire(cls, value: object) -> "MeshChangePayload":
        record = _mapping(value, "Mesh change payload")
        if record.get("kind") != "change":
            raise ValueError("Expected a change payload")
        return cls(
            mesh_id=_string(record.get("meshId"), "Mesh change payload meshId"),
            entry=ChangeEntry.from_wire(record.get("entry")),
        )


@dataclass(frozen=True)
class MeshSnapshotPayload:
    mesh_id: str
    snapshot: Snapshot
    kind: str = field(default="snapshot", init=False)

    def to_wire(self) -> dict[str, Any]:
        return {"meshId": self.mesh_id, "kind": "snapshot", "snapshot": self.snapshot.to_wire()}

    @classmethod
    def from_wire(cls, value: object) -> "MeshSnapshotPayload":
        record = _mapping(value, "Mesh snapshot payload")
        if record.get("kind") != "snapshot":
            raise ValueError("Expected a snapshot payload")
        return cls(
            mesh_id=_string(record.get("meshId"), "Mesh snapshot payload meshId"),
            snapshot=Snapshot.from_wire(record.get("snapshot")),
        )


@dataclass(frozen=True)
class ManifestPointer:
    current_generation: int
    file: str

    def to_wire(self) -> dict[str, Any]:
        return {"currentGeneration": self.current_generation, "file": self.file}

    @classmethod
    def from_wire(cls, value: object) -> "ManifestPointer":
        record = _mapping(value, "Manifest pointer")
        return cls(
            current_generation=_integer(record.get("currentGeneration"), "Manifest pointer currentGeneration"),
            file=_string(record.get("file"), "Manifest pointer file"),
        )


@dataclass
class Manifest:
    generation: int
    parent_generation: int
    written_by: str
    written_at: str
    content_hash: str
    version: int
    mesh_id: str
    schema: int
    encrypted: bool
    server: dict[str, Any]
    created_at: str
    epoch: int
    watermark_hlc: str
    snapshot_path: str | None
    delta_path: str | None
    retention: dict[str, int] | None = None
    lineage: int | None = None

    def payload_wire(self) -> dict[str, Any]:
        """Manifest body in the same insertion order core hashes with JSON.stringify."""

        value: dict[str, Any] = {
            "generation": self.generation,
            "parentGeneration": self.parent_generation,
            "writtenBy": self.written_by,
            "writtenAt": self.written_at,
            "version": self.version,
            "meshId": self.mesh_id,
            "schema": self.schema,
            "encrypted": self.encrypted,
            "server": self.server,
            "createdAt": self.created_at,
            "epoch": self.epoch,
            "watermarkHlc": self.watermark_hlc,
            "snapshotPath": self.snapshot_path,
            "deltaPath": self.delta_path,
        }
        if self.retention is not None:
            value["retention"] = self.retention
        if self.lineage is not None:
            value["lineage"] = self.lineage
        return value

    def to_wire(self) -> dict[str, Any]:
        value = self.payload_wire()
        value["contentHash"] = self.content_hash
        return value

    @classmethod
    def from_wire(cls, value: object) -> "Manifest":
        record = _mapping(value, "Manifest")
        encrypted = record.get("encrypted")
        if type(encrypted) is not bool:
            raise ValueError("Manifest encrypted must be a boolean")
        server = _mapping(record.get("server"), "Manifest server")
        snapshot_path = record.get("snapshotPath")
        delta_path = record.get("deltaPath")
        lineage_raw = record.get("lineage")
        lineage: int | None = None
        if lineage_raw is not None:
            lineage = _integer(lineage_raw, "Manifest lineage")
            if lineage <= 0:
                raise ValueError("Manifest lineage must be a positive integer")
        retention_raw = record.get("retention")
        retention: dict[str, int] | None = None
        if isinstance(retention_raw, Mapping):
            compact_after_ms = _integer(retention_raw.get("compactAfterMs"), "Manifest retention compactAfterMs")
            max_offline_duration_ms = _integer(retention_raw.get("maxOfflineDurationMs"), "Manifest retention maxOfflineDurationMs")
            if compact_after_ms <= 0 or max_offline_duration_ms <= 0:
                raise ValueError("Manifest retention durations must be positive")
            retention = {
                "compactAfterMs": compact_after_ms,
                "maxOfflineDurationMs": max_offline_duration_ms,
            }
        return cls(
            generation=_integer(record.get("generation"), "Manifest generation"),
            parent_generation=_integer(record.get("parentGeneration"), "Manifest parentGeneration"),
            written_by=_string(record.get("writtenBy"), "Manifest writtenBy"),
            written_at=_string(record.get("writtenAt"), "Manifest writtenAt"),
            content_hash=_string(record.get("contentHash"), "Manifest contentHash"),
            version=_integer(record.get("version"), "Manifest version"),
            mesh_id=_string(record.get("meshId"), "Manifest meshId"),
            schema=_integer(record.get("schema"), "Manifest schema"),
            encrypted=encrypted,
            server=dict(server),
            created_at=_string(record.get("createdAt"), "Manifest createdAt"),
            epoch=_integer(record.get("epoch"), "Manifest epoch"),
            watermark_hlc=_string(record.get("watermarkHlc"), "Manifest watermarkHlc"),
            snapshot_path=snapshot_path if isinstance(snapshot_path, str) else None,
            delta_path=delta_path if isinstance(delta_path, str) else None,
            retention=retention,
            lineage=lineage,
        )


@dataclass(frozen=True)
class ChangesHead:
    latest_hlc: str

    def to_wire(self) -> dict[str, Any]:
        return {"latestHlc": self.latest_hlc}

    @classmethod
    def from_wire(cls, value: object) -> "ChangesHead":
        record = _mapping(value, "Changes head")
        return cls(latest_hlc=_string(record.get("latestHlc"), "Changes head latestHlc"))
