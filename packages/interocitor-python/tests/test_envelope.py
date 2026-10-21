"""Binary envelopes, the JSON envelopes readers still open, and their limits."""

from __future__ import annotations

import base64
import json
import os
import unittest
import zlib

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from interocitor import CryptoProtocolError, decrypt_bytes, decrypt_entry, encrypt_bytes, encrypt_entry
from interocitor.crypto import MAX_INFLATED_BYTES


_KEY = bytes(range(32))
_PLAIN = 0x02
_DEFLATE = 0x03
_CHANGE = json.dumps(
    {
        "meshId": "mesh_01a15dcf-ae89-73fc-b6d6-e184ad7f9851",
        "kind": "change",
        "entry": {
            "id": "chg_01a15dcf-ae8e-7c4e-8774-22498ba329c9",
            "device": "device_7f3a9c",
            "hlc": "001792575254158-0000-device_7f3a9c",
            "ops": [
                {
                    "type": "upsert",
                    "table": "tasks",
                    "rowId": "task-1",
                    "columns": {
                        "title": {"value": "", "hlc": "001792575254158-0000-device_7f3a9c"},
                        "done": {"value": True, "hlc": "001792575254158-0000-device_7f3a9c"},
                    },
                }
            ],
        },
    },
    separators=(",", ":"),
)


def _seal_binary(fmt: int, body: bytes) -> bytes:
    iv = os.urandom(12)
    return bytes((fmt,)) + iv + AESGCM(_KEY).encrypt(iv, body, bytes((fmt,)))


def _seal_json(plaintext: bytes) -> bytes:
    iv = os.urandom(12)
    ct = AESGCM(_KEY).encrypt(iv, plaintext, None)
    return json.dumps({"v": 1, "iv": base64.b64encode(iv).decode(), "ct": base64.b64encode(ct).decode()}).encode()


def _deflate(data: bytes) -> bytes:
    compressor = zlib.compressobj(6, zlib.DEFLATED, -15)
    return compressor.compress(data) + compressor.flush()


class EnvelopeTests(unittest.TestCase):
    def test_json_payload_is_sealed_compressed(self) -> None:
        sealed = encrypt_entry(_KEY, _CHANGE)
        self.assertEqual(sealed[0], _DEFLATE)
        self.assertLess(len(sealed), len(_seal_json(_CHANGE.encode())) * 0.5)
        self.assertEqual(decrypt_entry(_KEY, sealed), _CHANGE)

    def test_incompressible_bytes_are_sealed_as_given(self) -> None:
        media = os.urandom(4096)
        sealed = encrypt_bytes(_KEY, media)
        self.assertEqual(sealed[0], _PLAIN)
        self.assertEqual(len(sealed), len(media) + 29)
        self.assertEqual(decrypt_bytes(_KEY, sealed), media)

    def test_json_envelopes_still_open(self) -> None:
        legacy = _seal_json(_CHANGE.encode())
        self.assertEqual(decrypt_entry(_KEY, legacy), _CHANGE)
        self.assertEqual(decrypt_entry(_KEY, legacy.decode()), _CHANGE)
        self.assertEqual(decrypt_entry(_KEY, b"\n" + legacy), _CHANGE)

    def test_format_tag_is_authenticated(self) -> None:
        compressed = bytearray(encrypt_entry(_KEY, _CHANGE))
        compressed[0] = _PLAIN
        with self.assertRaises(Exception):
            decrypt_entry(_KEY, bytes(compressed))
        plain = bytearray(encrypt_bytes(_KEY, os.urandom(64)))
        plain[0] = _DEFLATE
        with self.assertRaises(Exception):
            decrypt_bytes(_KEY, bytes(plain))

    def test_unknown_formats_versions_and_truncation_are_named(self) -> None:
        sealed = bytearray(encrypt_entry(_KEY, _CHANGE))
        sealed[0] = 0x04
        with self.assertRaisesRegex(CryptoProtocolError, "Unknown envelope format: 0x04"):
            decrypt_entry(_KEY, bytes(sealed))
        with self.assertRaisesRegex(CryptoProtocolError, "Unknown envelope version: 2"):
            decrypt_entry(_KEY, b'{"v":2,"iv":"","ct":""}')
        with self.assertRaisesRegex(CryptoProtocolError, "truncated"):
            decrypt_entry(_KEY, bytes((_PLAIN, 1, 2, 3)))
        with self.assertRaisesRegex(CryptoProtocolError, "empty"):
            decrypt_entry(_KEY, b"")

    def test_inflating_past_the_cap_is_refused(self) -> None:
        bomb = _seal_binary(_DEFLATE, _deflate(bytes(MAX_INFLATED_BYTES + 1)))
        with self.assertRaisesRegex(CryptoProtocolError, "inflates past"):
            decrypt_entry(_KEY, bomb)

    def test_truncated_deflate_is_malformed(self) -> None:
        truncated = _seal_binary(_DEFLATE, _deflate(_CHANGE.encode())[:-4])
        with self.assertRaisesRegex(CryptoProtocolError, "malformed"):
            decrypt_entry(_KEY, truncated)


if __name__ == "__main__":
    unittest.main()
