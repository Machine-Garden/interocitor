"""Deterministic interoperability vectors produced with @interocitor/core."""

from __future__ import annotations

import asyncio
import base64
import unittest

from interocitor import (
    CloudflareAdapter,
    CryptoProtocolError,
    EncryptedEnvelope,
    PortablePassphraseKeySource,
    RecoveredMeshCredentials,
    RecoveryError,
    RecoveryWrapper,
    base58_decode,
    base58_encode,
    create_recovery_wrapper,
    decrypt_bytes,
    decrypt_entry,
    encrypt_bytes,
    encrypt_entry,
    portable_key_from_bytes,
    portable_key_to_bytes,
    recover_mesh_credentials,
    recovery_locator,
    normalize_recovery_phrase,
    unwrap_recovery_wrapper,
)
from interocitor.crypto import json_stringify


PHRASE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
PORTABLE_KEY = "1thX6LZfHDZZKUs92febYZhYRcXddmzfzF2NvTkPNE"
RAW_KEY = bytes(range(32))
LOCATOR = "ZWvVtRtITSZXRKcfK65YqJoxtAlaqXP-Zz6zSZIKSfc"
CREDENTIALS = {
    "remotePath": "/case-vault/mesh-a",
    "portableKey": "4f3jvRY3nUCGz6ey45nY14B6AxRrz9q2QohRMWDFDT8",
    "meshId": "mesh_a",
}

# These are opaque fixed vectors emitted by packages/core/dist/crypto/*.js.
CORE_ENVELOPE = (
    b'{"v":1,"iv":"rEjEiQAqbQyBJ8fS",'
    b'"ct":"Mjm5Vpr+9HGymLGpn3PPI30Qgb+Lgy3eAR6R2XNdNk1WfMXJ+jM8DJk="}'
)
CORE_ENTRY = (
    '{"v":1,"iv":"31qi2BePR/t+a/KL",'
    '"ct":"qXlIzwm0KZkcg61xInx/tZNkDJS9cPngyUl+8C5zGCK2"}'
)
CORE_WRAPPER = {
    "v": 1,
    "alg": "AES-GCM",
    "kdf": {
        "root": {"name": "PBKDF2-HMAC-SHA-256", "iterations": 600000},
        "kek": {"name": "HKDF-SHA-256", "salt": "MaJVHYaasfgZCBp02deHvw"},
    },
    "locator": LOCATOR,
    "iv": "JrCuTr35rZGYQVAI",
    "ciphertext": (
        "BCvgUF-OQ67Qa0IZh6nd1atGGtflktIPe40Mhcd-JqMCpF46Zl1NInD5rYzpG690"
        "L3UfeUn4i-E5PLuMfZf2jJCf5sV3ib_QYCC7Vz9Mm_U7ZrpTxTTae6LYsHyOM6a5"
        "YFac7ct8SMpzMR-iteDVqXld8yfp5Cxj8uuRwAexxadH"
    ),
    "createdAt": "2026-07-27T02:30:33.967Z",
}

# Fixed salt/IV output below was calculated using the core v1 derivation
# constants and AES-GCM construction.  It proves Python's writer wire format,
# not merely its ability to read one generated wrapper.
DETERMINISTIC_WRAPPER = {
    "v": 1,
    "alg": "AES-GCM",
    "kdf": {
        "root": {"name": "PBKDF2-HMAC-SHA-256", "iterations": 600000},
        "kek": {"name": "HKDF-SHA-256", "salt": "AAECAwQFBgcICQoLDA0ODw"},
    },
    "locator": LOCATOR,
    "iv": "EBESExQVFhcYGRob",
    "ciphertext": (
        "RRwRKk8Y4m9xZakzaLMge9A4DtPc4aVX_ERk907vrnEtpUsoXk7Uno0_7MivpWPz"
        "BxxU_xSYqnDI7NV7lVnAPCvDm_d8md0fmNRtSC9aOxU3zdysU0qYMcyvhfAHWAa4"
        "mG2DHQdn0orQ4mn0xCaeGO--gScuw3IbAL2HvKPviNzY"
    ),
    "createdAt": "2026-07-27T00:00:00.000Z",
}


