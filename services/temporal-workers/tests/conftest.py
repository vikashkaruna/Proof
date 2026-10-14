"""Optional atomic CI diagnostics; never raw test inputs, histories or credentials.

Source test names remain readable. Parametrized case labels are SHA-256 identities
without a raw-value map. Running reports, even with passed outcomes, are never
completion evidence: exit_status stays null until all session-finish hooks end.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import tempfile
from contextlib import suppress
from pathlib import Path

import pytest

_OUTCOMES: dict[str, str] = {}
_DESTINATION: Path | None = None
_METADATA: dict[str, object] = {}
_CURRENT: str | None = None
_PHASE: str | None = None
_REPORT_FAILED = False


def _safe_nodeid(nodeid: str) -> str:
    base = nodeid.split("[", 1)[0]
    if len(base) > 1024 or not re.fullmatch(r"[A-Za-z0-9_./:-]+", base):
        return "test-" + hashlib.sha256(nodeid.encode()).hexdigest()
    if base != nodeid:
        return base + "[sha256:" + hashlib.sha256(nodeid.encode()).hexdigest() + "]"
    return base


def _metadata() -> dict[str, object]:
    root = Path(__file__).resolve().parents[3]
    revision = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=root, text=True, timeout=10
    ).strip()
    dirty = bool(
        subprocess.check_output(
            ["git", "status", "--porcelain"], cwd=root, text=True, timeout=10
        ).strip()
    )
    import temporalio

    return {
        "revision": revision,
        "dirty": dirty,
        "sdk_version": temporalio.__version__,
        "scope": "real Temporal test server and sandboxed replay; synthetic agents/HTTP; not deployed acceptance",
    }


def _atomic_write(destination: Path, document: dict[str, object]) -> None:
    global _REPORT_FAILED
    temporary: Path | None = None
    try:
        descriptor, name = tempfile.mkstemp(
            prefix=".temporal-report-", dir=destination.parent
        )
        temporary = Path(name)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(document, stream, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, destination)
    except OSError, ValueError:
        _REPORT_FAILED = True
        raise pytest.UsageError("temporal_acceptance_report_write_failed") from None
    finally:
        if temporary is not None:
            with suppress(OSError):
                temporary.unlink(missing_ok=True)


def _publish(*, exit_status: int | None = None) -> None:
    if _DESTINATION is None or _REPORT_FAILED:
        return
    completed = exit_status is not None
    _atomic_write(
        _DESTINATION,
        {
            **_METADATA,
            "state": "completed" if completed else "running",
            "exit_status": exit_status,
            "current_test": None if completed else _CURRENT,
            "current_phase": None if completed else _PHASE,
            "completed_count": len(_OUTCOMES),
            "outcomes": dict(_OUTCOMES),
        },
    )


@pytest.hookimpl
def pytest_sessionstart(session):
    global _DESTINATION, _METADATA, _CURRENT, _PHASE, _REPORT_FAILED
    _REPORT_FAILED = False
    _METADATA = {}
    _OUTCOMES.clear()
    _CURRENT = _PHASE = None
    target = os.environ.get("AXIOM_TEMPORAL_ACCEPTANCE_REPORT")
    _DESTINATION = Path(target) if target else None
    if _DESTINATION is None:
        return
    try:
        _DESTINATION.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        # Invalidate a prior completion before any current tests/metadata reads.
        # A failed initial atomic write must never leave an old completed report.
        _DESTINATION.unlink(missing_ok=True)
    except OSError:
        _REPORT_FAILED = True
        raise pytest.UsageError("temporal_acceptance_report_reset_failed") from None
    try:
        _METADATA = _metadata()
    except OSError, subprocess.SubprocessError, ImportError, ValueError:
        _REPORT_FAILED = True
        raise pytest.UsageError("temporal_acceptance_report_metadata_failed") from None
    _publish()


@pytest.hookimpl
def pytest_runtest_logstart(nodeid, location):
    global _CURRENT, _PHASE
    _CURRENT = _safe_nodeid(nodeid)
    _PHASE = "setup"
    _publish()


def _phase_start(item, phase: str) -> None:
    global _CURRENT, _PHASE
    _CURRENT = _safe_nodeid(item.nodeid)
    _PHASE = phase
    _publish()


@pytest.hookimpl(tryfirst=True)
def pytest_runtest_setup(item):
    _phase_start(item, "setup")


@pytest.hookimpl(tryfirst=True)
def pytest_runtest_call(item):
    _phase_start(item, "call")


@pytest.hookimpl(tryfirst=True)
def pytest_runtest_teardown(item, nextitem):
    _phase_start(item, "teardown")


@pytest.hookimpl
def pytest_runtest_logreport(report):
    global _CURRENT, _PHASE
    if report.when not in {"setup", "call", "teardown"} or report.outcome not in {
        "passed",
        "failed",
        "skipped",
    }:
        raise pytest.UsageError("temporal_acceptance_report_event_invalid")
    _CURRENT = _safe_nodeid(report.nodeid)
    _PHASE = report.when
    if report.when == "call" or report.failed or report.skipped:
        _OUTCOMES[_CURRENT] = report.outcome
    _publish()


@pytest.hookimpl
def pytest_runtest_logfinish(nodeid, location):
    global _CURRENT, _PHASE
    _CURRENT = _PHASE = None
    _publish()


@pytest.hookimpl(wrapper=True, tryfirst=True)
def pytest_sessionfinish(session, exitstatus):
    # Outer wrapper runs after coverage and all other finish hooks. Never use
    # their original argument when they changed the actual final exit status.
    outcome = yield
    _publish(exit_status=int(session.exitstatus))
    return outcome
