"""Causal atomic progress/final-status tests, without native servers or inputs."""

import importlib.util
import json
import os
import stat
from pathlib import Path
from types import SimpleNamespace

import pytest


@pytest.fixture
def plugin(monkeypatch, tmp_path):
    spec = importlib.util.spec_from_file_location(
        "diagnostic_test_plugin", Path(__file__).with_name("conftest.py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    # Fault injection is plugin-local: the real running CI plugin must not inherit it.
    module.os = SimpleNamespace(
        environ=os.environ, fdopen=os.fdopen, fsync=os.fsync, replace=os.replace
    )
    module.json = SimpleNamespace(dump=json.dump)
    destination = tmp_path / "results.json"
    monkeypatch.setenv("AXIOM_TEMPORAL_ACCEPTANCE_REPORT", str(destination))
    monkeypatch.setattr(
        module,
        "_metadata",
        lambda: {
            "revision": "a" * 40,
            "dirty": False,
            "sdk_version": "synthetic-version",
            "scope": "synthetic diagnostics unit fixture; not live acceptance",
        },
    )
    return module, destination


def report(nodeid, outcome="passed", when="call"):
    return SimpleNamespace(
        nodeid=nodeid,
        outcome=outcome,
        when=when,
        failed=outcome == "failed",
        skipped=outcome == "skipped",
    )


def finish(plugin, status, actual=None):
    session = SimpleNamespace(exitstatus=status)
    wrapper = plugin.pytest_sessionfinish(session, status)
    next(wrapper)
    if actual is not None:
        session.exitstatus = actual
    with pytest.raises(StopIteration):
        wrapper.send(None)


def test_running_with_passed_outcomes_never_attests_completion(plugin):
    module, destination = plugin
    module.pytest_sessionstart(None)
    module.pytest_runtest_logstart("tests/test_case.py::test_run[private-input]", None)
    module.pytest_runtest_call(
        SimpleNamespace(nodeid="tests/test_case.py::test_run[private-input]")
    )
    module.pytest_runtest_logreport(
        report("tests/test_case.py::test_run[private-input]")
    )
    document = json.loads(destination.read_text())
    assert document["state"] == "running"
    assert document["exit_status"] is None
    assert document["completed_count"] == 1
    assert document["current_phase"] == "call"
    assert set(document["outcomes"].values()) == {"passed"}
    assert "private-input" not in destination.read_text()
    assert document["current_test"].startswith("tests/test_case.py::test_run[sha256:")
    assert stat.S_IMODE(destination.stat().st_mode) == 0o600


def test_final_outcomes_are_preserved_and_post_coverage_status_is_exact(plugin):
    module, destination = plugin
    module.pytest_sessionstart(None)
    for nodeid, outcome in [
        ("tests/test_case.py::test_run[first]", "passed"),
        ("tests/test_case.py::test_run[second]", "failed"),
    ]:
        module.pytest_runtest_logreport(report(nodeid, outcome))
    before = json.loads(destination.read_text())["outcomes"]
    assert len(before) == 2
    finish(module, 0, actual=1)
    document = json.loads(destination.read_text())
    assert document["state"] == "completed"
    assert document["exit_status"] == 1
    assert document["outcomes"] == before
    assert document["current_test"] is None
    assert document["current_phase"] is None


def test_each_update_replaces_a_complete_json_document_atomically(plugin, monkeypatch):
    module, destination = plugin
    actual_replace = module.os.replace
    seen = []

    def inspect_replace(source, target):
        seen.append(json.loads(Path(source).read_text()))
        if Path(target).exists():
            json.loads(Path(target).read_text())
        actual_replace(source, target)

    monkeypatch.setattr(module.os, "replace", inspect_replace)
    module.pytest_sessionstart(None)
    module.pytest_runtest_logstart("tests/test_case.py::test_run", None)
    module.pytest_runtest_logreport(report("tests/test_case.py::test_run"))
    finish(module, 0)
    assert [d["state"] for d in seen] == ["running", "running", "running", "completed"]
    assert not list(destination.parent.glob(".temporal-report-*"))


@pytest.mark.parametrize("failure", ["write", "replace"])
def test_failed_update_preserves_running_never_a_prior_completion(
    plugin, monkeypatch, failure
):
    module, destination = plugin
    destination.write_text('{"state":"completed","exit_status":0}')
    module.pytest_sessionstart(None)
    before = destination.read_bytes()

    def refuse(*args, **kwargs):
        if failure == "write":
            args[1].write('{"partially_written":')
        raise OSError("private-error-input")

    monkeypatch.setattr(
        module.json if failure == "write" else module.os,
        "dump" if failure == "write" else "replace",
        refuse,
    )
    with pytest.raises(
        pytest.UsageError, match="temporal_acceptance_report_write_failed"
    ) as caught:
        module.pytest_runtest_logreport(report("tests/test_case.py::test_run"))
    assert destination.read_bytes() == before
    assert json.loads(before)["state"] == "running"
    assert "private-error-input" not in str(caught.value)
    assert not list(destination.parent.glob(".temporal-report-*"))


def test_initial_replace_failure_invalidates_existing_completed_report(
    plugin, monkeypatch
):
    module, destination = plugin
    destination.write_text('{"state":"completed","exit_status":0}')

    def refuse(*args):
        raise OSError("synthetic-write-failure")

    monkeypatch.setattr(module.os, "replace", refuse)
    with pytest.raises(pytest.UsageError):
        module.pytest_sessionstart(None)
    assert not destination.exists()
    assert not list(destination.parent.glob(".temporal-report-*"))


def test_disabled_reporting_never_touches_existing_file(plugin, monkeypatch):
    module, destination = plugin
    destination.write_text("prior evidence")
    monkeypatch.delenv("AXIOM_TEMPORAL_ACCEPTANCE_REPORT")
    module.pytest_sessionstart(None)
    module.pytest_runtest_logreport(report("tests/test_case.py::test_run"))
    finish(module, 0)
    assert destination.read_text() == "prior evidence"


def test_final_replace_failure_leaves_only_running_report(plugin, monkeypatch):
    module, destination = plugin
    module.pytest_sessionstart(None)
    module.pytest_runtest_logreport(report("tests/test_case.py::test_run"))
    before = destination.read_bytes()

    def refuse(*args):
        raise OSError("synthetic-final-write-failure")

    monkeypatch.setattr(module.os, "replace", refuse)
    with pytest.raises(pytest.UsageError):
        finish(module, 0)
    assert destination.read_bytes() == before
    assert json.loads(before)["exit_status"] is None
    assert not list(destination.parent.glob(".temporal-report-*"))


def test_transient_write_failure_cannot_later_attest_completed(plugin, monkeypatch):
    module, destination = plugin
    module.pytest_sessionstart(None)
    before = destination.read_bytes()
    actual_replace = module.os.replace

    def refuse(*args):
        raise OSError("synthetic-transient-write-failure")

    monkeypatch.setattr(module.os, "replace", refuse)
    with pytest.raises(pytest.UsageError):
        module.pytest_runtest_logreport(report("tests/test_case.py::test_run"))
    monkeypatch.setattr(module.os, "replace", actual_replace)
    finish(module, 0)
    assert destination.read_bytes() == before
    assert json.loads(before)["exit_status"] is None


async def test_native_startup_timeout_is_bounded_and_later_fixtures_are_fenced(
    plugin, monkeypatch
):
    import asyncio
    from unittest.mock import AsyncMock

    module, _ = plugin
    cancelled = False

    async def stalled():
        nonlocal cancelled
        try:
            await asyncio.Event().wait()
        finally:
            cancelled = True

    factory = AsyncMock(side_effect=stalled)
    monkeypatch.setattr(
        module, "WorkflowEnvironment", SimpleNamespace(start_time_skipping=factory)
    )
    monkeypatch.setattr(module, "_NATIVE_STARTUP_SECONDS", 0.01)
    with pytest.raises(RuntimeError, match="temporal_native_server_startup_timeout"):
        await anext(module.server.__wrapped__())
    assert cancelled
    with pytest.raises(RuntimeError, match="temporal_native_server_prior_failure"):
        await anext(module.server.__wrapped__())
    assert factory.await_count == 1


async def test_native_fixture_yields_actual_server_and_always_shuts_down(
    plugin, monkeypatch
):
    from unittest.mock import AsyncMock

    module, _ = plugin
    environment = SimpleNamespace(shutdown=AsyncMock())
    monkeypatch.setattr(
        module,
        "WorkflowEnvironment",
        SimpleNamespace(start_time_skipping=AsyncMock(return_value=environment)),
    )
    fixture = module.server.__wrapped__()
    assert await anext(fixture) is environment
    await fixture.aclose()
    environment.shutdown.assert_awaited_once_with()
    assert not module._NATIVE_SERVER_FAILED


@pytest.mark.parametrize("phase", ["startup", "shutdown"])
async def test_native_failure_does_not_expose_private_vendor_error(
    plugin, monkeypatch, phase
):
    from unittest.mock import AsyncMock

    module, _ = plugin
    environment = SimpleNamespace(shutdown=AsyncMock())
    factory = AsyncMock(return_value=environment)
    if phase == "startup":
        factory.side_effect = RuntimeError("synthetic-private-vendor-credential")
    else:
        environment.shutdown.side_effect = RuntimeError(
            "synthetic-private-vendor-credential"
        )
    monkeypatch.setattr(
        module, "WorkflowEnvironment", SimpleNamespace(start_time_skipping=factory)
    )
    fixture = module.server.__wrapped__()
    with pytest.raises(
        RuntimeError, match=f"temporal_native_server_{phase}_failed"
    ) as caught:
        if phase == "startup":
            await anext(fixture)
        else:
            assert await anext(fixture) is environment
            await fixture.aclose()
    assert "synthetic-private-vendor-credential" not in str(caught.value)
    assert caught.value.__suppress_context__
    assert module._NATIVE_SERVER_FAILED


async def test_native_shutdown_timeout_fences_next_start(plugin, monkeypatch):
    import asyncio
    from unittest.mock import AsyncMock

    module, _ = plugin

    async def stalled():
        await asyncio.Event().wait()

    environment = SimpleNamespace(shutdown=AsyncMock(side_effect=stalled))
    factory = AsyncMock(return_value=environment)
    monkeypatch.setattr(
        module, "WorkflowEnvironment", SimpleNamespace(start_time_skipping=factory)
    )
    monkeypatch.setattr(module, "_NATIVE_SHUTDOWN_SECONDS", 0.01)
    fixture = module.server.__wrapped__()
    assert await anext(fixture) is environment
    with pytest.raises(RuntimeError, match="temporal_native_server_shutdown_timeout"):
        await fixture.aclose()
    with pytest.raises(RuntimeError, match="temporal_native_server_prior_failure"):
        await anext(module.server.__wrapped__())
    assert factory.await_count == 1


def test_terminal_parameter_identity_is_bounded_and_has_no_raw_packet(plugin):
    module, _ = plugin
    value = {"credential": "synthetic-private-marker", "packet": "x" * 100000}
    identity = module.pytest_make_parametrize_id(None, value, "result")
    assert len(identity) == 69
    assert identity.startswith("case-")
    assert "synthetic-private-marker" not in identity
    assert identity == module.pytest_make_parametrize_id(None, value, "result")
    assert identity != module.pytest_make_parametrize_id(
        None, {"packet": "different"}, "result"
    )
