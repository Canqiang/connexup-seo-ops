from decimal import Decimal, localcontext

import pytest

from app.canonical_json import canonical_decimal, canonical_json_bytes, canonical_sha256


def test_object_keys_are_sorted_but_lists_keep_order():
    assert canonical_json_bytes({"b": [3, 1], "a": 1}) == b'{"a":1,"b":[3,1]}'


def test_decimals_serialize_as_plain_strings_without_exponent():
    assert canonical_json_bytes({"v": Decimal("1E+3")}) == b'{"v":"1000"}'
    assert canonical_json_bytes({"v": Decimal("0.500")}) == b'{"v":"0.500"}'


def test_hash_is_stable_and_independent_of_process_decimal_context():
    payload = {"v": Decimal("10") / Decimal("4")}
    first = canonical_sha256(payload)
    with localcontext() as ctx:
        ctx.prec = 3
        assert canonical_sha256(payload) == first


@pytest.mark.parametrize("value", [float("nan"), float("inf"), Decimal("NaN")])
def test_non_finite_numbers_are_rejected(value):
    with pytest.raises(ValueError):
        canonical_json_bytes({"v": value})


def test_canonical_decimal_preserves_zero_and_maps_none():
    assert canonical_decimal(Decimal("0")) == "0"
    assert canonical_decimal(None) is None
