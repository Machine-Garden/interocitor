"""Cross-language wire compatibility against a built ``@interocitor/core``.

This test deliberately invokes the local Node build instead of relying only on
checked-in ciphertext vectors.  It covers both directions:

* Node encrypts envelopes and payloads that Python decodes and reserializes.
* Python encrypts those same wire payloads and Node decodes them.

Run after building core, from any working directory::

    yarn workspace @interocitor/core build
    PYTHONPATH=packages/interocitor-python/src python3 -m unittest \
      packages/interocitor-python/tests/test_node_interop.py
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import unittest
from typing import Any

from interocitor.crypto import decrypt_bytes, decrypt_entry, encrypt_bytes, encrypt_entry
from interocitor.types import Manifest, MeshChangePayload, MeshSnapshotPayload


_REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
_CORE_DIST = _REPOSITORY_ROOT / "packages" / "core" / "dist"
_RAW_KEY = bytes(range(32))
_NODE_TIMEOUT_SECONDS = 30


_NODE_EMIT_ARTIFACTS = r"""
import { webcrypto } from "node:crypto";
import { pathToFileURL } from "node:url";
import path from "node:path";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const dist = process.env.INTEROCITOR_CORE_DIST;
const moduleAt = (relative) => pathToFileURL(path.join(dist, relative)).href;
const encryption = await import(moduleAt("crypto/encryption.js"));
const codec = await import(moduleAt("core/codec.js"));
const internals = await import(moduleAt("core/internals.js"));
const rawKey = Uint8Array.from({ length: 32 }, (_, index) => index);
const key = await encryption.importKeyRaw(rawKey);

const meshId = "mesh_node_python_fixture";
const change = {
  meshId,
  kind: "change",
  entry: {
    id: "chg_019fa13e-cfab-7a91-b759-ca02e12e69d3",
    ts: 1785108800123,
    device: "dev_node_fixture",
    user: "worker-fixture",
    hlc: "001785108800123-0002-dev_node_fixture",
    ops: [
      {
        type: "upsert",
        table: "tasks",
        rowId: "task_alpha",
        columns: {
          title: { value: "Ship the Python worker", hlc: "001785108800123-0001-dev_node_fixture" },
          state: { value: "queued", hlc: "001785108800123-0002-dev_node_fixture" },
          metadata: {
            value: { attempt: 1, labels: ["interop", "🚀"] },
            hlc: "001785108800123-0002-dev_node_fixture",
          },
        },
      },
      {
        type: "delete",
        table: "tasks",
        rowId: "task_retired",
        hlc: "001785108800124-0000-dev_node_fixture",
      },
    ],
  },
};

const snapshot = {
  meshId,
  kind: "snapshot",
  snapshot: {
    snapshotId: "snap_019fa13e-cfab-7a91-b759-ca02e12e69d3",
    timestamp: "2026-07-27T00:00:00.000Z",
    hlc: "001785108800124-0000-dev_node_fixture",
    epoch: 4,
    schemaVersion: 2,
    tables: {
      tasks: {
        task_alpha: {
          _meta: {
            table: "tasks",
            rowId: "task_alpha",
            deleted: false,
            schemaVersion: 2,
            owner: "dev_node_fixture",
          },
          payload: {
            title: { value: "Ship the Python worker", hlc: "001785108800123-0001-dev_node_fixture" },
            state: { value: "queued", hlc: "001785108800123-0002-dev_node_fixture" },
            metadata: {
              value: { attempt: 1, labels: ["interop", "🚀"] },
              hlc: "001785108800123-0002-dev_node_fixture",
            },
          },
        },
        task_retired: {
          _meta: {
            table: "tasks",
            rowId: "task_retired",
            deleted: true,
            deletedHlc: "001785108800124-0000-dev_node_fixture",
            schemaVersion: 2,
          },
          payload: {},
        },
      },
    },
  },
};

