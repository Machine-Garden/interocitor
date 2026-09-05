# compass: interocitor.rows.crdt-merge

"""Hybrid logical clock compatible with ``@interocitor/core``."""

from __future__ import annotations

import re
import time

from .types import HLC


HLC_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000
_MAX_SAFE_INTEGER = (1 << 53) - 1
_HLC_WIRE_RE = re.compile(r"^(?P<ts>[0-9]{15,})-(?P<counter>[0-9a-f]{4,})-(?P<node>[\s\S]+)$")


def _now_ms() -> int:
    return time.time_ns() // 1_000_000


def hlc_init(node_id: str, *, now_ms: int | None = None) -> HLC:
    return HLC(ts=_now_ms() if now_ms is None else now_ms, counter=0, node_id=node_id)


def hlc_now(local: HLC, *, now_ms: int | None = None) -> HLC:
    """Tick the local clock for a new event without mutating ``local``."""

    wall = _now_ms() if now_ms is None else now_ms
    if wall > local.ts:
        return HLC(ts=wall, counter=0, node_id=local.node_id)
    return HLC(ts=local.ts, counter=local.counter + 1, node_id=local.node_id)


def hlc_receive(local: HLC, remote: HLC, *, now_ms: int | None = None) -> HLC:
    """Merge a remote clock, applying the core's five-minute skew cap."""

    wall = _now_ms() if now_ms is None else now_ms
    safe_remote_ts = min(remote.ts, wall + HLC_MAX_FUTURE_SKEW_MS)
    maximum = max(wall, local.ts, safe_remote_ts)
    if maximum == local.ts and maximum == remote.ts:
        counter = max(local.counter, remote.counter) + 1
    elif maximum == local.ts:
        counter = local.counter + 1
    elif maximum == safe_remote_ts:
        counter = remote.counter + 1
    else:
        counter = 0
    return HLC(ts=maximum, counter=counter, node_id=local.node_id)


def hlc_compare(left: HLC, right: HLC) -> int:
    if left.ts != right.ts:
        return left.ts - right.ts
    if left.counter != right.counter:
        return left.counter - right.counter
    # JavaScript compares strings as UTF-16 code units.  Python compares
    # Unicode scalar values, which gives a different order for BMP versus
    # astral device IDs (for example U+E000 and U+1F600).
    left_node = left.node_id.encode("utf-16-be", errors="surrogatepass")
    right_node = right.node_id.encode("utf-16-be", errors="surrogatepass")
    if left_node < right_node:
        return -1
    if left_node > right_node:
        return 1
    return 0


def hlc_serialize(value: HLC) -> str:
    if type(value.ts) is not int or not 0 <= value.ts <= _MAX_SAFE_INTEGER:
        raise ValueError("HLC timestamp must be a non-negative safe integer")
    if type(value.counter) is not int or not 0 <= value.counter <= _MAX_SAFE_INTEGER:
        raise ValueError("HLC counter must be a non-negative safe integer")
    if not isinstance(value.node_id, str) or not value.node_id:
        raise ValueError("HLC node ID must be a non-empty string")
    return f"{value.ts:015d}-{value.counter:04x}-{value.node_id}"


def hlc_parse(value: str) -> HLC:
    """Parse a canonical core HLC wire value, including dashed node IDs.

    The TypeScript helper currently delegates to permissive ``parseInt``.
    This network boundary deliberately accepts only values the core serializer
    itself can create, preventing malformed cursor data from acquiring a
    different ordering in Python and JavaScript.
    """

    if not isinstance(value, str):
        raise TypeError("HLC must be a string")
    match = _HLC_WIRE_RE.fullmatch(value)
    if match is None:
        raise ValueError(f"Invalid HLC: {value!r}")
    try:
        timestamp = int(match.group("ts"), 10)
        counter = int(match.group("counter"), 16)
    except ValueError as error:  # pragma: no cover - regex has already screened digits
        raise ValueError(f"Invalid HLC: {value!r}") from error
    if timestamp > _MAX_SAFE_INTEGER or counter > _MAX_SAFE_INTEGER:
        raise ValueError(f"Invalid HLC: {value!r}")
    return HLC(ts=timestamp, counter=counter, node_id=match.group("node"))


def hlc_compare_str(left: str, right: str) -> int:
    return hlc_compare(hlc_parse(left), hlc_parse(right))
