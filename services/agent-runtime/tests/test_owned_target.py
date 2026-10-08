"""Actual loopback HTTP and SQLite tests; no customer or application target."""

from __future__ import annotations

import asyncio
import json
import socket
import sqlite3
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from uuid import UUID, uuid4

import pytest

from axiom.owned_target import ACTION, OwnedTarget, OwnedWriteAdapter, Snapshot, digest, measure
from axiom.write_adapters import WriteRefused


@pytest.fixture
def server(tmp_path):
    fixture_id, resource_id = uuid4(), uuid4()
    database = tmp_path / "owned-resource.sqlite"
    with sqlite3.connect(database) as db:
        db.execute("create table resource (version integer not null, enabled integer not null)")
        db.execute("insert into resource values (0,0)")
        db.execute("create table operations (key text primary key, body_hash text, receipt text)")
    modes: dict[str, Any] = {"lost": set(), "false_success": False, "read_lie": False}

    def snapshot(db):
        version, enabled = db.execute("select version,enabled from resource").fetchone()
        return Snapshot(
            fixture_id=fixture_id,
            resource_id=resource_id,
            version=version,
            audit_log_enabled=bool(enabled),
        ).model_dump(mode="json")

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def send(self, status, value):
            body = json.dumps(value).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def authorized(self):
            if self.headers.get("Authorization") != "Bearer owned-fixture-only-token":
                self.send(401, {})
                return False
            return True

        def do_GET(self):
            if not self.authorized():
                return
            with sqlite3.connect(database) as db:
                if self.path == "/resource":
                    value = snapshot(db)
                    if modes["read_lie"]:
                        value["audit_log_enabled"] = not value["audit_log_enabled"]
                    self.send(200, value)
                elif self.path.startswith("/operations/"):
                    key = self.path.removeprefix("/operations/")
                    row = db.execute(
                        "select receipt from operations where key=?", (key,)
                    ).fetchone()
                    self.send(200 if row else 404, json.loads(row[0]) if row else {})
                else:
                    self.send(404, {})

        def do_POST(self):
            if not self.authorized():
                return
            if not self.path.startswith("/operations/"):
                self.send(404, {})
                return
            key = self.path.removeprefix("/operations/")
            UUID(key)
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            if (
                set(body)
                != {"fixture_id", "resource_id", "expected_version", "expected_sha256", "enabled"}
                or body["fixture_id"] != str(fixture_id)
                or body["resource_id"] != str(resource_id)
                or type(body["enabled"]) is not bool
                or type(body["expected_version"]) is not int
            ):
                self.send(409, {})
                return
            body_hash = digest(body)
            with sqlite3.connect(database, timeout=2) as db:
                db.execute("begin immediate")
                row = db.execute(
                    "select body_hash,receipt from operations where key=?", (key,)
                ).fetchone()
                if row:
                    self.send(200 if row[0] == body_hash else 409, json.loads(row[1]))
                    return
                before = snapshot(db)
                if body["expected_version"] != before["version"] or body[
                    "expected_sha256"
                ] != digest(before):
                    self.send(409, {})
                    return
                after = {
                    **before,
                    "version": before["version"] + 1,
                    "audit_log_enabled": body["enabled"],
                }
                if not modes["false_success"]:
                    db.execute(
                        "update resource set version=?,enabled=?",
                        (after["version"], int(body["enabled"])),
                    )
                receipt = {
                    "operation_id": key,
                    "body_sha256": body_hash,
                    "before": before,
                    "after": after,
                }
                db.execute(
                    "insert into operations values (?,?,?)", (key, body_hash, json.dumps(receipt))
                )
                db.commit()
            if key in modes["lost"]:
                modes["lost"].remove(key)
                self.connection.shutdown(socket.SHUT_RDWR)
                self.connection.close()
                return
            self.send(200, receipt)

    http = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=http.serve_forever, daemon=True)
    thread.start()
    target = OwnedTarget(
        origin=f"http://127.0.0.1:{http.server_port}",
        fixture_id=fixture_id,
        resource_id=resource_id,
        token="owned-fixture-only-token",
    )
    yield target, database, modes
    http.shutdown()
    http.server_close()
    thread.join(timeout=2)


async def adapter_for(target):
    review = await measure(target, enabled=True)
    return OwnedWriteAdapter(target, review, operation_id=uuid4(), rollback_id=uuid4())


