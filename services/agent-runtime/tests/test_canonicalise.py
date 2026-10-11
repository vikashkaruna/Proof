"""Tests for the canonical JSON + SHA-256 helpers."""


from axiom.canonicalise import canonical_json, sha256_hex


def test_canonical_json_sorts_object_keys():
    a = canonical_json({"b": 1, "a": 2})
    b = canonical_json({"a": 2, "b": 1})
    assert a == b


def test_canonical_json_preserves_array_order():
    assert canonical_json([1, 2, 3]) == "[1,2,3]"
    assert canonical_json([3, 1, 2]) == "[3,1,2]"


def test_canonical_json_handles_nested_structures():
    a = canonical_json({"z": {"y": 1, "x": 2}, "a": [3, 2, 1]})
    b = canonical_json({"a": [3, 2, 1], "z": {"x": 2, "y": 1}})
    assert a == b


def test_canonical_json_treats_none_as_null():
    class _Obj:
        def __init__(self):
            self.a = 1
            self.b = None

    # When a non-dict object is passed, it falls through to the standard
    # json.dumps path; we don't guarantee behaviour for arbitrary objects.
    # For our actual use we pass only dicts/lists/scalars.
    assert canonical_json({"a": 1, "b": None}) == '{"a":1,"b":null}'


def test_canonical_json_produces_no_whitespace():
    assert canonical_json({"a": 1}) == '{"a":1}'


def test_sha256_matches_known_vector():
    # echo -n "hello" | sha256sum
    assert sha256_hex("hello") == "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"


def test_sha256_deterministic():
    assert sha256_hex("hello") == sha256_hex("hello")
