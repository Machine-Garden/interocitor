"""Focused protocol edge-case tests for the native Python core."""

from __future__ import annotations

import asyncio
import unittest
from functools import cmp_to_key

from interocitor import (
    ColumnEntry,
    HLC,
    MemoryLocalStore,
    Row,
    RowMeta,
    UpsertOp,
    hlc_compare,
    hlc_compare_str,
    hlc_parse,
    hlc_receive,
    hlc_serialize,
)
from interocitor.adapters import FileEntry
from interocitor.crdt import apply_op
from interocitor.engine import _compare_change_files


class HlcProtocolTests(unittest.TestCase):
    def test_canonical_hlc_round_trip_and_javascript_comparison_rules(self) -> None:
        clock = hlc_parse("001785108800123-0002-dev_node_fixture")
        self.assertEqual(hlc_serialize(clock), "001785108800123-0002-dev_node_fixture")
        self.assertEqual(
            HLC.from_wire({"ts": 1785108800123, "counter": 2, "nodeId": "dev_node_fixture"}).to_wire(),
            {"ts": 1785108800123, "counter": 2, "nodeId": "dev_node_fixture"},
        )
        self.assertEqual(hlc_compare(HLC(100, 0, "a"), HLC(200, 0, "a")), -100)
        self.assertLess(hlc_compare_str("000000000000001-0000-😀", "000000000000001-0000-\uffff"), 0)

    def test_hlc_rejects_ambiguous_or_noncanonical_wire_values(self) -> None:
        for value in (
            " 001785108800123-0002-node",
            "001785108800123-0x10-node",
            "001785108800123-000G-node",
            "001785108800123-0002-",
            "1_2-0002-node",
            "9999999999999999-0002-node",
        ):
            with self.subTest(value=value), self.assertRaises(ValueError):
                hlc_parse(value)

    def test_future_skew_receive_branches_match_core(self) -> None:
        self.assertEqual(
            hlc_receive(HLC(1000, 0, "local"), HLC(999999, 7, "remote"), now_ms=1000),
            HLC(301000, 8, "local"),
        )
        self.assertEqual(
            hlc_receive(HLC(301000, 2, "local"), HLC(999999, 999, "remote"), now_ms=1000),
            HLC(301000, 3, "local"),
        )


class CrdtProtocolTests(unittest.TestCase):
    def test_custom_merge_uses_javascript_strict_value_equality(self) -> None:
        tables = {}
        stamp = "000000000000001-0000-device"
        apply_op(
            tables,
            UpsertOp("tasks", "task-1", {"done": ColumnEntry(True, stamp)}),
            schema_version=1,
        )

        def preserve_hlc_but_change_python_type(_local, remote, _context):
            return ColumnEntry(1, remote.hlc)

        changed = apply_op(
            tables,
            UpsertOp("tasks", "task-1", {"done": ColumnEntry(1, stamp)}),
            schema_version=1,
            schema={"tables": {"tasks": {"merge": preserve_hlc_but_change_python_type}}},
        )
        self.assertIsNotNone(changed)
        self.assertIs(type(tables["tasks"]["task-1"].payload["done"].value), int)

    def test_strategy_only_table_config_matches_core(self) -> None:
        tables = {}
        schema = {"tables": {"tasks": {"merge": {"strategy": "remote-wins"}}}}
        apply_op(
            tables,
            UpsertOp("tasks", "task-1", {"state": ColumnEntry("local-newer", "000000000000002-0000-local")}),
            schema_version=1,
            schema=schema,
        )
        apply_op(
            tables,
            UpsertOp("tasks", "task-1", {"state": ColumnEntry("remote-older", "000000000000001-0000-remote")}),
            schema_version=1,
            schema=schema,
        )
        self.assertEqual(tables["tasks"]["task-1"].payload["state"].value, "remote-older")

    def test_unrecognised_table_merge_mapping_falls_back_to_lww_like_core(self) -> None:
        tables = {}
        schema = {"tables": {"tasks": {"merge": {}}}}
        apply_op(
            tables,
            UpsertOp("tasks", "task-1", {"state": ColumnEntry("local-newer", "000000000000002-0000-local")}),
            schema_version=1,
            schema=schema,
        )
        apply_op(
            tables,
            UpsertOp("tasks", "task-1", {"state": ColumnEntry("remote-older", "000000000000001-0000-remote")}),
            schema_version=1,
            schema=schema,
        )
        self.assertEqual(tables["tasks"]["task-1"].payload["state"].value, "local-newer")


class ChangeFileOrderingTests(unittest.TestCase):
    def test_change_files_use_hlc_order_not_locale_collation(self) -> None:
        upper = "000000000000001-0000-A-chg_upper.json"
        lower = "000000000000001-0000-a-chg_lower.json"
        files = [
            FileEntry(lower, f"/changes/{lower}", 0, "2026-01-01T00:00:00.000Z"),
            FileEntry(upper, f"/changes/{upper}", 0, "2026-01-01T00:00:00.000Z"),
        ]
        ordered = sorted(files, key=cmp_to_key(_compare_change_files))
        self.assertEqual([item.name for item in ordered], [upper, lower])


class MemoryStoreProtocolTests(unittest.TestCase):
    def test_put_row_keeps_store_metadata_off_the_caller_row(self) -> None:
        async def scenario() -> None:
            store = MemoryLocalStore()
            row = Row(
                _meta=RowMeta(table="tasks", row_id="task-1", deleted=False, schema_version=1),
                payload={"state": ColumnEntry("queued", "000000000000001-0000-worker")},
            )
            await store.put_row(row)
            stored = await store.get_row("tasks", "task-1")
            self.assertIsNotNone(stored)
            self.assertIsNone(row._meta.key)
            self.assertEqual(stored._meta.key if stored else None, "tasks/task-1")
            self.assertIsNot(stored, row)
            self.assertIsNot(stored._meta if stored else None, row._meta)
            self.assertIs(stored.payload if stored else None, row.payload)

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