@pytest.mark.asyncio
async def test_measured_read_only_review_and_actual_forward_undo(server):
    target, database, _modes = server
    adapter = await adapter_for(target)
    assert adapter.review.diff["records_measured"] == 1
    assert adapter.review.diff["changes"] == [
        {"field": "audit_log_enabled", "before": False, "after": True}
    ]
    with sqlite3.connect(database) as db:
        assert db.execute("select count(*) from operations").fetchone()[0] == 0
        assert db.execute("select enabled from resource").fetchone()[0] == 0
    result = await adapter.execute(ACTION, {"enabled": True})
    assert result.rows_affected == 1
    assert result.pre_state_ref != result.post_state_ref
    assert (await target.read()).audit_log_enabled is True
    assert (await adapter.verify(ACTION, {"enabled": True}))[0]["outcome"] == "passed"
    simulation = await adapter.simulate_rollback(ACTION, adapter.review.rollback_definition)
    assert simulation.rows_affected == 0
    assert (await target.read()).version == 1
    await adapter.execute_rollback(ACTION, adapter.review.rollback_definition)
    actual = await target.read()
    assert actual.audit_log_enabled is False
    assert actual.version == 2
    assert actual.content_sha256 == adapter.review.before.content_sha256
    assert (await adapter.verify(ACTION, {"enabled": True}))[0]["outcome"] == "failed"
    with sqlite3.connect(database) as db:
        assert db.execute("select count(*) from operations").fetchone()[0] == 2
        assert db.execute("select enabled from resource").fetchone()[0] == 0


@pytest.mark.asyncio
async def test_concurrent_identical_operation_is_exactly_once(server):
    target, database, _ = server
    adapter = await adapter_for(target)
    results = await asyncio.gather(*(adapter.execute(ACTION, {"enabled": True}) for _ in range(4)))
    assert all(result == results[0] for result in results)
    assert (await target.read()).version == 1
    with sqlite3.connect(database) as db:
        assert db.execute("select count(*) from operations").fetchone()[0] == 1


@pytest.mark.asyncio
async def test_committed_forward_and_rollback_lost_replies_recover_without_second_write(server):
    target, database, modes = server
    adapter = await adapter_for(target)
    modes["lost"].add(str(adapter.operation_id))
    first = await adapter.execute(ACTION, {"enabled": True})
    assert await adapter.execute(ACTION, {"enabled": True}) == first
    modes["lost"].add(str(adapter.rollback_id))
    undone = await adapter.execute_rollback(ACTION, adapter.review.rollback_definition)
    assert await adapter.execute_rollback(ACTION, adapter.review.rollback_definition) == undone
    with sqlite3.connect(database) as db:
        assert db.execute("select count(*) from operations").fetchone()[0] == 2
        assert db.execute("select version,enabled from resource").fetchone() == (2, 0)


@pytest.mark.asyncio
async def test_same_operation_changed_body_is_refused(server):
    target, database, _ = server
    adapter = await adapter_for(target)
    await adapter.execute(ACTION, {"enabled": True})
    with pytest.raises(WriteRefused, match="operation_unconfirmed"):
        await target.change(adapter.operation_id, adapter.review.before, False)
    with sqlite3.connect(database) as db:
        assert db.execute("select version,enabled from resource").fetchone() == (1, 1)
        assert db.execute("select count(*) from operations").fetchone()[0] == 1


@pytest.mark.asyncio
async def test_changed_current_version_refuses_forward_and_undo(server):
    target, database, _ = server
    adapter = await adapter_for(target)
    with sqlite3.connect(database) as db:
        db.execute("update resource set version=1")
    with pytest.raises(WriteRefused, match="source_changed"):
        await adapter.execute(ACTION, {"enabled": True})
    with sqlite3.connect(database) as db:
        assert db.execute("select count(*) from operations").fetchone()[0] == 0
    other = await adapter_for(target)
    await other.execute(ACTION, {"enabled": True})
    with sqlite3.connect(database) as db:
        db.execute("update resource set version=3")
    with pytest.raises(WriteRefused, match="source_changed"):
        await other.simulate_rollback(ACTION, other.review.rollback_definition)
    with pytest.raises(WriteRefused, match="source_changed"):
        await other.execute_rollback(ACTION, other.review.rollback_definition)
    assert (await target.read()).audit_log_enabled is True


@pytest.mark.asyncio
async def test_false_forward_success_cannot_become_verified_change(server):
    target, database, modes = server
    adapter = await adapter_for(target)
    modes["false_success"] = True
    with pytest.raises(WriteRefused, match="readback_mismatch"):
        await adapter.execute(ACTION, {"enabled": True})
    with sqlite3.connect(database) as db:
        assert db.execute("select version,enabled from resource").fetchone() == (0, 0)


@pytest.mark.asyncio
async def test_false_rollback_success_cannot_become_restored_proof(server):
    target, database, modes = server
    adapter = await adapter_for(target)
    await adapter.execute(ACTION, {"enabled": True})
    modes["false_success"] = True
    with pytest.raises(WriteRefused, match="readback_mismatch"):
        await adapter.execute_rollback(ACTION, adapter.review.rollback_definition)
    with sqlite3.connect(database) as db:
        assert db.execute("select version,enabled from resource").fetchone() == (1, 1)


