"""End-to-end tests for the worker-oriented Python core profile."""

from __future__ import annotations

import asyncio
import hashlib
import json
import unittest

from interocitor import (
    FileSeal,
    Interocitor,
    InterocitorError,
    MemoryAdapter,
    MemoryLocalStore,
    MeshNotFoundError,
    PortablePassphraseKeySource,
    generate_portable_key,
)


_SCHEMA = {
    "version": 1,
    "tables": {
        "tasks": {
            # State transitions use LWW in this test; otherwise a configured
            # A configured schema uses the same convergent LWW default as Core.
            "merge": "lww",
        },
    },
}


class _PausingMemoryLocalStore(MemoryLocalStore):
    """Test store that holds one row read while a competing sync starts."""

    def __init__(self) -> None:
        super().__init__()
        self.pause_next_get = False
        self.get_entered = asyncio.Event()
        self.release_get = asyncio.Event()

    async def get_row(self, table: str, row_id: str):
        if self.pause_next_get:
            self.pause_next_get = False
            self.get_entered.set()
            await self.release_get.wait()
        return await super().get_row(table, row_id)


class _PausingSnapshotAdapter(MemoryAdapter):
    """Test adapter that can suspend one snapshot read for cancellation tests."""

    def __init__(self) -> None:
        super().__init__()
        self.pause_snapshot_path: str | None = None
        self.snapshot_read_started = asyncio.Event()
        self.release_snapshot_read = asyncio.Event()

    async def read_file(self, path: str) -> bytes:
        if path == self.pause_snapshot_path:
            self.snapshot_read_started.set()
            await self.release_snapshot_read.wait()
        return await super().read_file(path)


class _FailingChangeAdapter(MemoryAdapter):
    """Fails one immutable change publication, then behaves normally."""

    def __init__(self) -> None:
        super().__init__()
        self.fail_next_change = False

    async def write_file(self, path: str, data: bytes | str) -> None:
        if self.fail_next_change and "/changes/" in path and not path.endswith("/head.json"):
            self.fail_next_change = False
            raise OSError("injected change publication failure")
        await super().write_file(path, data)


