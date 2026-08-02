"""Per-column CRDT merge rules used by Interocitor change entries."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from .hlc import hlc_compare_str
from .schema import MergeStrategy
from .types import ChangeEntry, ColumnEntry, DeleteOp, Op, Row, RowMeta, UpsertOp


Schema = Mapping[str, Any] | None


def _require_convergent_strategy(strategy: object, table: str, field: str) -> MergeStrategy:
    if strategy == "lww" or callable(strategy):
        return strategy  # type: ignore[return-value]
    raise ValueError(
        f"Unsupported replicated merge strategy {strategy!r} for {table}.{field}; "
        'use "lww" or a convergent custom merge'
    )


def _resolve_strategy(schema: Schema, table: str, field: str) -> MergeStrategy:
    """Implement core's field → table → database merge-strategy lookup."""

    if schema is None:
        # The TypeScript core intentionally uses LWW when there is no schema.
        return "lww"
    tables = schema.get("tables")
    table_def = tables.get(table) if isinstance(tables, Mapping) else None
    merge = table_def.get("merge") if isinstance(table_def, Mapping) else None
    if isinstance(merge, Mapping):
        # Core only recognizes a mapping as a TableMergeConfig when it carries
        # one of these keys.
        if "fields" in merge or "strategy" in merge:
            fields = merge.get("fields")
            field_strategy = fields.get(field) if isinstance(fields, Mapping) else None
            if field_strategy:
                return _require_convergent_strategy(field_strategy, table, field)
            strategy = merge.get("strategy")
            if strategy:
                return _require_convergent_strategy(strategy, table, field)
        else:
            return _require_convergent_strategy(merge, table, field)
    elif merge is not None:
        return _require_convergent_strategy(merge, table, field)
    strategy = schema.get("mergeStrategy")
    return "lww" if strategy is None else _require_convergent_strategy(strategy, table, field)


def _wire_value_equal(left: Any, right: Any) -> bool:
    """Compare decoded JSON values independently of object identity and key order."""

    if isinstance(left, bool) or isinstance(right, bool):
        return type(left) is type(right) and left is right
    left_is_number = isinstance(left, (int, float)) and not isinstance(left, bool)
    right_is_number = isinstance(right, (int, float)) and not isinstance(right, bool)
    if left_is_number or right_is_number:
        return left_is_number and right_is_number and left == right
    if isinstance(left, Mapping) or isinstance(right, Mapping):
        return (
            isinstance(left, Mapping)
            and isinstance(right, Mapping)
            and left.keys() == right.keys()
            and all(_wire_value_equal(left[key], right[key]) for key in left)
        )
    if isinstance(left, list) or isinstance(right, list):
        return (
            isinstance(left, list)
            and isinstance(right, list)
            and len(left) == len(right)
            and all(_wire_value_equal(a, b) for a, b in zip(left, right, strict=True))
        )
    return type(left) is type(right) and left == right


def _merge_column(
    local: ColumnEntry | None,
    remote: ColumnEntry,
    strategy: MergeStrategy,
    *,
    table: str,
    row_id: str,
    field: str,
) -> ColumnEntry | None:
    if local is None or not local.hlc:
        return remote
    if callable(strategy):
        result = strategy(local, remote, {"table": table, "rowId": row_id, "field": field})
        return result if result.hlc != local.hlc or not _wire_value_equal(result.value, local.value) else None
    comparison = hlc_compare_str(remote.hlc, local.hlc)
    if comparison > 0:
        return remote
    if comparison < 0:
        return None
    if not _wire_value_equal(local.value, remote.value):
        raise ValueError(f"Conflicting values share HLC {remote.hlc} at {table}/{row_id}.{field}")
    return None


def _blank_row(table: str, row_id: str, schema_version: int, *, deleted: bool = False, deleted_hlc: str | None = None) -> Row:
    return Row(
        _meta=RowMeta(
            table=table,
            row_id=row_id,
            deleted=deleted,
            deleted_hlc=deleted_hlc,
            schema_version=schema_version,
        ),
        payload={},
    )


def apply_op(
    tables: dict[str, dict[str, Row]],
    op: Op,
    schema_version: int,
    schema: Schema = None,
) -> Row | None:
    """Apply one operation in place and return the changed row, if any."""

    table = tables.setdefault(op.table, {})
    if isinstance(op, DeleteOp):
        existing = table.get(op.row_id)
        if existing is None:
            row = _blank_row(op.table, op.row_id, schema_version, deleted=True, deleted_hlc=op.hlc)
            table[op.row_id] = row
            return row
        if existing._meta.deleted_hlc and hlc_compare_str(op.hlc, existing._meta.deleted_hlc) <= 0:
            return None
        if any(entry.hlc and hlc_compare_str(entry.hlc, op.hlc) > 0 for entry in existing.payload.values()):
            return None
        existing._meta.deleted = True
        existing._meta.deleted_hlc = op.hlc
        existing.payload = {}
        return existing

    if not isinstance(op, UpsertOp):  # defensive guard if a third-party Op is supplied
        raise TypeError("Unknown Interocitor operation")
    row = table.get(op.row_id)
    changed = False
    if row is None:
        row = _blank_row(op.table, op.row_id, schema_version)
        table[op.row_id] = row
        changed = True

    columns = list(op.columns.items())
    if row._meta.deleted and row._meta.deleted_hlc:
        deleted_hlc = row._meta.deleted_hlc
        columns = [(name, entry) for name, entry in columns if hlc_compare_str(entry.hlc, deleted_hlc) > 0]
        if not columns:
            return None
        row.payload = {}
        row._meta.deleted = False
        row._meta.deleted_hlc = None
        changed = True

    for name, entry in columns:
        winner = _merge_column(
            row.payload.get(name),
            entry,
            _resolve_strategy(schema, op.table, name),
            table=op.table,
            row_id=op.row_id,
            field=name,
        )
        if winner is not None:
            row.payload[name] = winner
            changed = True
    return row if changed else None


def apply_change_entry(
    tables: dict[str, dict[str, Row]],
    entry: ChangeEntry,
    schema_version: int,
    schema: Schema = None,
) -> list[Row]:
    affected: list[Row] = []
    for operation in entry.ops:
        row = apply_op(tables, operation, schema_version, schema)
        if row is not None:
            affected.append(row)
    return affected


def read_column(row: Row, column: str) -> Any:
    entry = row.payload.get(column)
    return entry.value if entry is not None else None


def row_to_plain(row: Row) -> dict[str, Any]:
    value: dict[str, Any] = {
        "_table": row._meta.table,
        "_rowId": row._meta.row_id,
        "_deleted": row._meta.deleted,
    }
    value.update({name: entry.value for name, entry in row.payload.items()})
    return value
