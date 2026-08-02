"""Volatile local store matching core's ``MemoryLocalStore`` lifecycle."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import replace
from datetime import datetime
from typing import Any

from .types import ChangeEntry, Row


def _row_key(table: str, row_id: str) -> str:
    return f"{table}/{row_id}"


def _compare(left: object, right: object) -> int:
    if isinstance(left, datetime):
        left = left.timestamp()
    if isinstance(right, datetime):
        right = right.timestamp()
    if left < right:  # type: ignore[operator]
        return -1
    if left > right:  # type: ignore[operator]
        return 1
    return 0


def _matches(value: object, clause: Mapping[str, Any]) -> bool:
    if value is None:
        return False
    operator = clause.get("op")
    if operator == "equals":
        return _compare(value, clause.get("value")) == 0
    if operator == "above":
        return _compare(value, clause.get("value")) > 0
    if operator == "aboveOrEqual":
        return _compare(value, clause.get("value")) >= 0
    if operator == "below":
        return _compare(value, clause.get("value")) < 0
    if operator == "belowOrEqual":
        return _compare(value, clause.get("value")) <= 0
    if operator == "between":
        lower = _compare(value, clause.get("lower"))
        upper = _compare(value, clause.get("upper"))
        return (lower > 0 if clause.get("lowerOpen") else lower >= 0) and (
            upper < 0 if clause.get("upperOpen") else upper <= 0
        )
    if operator == "startsWith":
        return isinstance(value, str) and value.startswith(str(clause.get("value", "")))
    if operator == "anyOf":
        values = clause.get("values")
        return isinstance(values, list) and any(_compare(value, item) == 0 for item in values)
    return False


class MemoryLocalStore:
    """A no-persistence local store for one process or one job invocation.

    Closing deliberately clears rows, outbox, cursors, and metadata—the same
    safety boundary as the TypeScript core's memory store.
    """

    def __init__(self) -> None:
        self._rows: dict[str, Row] = {}
        self._outbox: list[ChangeEntry] = []
        self._cursors: dict[str, int] = {}
        self._meta: dict[str, object] = {}

    async def open(self) -> None:
        return None

    def close(self) -> None:
        self._rows.clear()
        self._outbox.clear()
        self._cursors.clear()
        self._meta.clear()

    async def get_row(self, table: str, row_id: str) -> Row | None:
        return self._rows.get(_row_key(table, row_id))

    async def put_row(self, row: Row) -> None:
        key = _row_key(row._meta.table, row._meta.row_id)
        # Match core's in-memory store: the store-derived composite key belongs
        # to its retained metadata clone, not to the caller-owned Row object.
        self._rows[key] = Row(_meta=replace(row._meta, key=key), payload=row.payload)

    async def put_rows(self, rows: list[Row]) -> None:
        for row in rows:
            await self.put_row(row)

    async def get_table(self, table: str) -> list[Row]:
        return [row for row in self._rows.values() if row._meta.table == table and not row._meta.deleted]

    async def query_where(self, table: str, clause: Mapping[str, Any]) -> list[Row]:
        rows = await self.get_table(table)
        field = clause.get("field")
        if not isinstance(field, str):
            raise ValueError("Where clause field must be a string")
        return [row for row in rows if _matches(row.payload.get(field).value if field in row.payload else None, clause)]

    async def get_table_names(self) -> list[str]:
        return list(dict.fromkeys(row._meta.table for row in self._rows.values()))

    async def get_all_rows(self) -> list[Row]:
        return list(self._rows.values())

    async def clear_rows(self) -> None:
        self._rows.clear()

    async def push_outbox(self, entry: ChangeEntry) -> None:
        self._outbox.append(entry)

    async def push_outbox_entries(self, entries: list[ChangeEntry]) -> None:
        self._outbox.extend(entries)

    async def drain_outbox(self) -> list[ChangeEntry]:
        entries = self._outbox
        self._outbox = []
        return entries

    async def outbox_size(self) -> int:
        return len(self._outbox)

    async def get_cursor(self, device_id: str) -> int:
        return self._cursors.get(device_id, 0)

    async def set_cursor(self, device_id: str, offset: int) -> None:
        self._cursors[device_id] = offset

    async def get_all_cursors(self) -> dict[str, int]:
        return dict(self._cursors)

    async def get_meta(self, key: str) -> object | None:
        return self._meta.get(key)

    async def set_meta(self, key: str, value: object) -> None:
        self._meta[key] = value

    async def clear_all(self) -> None:
        self._rows.clear()
        self._outbox.clear()
        self._cursors.clear()
        self._meta.clear()