class EngineTests(unittest.TestCase):
    def test_failed_publication_preserves_exact_outbox_id_for_retry(self) -> None:
        async def scenario() -> None:
            adapter = _FailingChangeAdapter()
            local = MemoryLocalStore()
            writer = Interocitor(
                adapter,
                remote_path="/failed-publication-mesh",
                local_store=local,
                schema=_SCHEMA,
                device_id="dev_writer",
            )
            reader = Interocitor(
                adapter,
                remote_path="/failed-publication-mesh",
                local_store=MemoryLocalStore(),
                schema=_SCHEMA,
                device_id="dev_reader",
                require_existing_mesh=True,
            )
            await writer.connect()
            await writer.put("tasks", "durable", {"state": "queued"})
            queued = await local.peek_outbox()
            self.assertEqual(len(queued), 1)

            adapter.fail_next_change = True
            with self.assertRaisesRegex(OSError, "injected change publication failure"):
                await writer.flush()
            self.assertEqual([entry.id for entry in await local.peek_outbox()], [queued[0].id])

            await writer.flush()
            self.assertEqual(await local.outbox_size(), 0)
            await reader.connect()
            self.assertEqual((await reader.get("tasks", "durable"))["state"], "queued")

        asyncio.run(scenario())

    def test_late_published_change_behind_global_head_is_not_lost(self) -> None:
        async def scenario() -> None:
            adapter = MemoryAdapter()
            left = Interocitor(
                adapter,
                remote_path="/late-publish-mesh",
                local_store=MemoryLocalStore(),
                schema=_SCHEMA,
                db_name="late-left",
                device_id="dev_left",
            )
            right = Interocitor(
                adapter,
                remote_path="/late-publish-mesh",
                local_store=MemoryLocalStore(),
                schema=_SCHEMA,
                db_name="late-right",
                device_id="dev_right",
            )

            await left.connect()
            await right.connect()
            await left.put("tasks", "second", {"done": False})
            await left.put("tasks", "third", {"done": False})
            await left.flush()
            await right.pull()

            await right.put("tasks", "second", {"done": True})
            await asyncio.sleep(0.002)
            await left.put("tasks", "third", {"done": True})
            await left.flush()
            await right.pull()
            await right.flush()
            await left.pull()

            self.assertEqual((await left.get("tasks", "second"))["done"], True)
            self.assertEqual((await left.get("tasks", "third"))["done"], True)
            self.assertEqual(await right.get("tasks", "second"), await left.get("tasks", "second"))

        asyncio.run(scenario())

    def test_encrypted_rows_files_and_stateless_restart(self) -> None:
        async def scenario() -> None:
            adapter = MemoryAdapter()
            portable_key = generate_portable_key()
            first = Interocitor(
                adapter,
                remote_path="/worker-mesh",
                key_source=PortablePassphraseKeySource(portable_key=portable_key, generate_if_missing=False),
                schema=_SCHEMA,
                device_id="019fa13e-cfab-7a91-b759-ca02e12e69d3",
                device_type="worker",
                require_encryption=True,
            )
            await first.connect()
            self.assertTrue(first.connected)
            self.assertTrue(first.is_encrypted())
            await first.table("tasks").patch(
                "task-1",
                {"state": "queued", "inputPath": "inputs/task-1.bin", "attempt": 1},
            )
            await first.put_file("tasks/task-1/result.bin", bytes((0, 1, 2, 255)), "application/octet-stream")
            await first.flush()

            remote = adapter.dump()
            self.assertIn("/worker-mesh/manifest.json", remote)
            stored_paths = [key for key in remote if key.startswith("/worker-mesh/files/")]
            self.assertEqual(len(stored_paths), 1)
            self.assertRegex(stored_paths[0], r"^/worker-mesh/files/[0-9a-f]{64}$")
            self.assertNotIn("result.bin", stored_paths[0])
            self.assertNotIn(b"application/octet-stream", remote[stored_paths[0]])
            self.assertNotIn(b"queued", remote["/worker-mesh/changes/head.json"])
            self.assertNotIn(b"queued", remote[stored_paths[0]])
            await first.disconnect()

            second = Interocitor(
                adapter,
                remote_path="/worker-mesh",
                key_source=PortablePassphraseKeySource(portable_key=portable_key, generate_if_missing=False),
                schema=_SCHEMA,
                device_id="019fa13e-d000-7a91-b759-ca02e12e69d3",
                device_type="worker",
                require_existing_mesh=True,
                require_encryption=True,
            )
            await second.connect()
            self.assertEqual(
                await second.table("tasks").row("task-1"),
                {
                    "_table": "tasks",
                    "_rowId": "task-1",
                    "_deleted": False,
                    "state": "queued",
                    "inputPath": "inputs/task-1.bin",
                    "attempt": 1,
                },
            )
            self.assertEqual(await second.get_file("tasks/task-1/result.bin"), bytes((0, 1, 2, 255)))
            metadata = await second.get_file_metadata("tasks/task-1/result.bin")
            self.assertIsNotNone(metadata)
            self.assertEqual(metadata.plaintext_size if metadata else None, 4)
            self.assertEqual(metadata.content_type if metadata else None, "application/octet-stream")
            self.assertEqual(metadata.digest if metadata else None, hashlib.sha256(bytes((0, 1, 2, 255))).hexdigest())
            self.assertEqual(metadata.path if metadata else None, stored_paths[0])
            await second.disconnect()

        asyncio.run(scenario())

    def test_sealed_file_needs_its_extra_key_to_open_replace_or_delete(self) -> None:
        async def scenario() -> None:
            adapter = MemoryAdapter()
            portable_key = generate_portable_key()
            mesh = Interocitor(
                adapter,
                remote_path="/sealed-mesh",
                key_source=PortablePassphraseKeySource(portable_key=portable_key, generate_if_missing=False),
                schema=_SCHEMA,
                device_id="019fa13e-cfab-7a91-b759-ca02e12e69d3",
                require_encryption=True,
            )
            await mesh.connect()
            seal = FileSeal(taint="project:alpha", key=bytes(range(32)))
            other = FileSeal(taint="project:beta", key=bytes(range(32, 64)))
            payload = b"sealed report"
            metadata = await mesh.put_file("reports/alpha.txt", payload, "text/plain", seal=seal)
            self.assertEqual(metadata.taint, "project:alpha")
            self.assertEqual(metadata.plaintext_size, len(payload))

            remote = adapter.dump()
            stored_paths = [key for key in remote if key.startswith("/sealed-mesh/files/")]
            self.assertEqual(len(stored_paths), 1)
            self.assertNotIn(b"project:alpha", remote[stored_paths[0]])
            self.assertNotIn(payload, remote[stored_paths[0]])

            with self.assertRaisesRegex(ValueError, "sealed under an extra key"):
                await mesh.get_file("reports/alpha.txt")
            sealed = await mesh.open_file("reports/alpha.txt")
            self.assertEqual(sealed.taint, "project:alpha")
            self.assertEqual(sealed.metadata.content_type, "text/plain")
            with self.assertRaisesRegex(ValueError, "sealed under an extra key"):
                sealed.open()
            with self.assertRaisesRegex(ValueError, "did not open"):
                sealed.open(other.key)
            self.assertEqual(sealed.open(seal.key), payload)

            with self.assertRaisesRegex(PermissionError, "is sealed"):
                await mesh.put_file("reports/alpha.txt", b"overwrite", "text/plain")
            with self.assertRaisesRegex(PermissionError, "is sealed"):
                await mesh.put_file("reports/alpha.txt", b"overwrite", "text/plain", seal=other)
            with self.assertRaisesRegex(PermissionError, "is sealed"):
                await mesh.delete_file("reports/alpha.txt")
            self.assertEqual((await mesh.open_file("reports/alpha.txt")).open(seal.key), payload)

            await mesh.put_file("reports/alpha.txt", b"second", "text/plain", seal=seal)
            self.assertEqual((await mesh.open_file("reports/alpha.txt")).open(seal.key), b"second")
            await mesh.delete_file("reports/alpha.txt", seal=seal)
            self.assertIsNone(await mesh.get_file_metadata("reports/alpha.txt"))

            plain = await mesh.put_file("reports/plain.txt", b"plain", "text/plain")
            self.assertIsNone(plain.taint)
            self.assertEqual((await mesh.open_file("reports/plain.txt")).open(), b"plain")
            await mesh.delete_file("reports/plain.txt")
            await mesh.disconnect()

        asyncio.run(scenario())

    def test_new_memory_worker_rehydrates_after_compaction(self) -> None:
        async def scenario() -> None:
            adapter = MemoryAdapter()
            portable_key = generate_portable_key()
            writer = Interocitor(
                adapter,
                remote_path="/compact-mesh",
                key_source=PortablePassphraseKeySource(portable_key=portable_key, generate_if_missing=False),
                schema=_SCHEMA,
                device_id="019fa13e-cfab-7a91-b759-ca02e12e69d3",
                require_encryption=True,
            )
            await writer.connect()
            await writer.put("tasks", "task-compact", {"state": "complete", "result": {"count": 3}})
            await writer.flush()
            manifest = await writer.compact()
            self.assertEqual(manifest.epoch, 1)
            self.assertIsNotNone(manifest.snapshot_path)
            compacted_wire = json.loads(
                (await adapter.read_file("/compact-mesh/manifest-2.json")).decode("utf-8")
            )
            self.assertNotIn("gcFloorHlc", compacted_wire)
            self.assertNotIn("offlineGraceMs", compacted_wire)
            await writer.disconnect()

            worker = Interocitor(
                adapter,
                remote_path="/compact-mesh",
                key_source=PortablePassphraseKeySource(portable_key=portable_key, generate_if_missing=False),
                schema=_SCHEMA,
                device_id="019fa13e-d000-7a91-b759-ca02e12e69d3",
                require_existing_mesh=True,
                require_encryption=True,
            )
            await worker.connect()
            row = await worker.get("tasks", "task-compact")
            self.assertIsNotNone(row)
            self.assertEqual(row["state"] if row else None, "complete")
            self.assertEqual(row["result"] if row else None, {"count": 3})
            await worker.disconnect()

        asyncio.run(scenario())

    def test_existing_mesh_guard_does_not_bootstrap_a_typo(self) -> None:
        async def scenario() -> None:
            worker = Interocitor(
                MemoryAdapter(),
                remote_path="/missing",
                key_source=PortablePassphraseKeySource(portable_key=generate_portable_key(), generate_if_missing=False),
                require_existing_mesh=True,
                require_encryption=True,
            )
            with self.assertRaises(MeshNotFoundError):
                await worker.connect()

        asyncio.run(scenario())

    def test_live_worker_rehydrates_when_a_remote_manifest_epoch_advances(self) -> None:
        async def scenario() -> None:
            adapter = MemoryAdapter()
            portable_key = generate_portable_key()
            writer = Interocitor(
                adapter,
                remote_path="/live-compact-mesh",
                key_source=PortablePassphraseKeySource(portable_key=portable_key, generate_if_missing=False),
                schema=_SCHEMA,
                device_id="019fa13e-cfab-7a91-b759-ca02e12e69d3",
                require_encryption=True,
            )
            reader = Interocitor(
                adapter,
                remote_path="/live-compact-mesh",
                key_source=PortablePassphraseKeySource(portable_key=portable_key, generate_if_missing=False),
                schema=_SCHEMA,
                device_id="019fa13e-d000-7a91-b759-ca02e12e69d3",
                require_existing_mesh=True,
                require_encryption=True,
            )
            await writer.connect()
            await writer.put("tasks", "task-live", {"state": "queued"})
            await writer.flush()
            await reader.connect()
            self.assertEqual((await reader.get("tasks", "task-live"))["state"], "queued")

            await writer.put("tasks", "task-live", {"state": "complete"})
            await writer.flush()
            await writer.compact()
            await reader.pull()
            self.assertEqual((await reader.get("tasks", "task-live"))["state"], "complete")
            reader_metadata = json.loads(
                (await adapter.read_file(f"/live-compact-mesh/devices/{reader.get_device_id()}.json")).decode("utf-8")
            )
            reader_manifest = reader.get_manifest()
            self.assertIsNotNone(reader_manifest)
            self.assertEqual(reader_metadata["observedManifestGeneration"], reader_manifest.generation)
            self.assertEqual(reader_metadata["observedEpoch"], reader_manifest.epoch)
            self.assertEqual(reader_metadata["observedWatermarkHlc"], reader_manifest.watermark_hlc)
            await reader.disconnect()
            await writer.disconnect()

        asyncio.run(scenario())

    def test_preconnect_mutation_is_rebased_over_a_compacted_mesh(self) -> None:
        async def scenario() -> None:
            adapter = MemoryAdapter()
            portable_key = generate_portable_key()
            writer = Interocitor(
                adapter,
                remote_path="/preconnect-rebase-mesh",
                key_source=PortablePassphraseKeySource(portable_key=portable_key, generate_if_missing=False),
                schema=_SCHEMA,
                device_id="019fa13e-cfab-7a91-b759-ca02e12e69d3",
                require_encryption=True,
            )
            await writer.connect()
            await writer.put("tasks", "remote-task", {"state": "complete"})
            await writer.flush()
            await writer.compact()
            await writer.disconnect()

            joining_worker = Interocitor(
                adapter,
                remote_path="/preconnect-rebase-mesh",
                key_source=PortablePassphraseKeySource(portable_key=portable_key, generate_if_missing=False),
                schema=_SCHEMA,
                device_id="019fa13e-d000-7a91-b759-ca02e12e69d3",
                require_existing_mesh=True,
                require_encryption=True,
            )
            await joining_worker.put("tasks", "queued-before-connect", {"state": "queued"})
            await joining_worker.connect()
            self.assertEqual((await joining_worker.get("tasks", "queued-before-connect"))["state"], "queued")
            await joining_worker.flush()
            await joining_worker.disconnect()

            verifier = Interocitor(
                adapter,
                remote_path="/preconnect-rebase-mesh",
                key_source=PortablePassphraseKeySource(portable_key=portable_key, generate_if_missing=False),
                schema=_SCHEMA,
                device_id="019fa13e-d100-7a91-b759-ca02e12e69d3",
                require_existing_mesh=True,
                require_encryption=True,
            )
            await verifier.connect()
            self.assertEqual((await verifier.get("tasks", "remote-task"))["state"], "complete")
            self.assertEqual((await verifier.get("tasks", "queued-before-connect"))["state"], "queued")
            await verifier.disconnect()

        asyncio.run(scenario())

    def test_pull_waits_for_an_inflight_row_mutation_before_rehydrating(self) -> None:
        async def scenario() -> None:
            adapter = MemoryAdapter()
            portable_key = generate_portable_key()
            writer = Interocitor(
                adapter,
                remote_path="/state-lock-mesh",
                key_source=PortablePassphraseKeySource(portable_key=portable_key, generate_if_missing=False),
                schema=_SCHEMA,
                device_id="019fa13e-cfab-7a91-b759-ca02e12e69d3",
                require_encryption=True,
            )
            local = _PausingMemoryLocalStore()
            worker = Interocitor(
                adapter,
                remote_path="/state-lock-mesh",
                local_store=local,
                key_source=PortablePassphraseKeySource(portable_key=portable_key, generate_if_missing=False),
                schema=_SCHEMA,
                device_id="019fa13e-d000-7a91-b759-ca02e12e69d3",
                require_existing_mesh=True,
                require_encryption=True,
            )
            await writer.connect()
            await worker.connect()
            await writer.put("tasks", "remote", {"state": "complete"})
            await writer.flush()
            await writer.compact()

            local.pause_next_get = True
            put_task = asyncio.create_task(worker.put("tasks", "local", {"state": "queued"}))
            await asyncio.wait_for(local.get_entered.wait(), timeout=1)
            pull_task = asyncio.create_task(worker.pull())
            await asyncio.sleep(0)
            self.assertFalse(pull_task.done(), "pull must wait for the state-mutating put()")

            local.release_get.set()
            await put_task
            await pull_task
            self.assertEqual((await worker.get("tasks", "local"))["state"], "queued")
            await worker.flush()
            await worker.disconnect()

            verifier = Interocitor(
                adapter,
                remote_path="/state-lock-mesh",
                key_source=PortablePassphraseKeySource(portable_key=portable_key, generate_if_missing=False),
                schema=_SCHEMA,
                device_id="019fa13e-d100-7a91-b759-ca02e12e69d3",
                require_existing_mesh=True,
                require_encryption=True,
            )
            await verifier.connect()
            self.assertEqual((await verifier.get("tasks", "local"))["state"], "queued")
            await verifier.disconnect()
            await writer.disconnect()

        asyncio.run(scenario())

    def test_older_offline_outbox_publishes_after_multiple_compactions(self) -> None:
        async def scenario() -> None:
            adapter = MemoryAdapter()
            portable_key = generate_portable_key()
            writer = Interocitor(
                adapter,
                remote_path="/offline-recovery-mesh",
                key_source=PortablePassphraseKeySource(portable_key=portable_key, generate_if_missing=False),
                schema=_SCHEMA,
                device_id="019fa13e-efab-7a91-b759-ca02e12e69d3",
                require_encryption=True,
            )
            stale_store = MemoryLocalStore()
            stale_worker = Interocitor(
                adapter,
                remote_path="/offline-recovery-mesh",
                local_store=stale_store,
                key_source=PortablePassphraseKeySource(portable_key=portable_key, generate_if_missing=False),
                schema=_SCHEMA,
                device_id="019fa13e-d000-7a91-b759-ca02e12e69d3",
                require_existing_mesh=True,
                require_encryption=True,
            )
            await writer.connect()
            await writer.put("tasks", "initial", {"state": "queued"})
            await writer.flush()
            await stale_worker.connect()

            # Give both active devices the first watermark, then queue a
            # local-only write whose HLC will fall behind the next watermark.
            await writer.compact()
            await stale_worker.pull()
            await stale_worker.put("tasks", "stale", {"state": "queued"})
            await asyncio.sleep(0.01)
            await writer.put("tasks", "newer", {"state": "complete"})
            await writer.flush()
            await writer.compact()

            # Epoch recovery publishes the durable offline outbox before it
            # replaces local rows from the newer snapshot. Its older HLC is
            # never treated as a publication cutoff.
            await stale_worker.pull()
            await writer.compact()
            self.assertEqual(await stale_store.outbox_size(), 0)

            await stale_worker.flush()
            self.assertEqual(await stale_store.outbox_size(), 0)
            await writer.pull()
            self.assertEqual((await writer.get("tasks", "stale"))["state"], "queued")
            await stale_worker.disconnect()
            await writer.disconnect()

        asyncio.run(scenario())

    def test_cancelled_rehydrate_preserves_a_preconnect_mutation(self) -> None:
        async def scenario() -> None:
            adapter = _PausingSnapshotAdapter()
            portable_key = generate_portable_key()
            writer = Interocitor(
                adapter,
                remote_path="/cancelled-rehydrate-mesh",
                key_source=PortablePassphraseKeySource(portable_key=portable_key, generate_if_missing=False),
                schema=_SCHEMA,
                device_id="019fa13e-cfab-7a91-b759-ca02e12e69d3",
                require_encryption=True,
            )
            await writer.connect()
            await writer.put("tasks", "remote", {"state": "complete"})
            await writer.flush()
            manifest = await writer.compact()

            local = MemoryLocalStore()
            worker = Interocitor(
                adapter,
                remote_path="/cancelled-rehydrate-mesh",
                local_store=local,
                key_source=PortablePassphraseKeySource(portable_key=portable_key, generate_if_missing=False),
                schema=_SCHEMA,
                device_id="019fa13e-d000-7a91-b759-ca02e12e69d3",
                require_existing_mesh=True,
                require_encryption=True,
            )
            await worker.put("tasks", "queued-before-connect", {"state": "queued"})
            adapter.pause_snapshot_path = manifest.snapshot_path
            connect_task = asyncio.create_task(worker.connect())
            await asyncio.wait_for(adapter.snapshot_read_started.wait(), timeout=1)
            connect_task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await connect_task
            self.assertFalse(worker.connected)
            self.assertEqual(await local.outbox_size(), 0)

            # Publication completed before snapshot replacement began, so
            # cancellation cannot strand or discard the queued mutation.
            # Cancellation is not remote corruption; retrying pulls the
            # already-durable change normally.
            adapter.release_snapshot_read.set()
            await worker.connect()
            await worker.flush()
            self.assertEqual(await local.outbox_size(), 0)
            self.assertEqual((await worker.get("tasks", "queued-before-connect"))["state"], "queued")
            await worker.disconnect()
            await writer.disconnect()

        asyncio.run(scenario())

    def test_managed_mesh_rejects_a_manifest_from_an_unconfigured_writer(self) -> None:
        async def scenario() -> None:
            adapter = MemoryAdapter()
            portable_key = generate_portable_key()
            trusted = Interocitor(
                adapter,
                remote_path="/managed-mesh",
                key_source=PortablePassphraseKeySource(portable_key=portable_key, generate_if_missing=False),
                server_managed=True,
                server_id="trusted-server",
                require_encryption=True,
            )
            await trusted.connect()
            await trusted.disconnect()

            manifest_path = "/managed-mesh/manifest-1.json"
            manifest = json.loads((await adapter.read_file(manifest_path)).decode("utf-8"))
            manifest["writtenBy"] = "untrusted-server"
            body = {name: value for name, value in manifest.items() if name != "contentHash"}
            manifest["contentHash"] = "sha256:" + hashlib.sha256(
                json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            ).hexdigest()
            await adapter.write_file(manifest_path, json.dumps(manifest, separators=(",", ":")))

            worker = Interocitor(
                adapter,
                remote_path="/managed-mesh",
                key_source=PortablePassphraseKeySource(portable_key=portable_key, generate_if_missing=False),
                server_id="trusted-server",
                require_existing_mesh=True,
                require_encryption=True,
            )
            with self.assertRaisesRegex(InterocitorError, "Unauthorized manifest writer"):
                await worker.connect()

        asyncio.run(scenario())

    def test_corrupt_remote_change_poison_stops_future_flushes(self) -> None:
        async def scenario() -> None:
            adapter = MemoryAdapter()
            portable_key = generate_portable_key()
            worker = Interocitor(
                adapter,
                remote_path="/poisoned-mesh",
                key_source=PortablePassphraseKeySource(portable_key=portable_key, generate_if_missing=False),
                device_id="019fa13e-cfab-7a91-b759-ca02e12e69d3",
                require_encryption=True,
            )
            await worker.connect()
            corrupt_hlc = "999999999999999-0000-remote-corruption"
            await adapter.write_file(
                f"/poisoned-mesh/changes/{corrupt_hlc}-chg_corrupt.json",
                b"not an encrypted Interocitor change",
            )
            await adapter.write_file(
                "/poisoned-mesh/changes/head.json",
                json.dumps({"latestHlc": corrupt_hlc}),
            )

            with self.assertRaises(InterocitorError):
                await worker.pull()
            self.assertFalse(worker.connected)
            await worker.put("tasks", "local-after-poison", {"state": "queued"})
            with self.assertRaises(InterocitorError):
                await worker.flush()

        asyncio.run(scenario())

    def test_compaction_removes_exactly_covered_changes_and_has_no_scalar_gc_floor(self) -> None:
        async def scenario() -> None:
            adapter = MemoryAdapter()
            portable_key = generate_portable_key()
            writer = Interocitor(
                adapter,
                remote_path="/gc-mesh",
                key_source=PortablePassphraseKeySource(portable_key=portable_key, generate_if_missing=False),
                schema=_SCHEMA,
                device_id="019fa13e-cfab-7a91-b759-ca02e12e69d3",
                require_encryption=True,
            )
            reader = Interocitor(
                adapter,
                remote_path="/gc-mesh",
                key_source=PortablePassphraseKeySource(portable_key=portable_key, generate_if_missing=False),
                schema=_SCHEMA,
                device_id="019fa13e-d000-7a91-b759-ca02e12e69d3",
                require_existing_mesh=True,
                require_encryption=True,
            )
            await writer.connect()
            await writer.put("tasks", "deleted-task", {"state": "queued"})
            await writer.flush()
            await writer.delete("tasks", "deleted-task")
            await writer.flush()
            await reader.connect()

            await writer.compact()
            await reader.pull()
            second = await writer.compact()
            wire = json.loads((await adapter.read_file(f"/gc-mesh/manifest-{second.generation}.json")).decode("utf-8"))
            self.assertNotIn("gcFloorHlc", wire)
            changes = await adapter.list_files("/gc-mesh/changes")
            self.assertEqual(len([entry for entry in changes if "-chg_" in entry.name]), 0)
            snapshots = await adapter.list_files("/gc-mesh/mainline")
            self.assertEqual([entry.path for entry in snapshots], [second.snapshot_path])
            await reader._rehydrate()
            self.assertIsNone(await reader.get("tasks", "deleted-task"))
            await reader.disconnect()
            await writer.disconnect()

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