class CryptoCompatibilityTests(unittest.TestCase):
    def test_portable_base58_vector_matches_core(self) -> None:
        self.assertEqual(base58_encode(RAW_KEY), PORTABLE_KEY)
        self.assertEqual(base58_decode(PORTABLE_KEY), RAW_KEY)
        self.assertEqual(portable_key_from_bytes(RAW_KEY), PORTABLE_KEY)
        self.assertEqual(portable_key_to_bytes(f"  {PORTABLE_KEY}\n"), RAW_KEY)

    def test_worker_key_validation_rejects_blank_or_low_value_inputs(self) -> None:
        for portable_key in ("", " ", "1", "2", "1" * 43):
            with self.subTest(portable_key=portable_key), self.assertRaises(CryptoProtocolError):
                portable_key_to_bytes(portable_key)

        async def scenario() -> None:
            source = PortablePassphraseKeySource(portable_key="", generate_if_missing=False)
            with self.assertRaises(CryptoProtocolError):
                await source.load(None)  # type: ignore[arg-type]

        asyncio.run(scenario())

    def test_cloudflare_recovery_route_rejects_an_invalid_locator_before_requesting(self) -> None:
        async def scenario() -> None:
            adapter = CloudflareAdapter(
                base_url="https://worker.example/sync/io/mesh-address",
                recovery_base_url="https://worker.example/sync/recovery",
            )
            with self.assertRaises(ValueError):
                await adapter.read_recovery_wrapper("../io/mesh-address/health")
            with self.assertRaises(ValueError):
                await adapter.write_recovery_wrapper("", b"wrapper")

        asyncio.run(scenario())

    def test_core_aes_gcm_envelopes_decrypt(self) -> None:
        self.assertEqual(decrypt_bytes(RAW_KEY, CORE_ENVELOPE), "hello interocitor 🛰️".encode())
        self.assertEqual(decrypt_entry(RAW_KEY, CORE_ENTRY), '{"hello":"world"}')

        produced_bytes = encrypt_bytes(RAW_KEY, b"python envelope")
        produced_entry = encrypt_entry(RAW_KEY, "python entry")
        self.assertEqual(decrypt_bytes(RAW_KEY, produced_bytes), b"python envelope")
        self.assertEqual(decrypt_entry(RAW_KEY, produced_entry), "python entry")

        envelope = EncryptedEnvelope.from_json(produced_bytes)
        self.assertEqual(envelope.v, 1)
        self.assertEqual(len(base64.b64decode(envelope.iv)), 12)

    def test_text_and_json_match_javascript_lone_surrogate_behavior(self) -> None:
        self.assertEqual(json_stringify({"value": "\ud800"}), '{"value":"\\ud800"}')
        self.assertEqual(decrypt_entry(RAW_KEY, encrypt_entry(RAW_KEY, "\ud800")), "\ufffd")


class RecoveryCompatibilityTests(unittest.TestCase):
    def test_locator_matches_core_pbkdf2_hmac_vector(self) -> None:
        self.assertEqual(recovery_locator(PHRASE), LOCATOR)
        self.assertEqual(recovery_locator(f"  {PHRASE.replace(' ', '  \n  ')}  "), LOCATOR)
        self.assertEqual(normalize_recovery_phrase(f"\ufeff{PHRASE}"), PHRASE)
        self.assertEqual(recovery_locator(f"\ufeff{PHRASE}"), LOCATOR)

    def test_recovery_rejects_an_invalid_portable_key_before_encryption(self) -> None:
        with self.assertRaises(RecoveryError):
            create_recovery_wrapper(PHRASE, {"remotePath": "/mesh", "portableKey": " "})

    def test_unwraps_a_wrapper_created_by_core(self) -> None:
        wrapper = RecoveryWrapper.from_dict(CORE_WRAPPER)
        self.assertEqual(wrapper.to_dict(), CORE_WRAPPER)
        self.assertEqual(
            unwrap_recovery_wrapper(PHRASE, wrapper),
            RecoveredMeshCredentials(
                remote_path=CREDENTIALS["remotePath"],
                portable_key=CREDENTIALS["portableKey"],
                mesh_id=CREDENTIALS["meshId"],
            ),
        )

    def test_creates_the_fixed_v1_wrapper_vector(self) -> None:
        random_values = iter((bytes(range(16)), bytes(range(16, 28))))

        def deterministic_random_bytes(length: int) -> bytes:
            value = next(random_values)
            self.assertEqual(len(value), length)
            return value

        wrapper = create_recovery_wrapper(
            PHRASE,
            CREDENTIALS,
            random_bytes=deterministic_random_bytes,
            created_at="2026-07-27T00:00:00.000Z",
        )
        self.assertEqual(wrapper.to_dict(), DETERMINISTIC_WRAPPER)
        self.assertEqual(unwrap_recovery_wrapper(PHRASE, wrapper).to_dict(), CREDENTIALS)


class RecoverCredentialsTests(unittest.TestCase):
    def test_reads_an_async_recovery_adapter(self) -> None:
        class Adapter:
            async def read_recovery_wrapper(self, locator: str) -> bytes:
                if locator != LOCATOR:
                    raise AssertionError(f"{locator!r} != {LOCATOR!r}")
                return RecoveryWrapper.from_dict(CORE_WRAPPER).to_json().encode("utf-8")

        restored = asyncio.run(recover_mesh_credentials(Adapter(), PHRASE))
        self.assertEqual(restored.to_dict(), CREDENTIALS)
