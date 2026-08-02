"""Sortable identifiers compatible with core's UUIDv7-based IDs."""

from __future__ import annotations

import os
import time


def uuidv7(*, now_ms: int | None = None, random_bytes: bytes | None = None) -> str:
    """Create an RFC 9562 UUIDv7 using the same byte layout as core."""

    timestamp = time.time_ns() // 1_000_000 if now_ms is None else now_ms
    if timestamp < 0 or timestamp >= 1 << 48:
        raise ValueError("UUIDv7 timestamp must fit in 48 bits")
    random_part = os.urandom(10) if random_bytes is None else bytes(random_bytes)
    if len(random_part) != 10:
        raise ValueError("UUIDv7 requires exactly 10 random bytes")
    value = bytearray(timestamp.to_bytes(6, "big") + random_part)
    value[6] = (value[6] & 0x0F) | 0x70
    value[8] = (value[8] & 0x3F) | 0x80
    encoded = value.hex()
    return "-".join((encoded[:8], encoded[8:12], encoded[12:16], encoded[16:20], encoded[20:]))


def create_device_id() -> str:
    return uuidv7()


def generate_id(prefix: str) -> str:
    if not prefix:
        raise ValueError("ID prefix must not be empty")
    return f"{prefix}_{uuidv7()}"
