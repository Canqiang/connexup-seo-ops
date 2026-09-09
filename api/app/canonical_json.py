"""Deterministic JSON bytes and hashes for population, manifest and content hashing."""
from __future__ import annotations

import hashlib
import json
import math
from decimal import Decimal, localcontext

CALCULATION_PRECISION = 28


def canonical_decimal(value: Decimal | int | None) -> str | None:
    """Render an exact decimal string with no exponent, or None."""
    if value is None:
        return None
    number = value if isinstance(value, Decimal) else Decimal(value)
    if not number.is_finite():
        raise ValueError("non-finite decimal is not canonicalizable")
    text = format(number, "f")
    return text


def _plain(value: object) -> object:
    if isinstance(value, Decimal):
        return canonical_decimal(value)
    if isinstance(value, bool):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("non-finite float is not canonicalizable")
        raise ValueError("float values must be converted to Decimal before canonicalization")
    if isinstance(value, dict):
        return {str(key): _plain(item) for key, item in sorted(value.items(), key=lambda kv: str(kv[0]))}
    if isinstance(value, (list, tuple)):
        return [_plain(item) for item in value]
    return value


def canonical_json_bytes(value: object) -> bytes:
    with localcontext() as ctx:
        ctx.prec = CALCULATION_PRECISION
        return json.dumps(
            _plain(value), ensure_ascii=False, separators=(",", ":"), allow_nan=False
        ).encode("utf-8")


def canonical_sha256(value: object) -> str:
    return hashlib.sha256(canonical_json_bytes(value)).hexdigest()
