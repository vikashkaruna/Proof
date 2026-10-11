"""Auditable pure reducer shared by the owned fixture's write and simulation paths."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from .owned_target import Snapshot

ENGINE = "owned_boolean_cas_v1"
CAPABILITIES = ("atomic_exact_operation_journal", "version_and_snapshot_cas", "no_write_roundtrip")


def implementation_sha256() -> str:
    return hashlib.sha256(Path(__file__).read_bytes()).hexdigest()


def capability_sha256() -> str:
    return hashlib.sha256(
        json.dumps(list(CAPABILITIES), separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def project(snapshot: Snapshot, *, enabled: bool) -> Snapshot:
    if type(enabled) is not bool:
        raise ValueError("owned boolean reducer requires strict boolean")
    return Snapshot(
        fixture_id=snapshot.fixture_id,
        resource_id=snapshot.resource_id,
        version=snapshot.version + 1,
        audit_log_enabled=enabled,
    )
