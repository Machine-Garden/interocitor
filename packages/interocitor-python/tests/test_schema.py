"""Public schema declaration and core-compatible merge behavior tests."""

from __future__ import annotations

import asyncio
import json
import unittest

from interocitor import (
    ColumnEntry,
    DatabaseSchema,
    Interocitor,
    InterocitorError,
    MemoryAdapter,
    Schema,
    SchemaError,
    TableIndex,
    TableMergeConfig,
    TableSchema,
    UpsertOp,
    normalize_schema,
    types,
)
from interocitor.crdt import apply_op


_OLDER = "000000000000001-0000-remote"
_NEWER = "000000000000002-0000-local"


class SchemaDeclarationTests(unittest.TestCase):
    def test_schema_emits_the_core_structural_shape(self) -> None:
        schema = Schema(
            version=2,
            merge_strategy="lww",
            tables={
                "tasks": TableSchema(
                    fields={
                        "state": types.enum("queued", "running", "complete"),
                        "inputPath": types.string,
                        "resultPath": types.string.optional,
                        "attempt": types.index(types.number),
                        "externalId": types.unique(types.string),
                        "metadata": types.typed("json"),
                    },
                    indexes=(TableIndex("by-state", "state"),),
                    merge=TableMergeConfig(
                        strategy="lww",
                        fields={"state": "remote-wins"},
                    ),
                ),
            },
        )

        self.assertEqual(
            schema.to_dict(),
            {
                "version": 2,
                "mergeStrategy": "lww",
                "tables": {
                    "tasks": {
                        "fields": {
                            "state": {"kind": "enum"},
                            "inputPath": {"kind": "string"},
                            "resultPath": {"kind": "string", "optional": True},
                            "attempt": {"kind": "number", "index": True},
                            "externalId": {"kind": "string", "index": True, "unique": True},
                            "metadata": {"kind": "json"},
                        },
                        "indexes": [{"name": "by-state", "field": "state"}],
                        "merge": {
                            "strategy": "lww",
                            "fields": {"state": "remote-wins"},
                        },
                    },
                },
            },
        )

    def test_raw_core_shaped_mapping_accepts_python_descriptors(self) -> None:
        raw = {
            "version": 3,
            "tables": {
                "tasks": {
                    "fields": {
                        "state": types.enum("queued", "complete"),
                        "resultPath": types.string.optional,
                    },
                    "merge": {"strategy": "lww"},
                },
            },
        }

        self.assertEqual(
            normalize_schema(raw),
            {
                "version": 3,
                "tables": {
                    "tasks": {
                        "fields": {
                            "state": {"kind": "enum"},
                            "resultPath": {"kind": "string", "optional": True},
                        },
                        "merge": {"strategy": "lww"},
                    },
                },
            },
        )

    def test_schema_validates_the_declaration_not_row_payloads(self) -> None:
        async def scenario() -> None:
            mesh = Interocitor(
                schema=DatabaseSchema(
                    tables={
                        "tasks": TableSchema(
                            fields={
                                "state": types.enum("queued", "complete"),
                                "externalId": types.unique(types.string),
                            },
                            merge="lww",
                        ),
                    },
                ),
            )
            written = await mesh.table("tasks").put(
                "task-1",
                {"state": "not-listed", "applicationOnly": {"retry": True}},
            )
            self.assertEqual(written["state"], "not-listed")
            self.assertEqual(written["applicationOnly"], {"retry": True})
            duplicate = await mesh.table("tasks").put(
                "task-2",
                {"state": "queued", "externalId": "same-external-id"},
            )
            self.assertEqual(duplicate["externalId"], "same-external-id")
            duplicate_again = await mesh.table("tasks").put(
                "task-3",
                {"state": "complete", "externalId": "same-external-id"},
            )
            self.assertEqual(duplicate_again["externalId"], "same-external-id")
            await mesh.disconnect()

        asyncio.run(scenario())

    def test_invalid_schema_declarations_fail_early(self) -> None:
        with self.assertRaises(SchemaError):
            types.index(types.string.optional)
        with self.assertRaises(SchemaError):
            types.unique(types.json)
        with self.assertRaises(SchemaError):
            Schema(tables={"tasks": TableSchema(merge="not-a-strategy")})
        with self.assertRaises(SchemaError):
            normalize_schema({"version": 1})
        with self.assertRaises(SchemaError):
            normalize_schema({"version": True, "tables": {}})


class SchemaMergeTests(unittest.TestCase):
    def test_field_table_database_and_default_merge_order_matches_core(self) -> None:
        schema = Schema(
            merge_strategy="remote-wins",
            tables={
                "tasks": TableSchema(
                    merge=TableMergeConfig(
                        strategy="local-wins",
                        fields={"state": "lww"},
                    ),
                ),
                "audit": TableSchema(),
            },
        ).to_dict()
        tables = {}
        apply_op(
            tables,
            UpsertOp(
                "tasks",
                "task-1",
                {
                    "state": ColumnEntry("local-state", _NEWER),
                    "title": ColumnEntry("local-title", _NEWER),
                },
            ),
            schema_version=1,
            schema=schema,
        )
        apply_op(
            tables,
            UpsertOp(
                "tasks",
                "task-1",
                {
                    "state": ColumnEntry("remote-state", _OLDER),
                    "title": ColumnEntry("remote-title", _OLDER),
                },
            ),
            schema_version=1,
            schema=schema,
        )
        apply_op(
            tables,
            UpsertOp("audit", "event-1", {"detail": ColumnEntry("local", _NEWER)}),
            schema_version=1,
            schema=schema,
        )
        apply_op(
            tables,
            UpsertOp("audit", "event-1", {"detail": ColumnEntry("remote", _OLDER)}),
            schema_version=1,
            schema=schema,
        )

        self.assertEqual(tables["tasks"]["task-1"].payload["state"].value, "local-state")
        self.assertEqual(tables["tasks"]["task-1"].payload["title"].value, "local-title")
        self.assertEqual(tables["audit"]["event-1"].payload["detail"].value, "remote")

    def test_no_schema_is_lww_but_a_schema_defaults_to_remote_wins(self) -> None:
        def resolve(schema):
            tables = {}
            apply_op(
                tables,
                UpsertOp("tasks", "task-1", {"state": ColumnEntry("local", _NEWER)}),
                schema_version=1,
                schema=schema,
            )
            apply_op(
                tables,
                UpsertOp("tasks", "task-1", {"state": ColumnEntry("remote", _OLDER)}),
                schema_version=1,
                schema=schema,
            )
            return tables["tasks"]["task-1"].payload["state"].value

        self.assertEqual(resolve(None), "local")
        self.assertEqual(resolve(Schema(tables={"tasks": TableSchema()}).to_dict()), "remote")


class SchemaVersionTests(unittest.TestCase):
    def test_schema_version_is_the_manifest_compatibility_gate(self) -> None:
        async def scenario() -> None:
            adapter = MemoryAdapter()
            first = Interocitor(
                adapter,
                remote_path="/schema-version-mesh",
                schema=Schema(version=4, tables={"tasks": TableSchema(merge="lww")}),
            )
            await first.connect()
            manifest = json.loads(adapter.dump()["/schema-version-mesh/manifest-1.json"])
            self.assertEqual(manifest["schema"], 4)

            incompatible = Interocitor(
                adapter,
                remote_path="/schema-version-mesh",
                schema=Schema(version=5, tables={"tasks": TableSchema(merge="lww")}),
                require_existing_mesh=True,
            )
            with self.assertRaises(InterocitorError):
                await incompatible.connect()
            await first.disconnect()

        asyncio.run(scenario())