@pytest.mark.parametrize(
    "origin",
    [
        "https://example.com",
        "http://localhost:1000",
        "http://192.168.1.1:1000",
        "http://127.0.0.1:1000/path",
        "http://user:pass@127.0.0.1:1000",
        "http://127.0.0.1:1000?target=x",
    ],
)
def test_only_explicit_configured_literal_loopback_fixture_is_accepted(origin):
    with pytest.raises(ValueError, match="owned fixture requires"):
        OwnedTarget(origin=origin, fixture_id=uuid4(), resource_id=uuid4(), token="fixture-token")


@pytest.mark.asyncio
async def test_wrong_identity_or_token_refused_before_review(server):
    target, _database, _ = server
    foreign = OwnedTarget(
        origin=target.origin,
        fixture_id=uuid4(),
        resource_id=target.resource_id,
        token="owned-fixture-only-token",
    )
    with pytest.raises(WriteRefused, match="identity_mismatch"):
        await measure(foreign, enabled=True)
    denied = OwnedTarget(
        origin=target.origin,
        fixture_id=target.fixture_id,
        resource_id=target.resource_id,
        token="wrong-token",
    )
    with pytest.raises(WriteRefused, match="target_refused"):
        await measure(denied, enabled=True)


@pytest.mark.asyncio
async def test_action_scope_and_rollback_original_snapshot_are_exact(server):
    target, database, _ = server
    adapter = await adapter_for(target)
    for action, parameters in [
        ("data.delete", {"enabled": True}),
        (ACTION, {"enabled": 1}),
        (ACTION, {"enabled": False}),
        (ACTION, {"enabled": True, "url": "x"}),
    ]:
        with pytest.raises(WriteRefused, match="scope_mismatch"):
            await adapter.execute(action, parameters)
    with pytest.raises(WriteRefused, match="forward_unconfirmed"):
        await adapter.execute_rollback(ACTION, adapter.review.rollback_definition)
    await adapter.execute(ACTION, {"enabled": True})
    with pytest.raises(WriteRefused, match="scope_mismatch"):
        await adapter.execute_rollback(ACTION, {"enabled": False, "snapshot_sha256": "0" * 64})
    with sqlite3.connect(database) as db:
        assert db.execute("select count(*) from operations").fetchone()[0] == 1


@pytest.mark.asyncio
async def test_forged_journal_identity_and_incomplete_operation_refused(server):
    target, database, _ = server
    adapter = await adapter_for(target)
    await adapter.execute(ACTION, {"enabled": True})
    with sqlite3.connect(database) as db:
        receipt = json.loads(db.execute("select receipt from operations").fetchone()[0])
        receipt["after"]["resource_id"] = str(uuid4())
        db.execute("update operations set receipt=?", (json.dumps(receipt),))
    with pytest.raises(WriteRefused, match="identity_mismatch"):
        await adapter.execute(ACTION, {"enabled": True})


@pytest.mark.asyncio
async def test_target_cas_rechecks_actual_version_at_mutation_boundary(server):
    target, database, _ = server
    adapter = await adapter_for(target)
    body = adapter._forward_body()
    with sqlite3.connect(database) as db:
        db.execute("update resource set version=1")
    with pytest.raises(WriteRefused, match="target_refused"):
        await target._request("POST", f"/operations/{adapter.operation_id}", body)
    with sqlite3.connect(database) as db:
        assert db.execute("select version,enabled from resource").fetchone() == (1, 0)
        assert db.execute("select count(*) from operations").fetchone()[0] == 0


@pytest.mark.asyncio
async def test_reconstructed_adapter_resolves_persisted_original_journal(server):
    target, database, _ = server
    original = await adapter_for(target)
    outcome = await original.execute(ACTION, {"enabled": True})
    fresh_target = OwnedTarget(
        origin=target.origin,
        fixture_id=target.fixture_id,
        resource_id=target.resource_id,
        token="owned-fixture-only-token",
    )
    recovered = OwnedWriteAdapter(
        fresh_target,
        original.review,
        operation_id=original.operation_id,
        rollback_id=original.rollback_id,
    )
    assert await recovered.execute(ACTION, {"enabled": True}) == outcome
    with sqlite3.connect(database) as db:
        assert db.execute("select version,enabled from resource").fetchone() == (1, 1)
        assert db.execute("select count(*) from operations").fetchone()[0] == 1


@pytest.mark.asyncio
async def test_nonboolean_or_noop_review_cannot_be_measured(server):
    target, database, _ = server
    with pytest.raises(WriteRefused, match="parameters_invalid"):
        await measure(target, enabled=1)
    with pytest.raises(WriteRefused, match="no_change"):
        await measure(target, enabled=False)
    adapter = await adapter_for(target)
    with pytest.raises(WriteRefused, match="parameters_invalid"):
        await target.change(adapter.operation_id, adapter.review.before, 1)
    with pytest.raises(ValueError, match="identities must differ"):
        OwnedWriteAdapter(
            target,
            adapter.review,
            operation_id=adapter.operation_id,
            rollback_id=adapter.operation_id,
        )
    with sqlite3.connect(database) as db:
        assert db.execute("select count(*) from operations").fetchone()[0] == 0