const manifestBody = {
  generation: 7,
  parentGeneration: 6,
  writtenBy: "server_node_fixture",
  writtenAt: "2026-07-27T00:00:00.000Z",
  version: 3,
  meshId,
  schema: 2,
  encrypted: true,
  server: {
    managed: false,
    relayUrl: null,
    serverId: "server_node_fixture",
  },
  createdAt: "2026-07-26T23:00:00.000Z",
  epoch: 4,
  watermarkHlc: "001785108800124-0000-dev_node_fixture",
  snapshotPath: "/worker-fixture/mainline/snap_019fa13e-cfab-7a91-b759-ca02e12e69d3.json",
  deltaPath: null,
};
const manifest = {
  ...manifestBody,
  contentHash: await internals.computeContentHash(manifestBody),
};
const state = { encryptionKey: key, encrypted: true, manifest: { meshId } };

process.stdout.write(JSON.stringify({
  entryEnvelope: await encryption.encryptEntry(key, "hello from @interocitor/core 🛰️"),
  bytesEnvelope: new TextDecoder().decode(
    await encryption.encryptBytes(key, Uint8Array.of(0, 1, 2, 255, 128, 64)),
  ),
  changeEnvelope: await codec.encodeChangePayload(state, change.entry),
  snapshotEnvelope: await codec.encodeSnapshotPayload(state, snapshot.snapshot),
  manifest,
}));
"""


_NODE_VERIFY_PYTHON_ARTIFACTS = r"""
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { pathToFileURL } from "node:url";
import path from "node:path";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const dist = process.env.INTEROCITOR_CORE_DIST;
const encryption = await import(pathToFileURL(path.join(dist, "crypto/encryption.js")).href);
const codec = await import(pathToFileURL(path.join(dist, "core/codec.js")).href);
const input = JSON.parse(readFileSync(0, "utf8"));
const rawKey = Uint8Array.from(Buffer.from(input.rawKey, "base64"));
const key = await encryption.importKeyRaw(rawKey);
const meshId = "mesh_node_python_fixture";
const state = { encryptionKey: key, encrypted: true, manifest: { meshId } };
const local = {
  async getMeta() { return undefined; },
  async setMeta() {},
};
const changeEntry = await codec.decodeChangePayload(state, local, input.changeEnvelope, "/changes/python.json");
const snapshot = await codec.decodeSnapshotPayload(state, local, input.snapshotEnvelope, "/mainline/python.json");

process.stdout.write(JSON.stringify({
  entry: await encryption.decryptEntry(key, input.entryEnvelope),
  bytes: Array.from(await encryption.decryptBytes(key, new TextEncoder().encode(input.bytesEnvelope))),
  change: { meshId, kind: "change", entry: changeEntry },
  snapshot: { meshId, kind: "snapshot", snapshot },
}));
"""


def _compact_json(value: object) -> str:
    """Use the JSON spelling used by ``JSON.stringify`` for these vectors."""

    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


class NodeCoreInteropTests(unittest.TestCase):
    """Validate the Python wire model against the current built Node core."""

    @classmethod
    def setUpClass(cls) -> None:
        super().setUpClass()
        cls._node = shutil.which("node")
        if cls._node is None:
            raise unittest.SkipTest("Node.js is required for @interocitor/core interoperability tests")

        required_modules = (
            _CORE_DIST / "crypto" / "encryption.js",
            _CORE_DIST / "core" / "codec.js",
            _CORE_DIST / "core" / "internals.js",
        )
        missing = [str(module.relative_to(_REPOSITORY_ROOT)) for module in required_modules if not module.is_file()]
        if missing:
            raise unittest.SkipTest(
                "Built @interocitor/core is required; run "
                "`yarn workspace @interocitor/core build` first (missing: "
                + ", ".join(missing)
                + ")"
            )

    def _run_node(self, script: str, payload: dict[str, object] | None = None) -> dict[str, Any]:
        environment = os.environ.copy()
        environment["INTEROCITOR_CORE_DIST"] = str(_CORE_DIST)
        completed = subprocess.run(
            [self._node, "--input-type=module", "--eval", script],
            cwd=_REPOSITORY_ROOT,
            env=environment,
            input=_compact_json(payload) if payload is not None else None,
            text=True,
            capture_output=True,
            timeout=_NODE_TIMEOUT_SECONDS,
            check=False,
        )
        if completed.returncode:
            self.fail(
                "Node interoperability helper failed "
                f"(exit {completed.returncode}):\n{completed.stderr}\n{completed.stdout}"
            )
        try:
            result = json.loads(completed.stdout)
        except json.JSONDecodeError as error:
            self.fail(f"Node interoperability helper did not return JSON: {error}: {completed.stdout!r}")
        if not isinstance(result, dict):
            self.fail(f"Node interoperability helper returned {type(result).__name__}, not an object")
        return result

    def test_core_artifacts_round_trip_through_python_protocol(self) -> None:
        """Python reads Node envelopes, change/snapshot payloads, and a manifest."""

        artifacts = self._run_node(_NODE_EMIT_ARTIFACTS)

        self.assertEqual(
            decrypt_entry(_RAW_KEY, artifacts["entryEnvelope"]),
            "hello from @interocitor/core 🛰️",
        )
        self.assertEqual(
            decrypt_bytes(_RAW_KEY, artifacts["bytesEnvelope"]),
            bytes((0, 1, 2, 255, 128, 64)),
        )

        change_wire = json.loads(decrypt_entry(_RAW_KEY, artifacts["changeEnvelope"]))
        snapshot_wire = json.loads(decrypt_entry(_RAW_KEY, artifacts["snapshotEnvelope"]))
        manifest_wire = artifacts["manifest"]

        change = MeshChangePayload.from_wire(change_wire)
        snapshot = MeshSnapshotPayload.from_wire(snapshot_wire)
        manifest = Manifest.from_wire(manifest_wire)

        self.assertEqual(change.to_wire(), change_wire)
        self.assertEqual(snapshot.to_wire(), snapshot_wire)
        self.assertEqual(manifest.to_wire(), manifest_wire)
        self.assertEqual(_compact_json(change.to_wire()), _compact_json(change_wire))
        self.assertEqual(_compact_json(snapshot.to_wire()), _compact_json(snapshot_wire))
        self.assertEqual(_compact_json(manifest.to_wire()), _compact_json(manifest_wire))

        # ``computeContentHash`` hashes the exact compact JSON body before
        # appending ``contentHash``.  Preserve received key order so this also
        # detects a Python writer that reorders wire keys.
        manifest_body = {key: value for key, value in manifest_wire.items() if key != "contentHash"}
        expected_hash = "sha256:" + hashlib.sha256(_compact_json(manifest_body).encode("utf-8")).hexdigest()
        self.assertEqual(manifest_wire["contentHash"], expected_hash)

    def test_node_core_decrypts_python_protocol_artifacts(self) -> None:
        """Node accepts Python AES-GCM envelopes containing its own wire shapes."""

        artifacts = self._run_node(_NODE_EMIT_ARTIFACTS)
        change = MeshChangePayload.from_wire(json.loads(decrypt_entry(_RAW_KEY, artifacts["changeEnvelope"])))
        snapshot = MeshSnapshotPayload.from_wire(json.loads(decrypt_entry(_RAW_KEY, artifacts["snapshotEnvelope"])))

        change_wire = change.to_wire()
        snapshot_wire = snapshot.to_wire()
        python_payload = {
            "rawKey": base64.b64encode(_RAW_KEY).decode("ascii"),
            "entryEnvelope": encrypt_entry(_RAW_KEY, "hello from Python 🛰️"),
            "bytesEnvelope": encrypt_bytes(_RAW_KEY, bytes((255, 0, 128, 1))).decode("utf-8"),
            "changeEnvelope": encrypt_entry(_RAW_KEY, _compact_json(change_wire)),
            "snapshotEnvelope": encrypt_entry(_RAW_KEY, _compact_json(snapshot_wire)),
        }

        decrypted = self._run_node(_NODE_VERIFY_PYTHON_ARTIFACTS, python_payload)
        self.assertEqual(decrypted["entry"], "hello from Python 🛰️")
        self.assertEqual(decrypted["bytes"], [255, 0, 128, 1])
        self.assertEqual(decrypted["change"], change_wire)
        self.assertEqual(decrypted["snapshot"], snapshot_wire)


if __name__ == "__main__":
    unittest.main()
