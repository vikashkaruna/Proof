"""Optional sanitized CI evidence. Never persist raw test inputs or histories."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

_OUTCOMES: dict[str, str] = {}


@pytest.hookimpl
def pytest_runtest_logreport(report):
    if report.when == "call" or report.failed or report.skipped:
        _OUTCOMES[report.nodeid] = report.outcome


@pytest.hookimpl
def pytest_sessionfinish(session, exitstatus):
    target = os.environ.get("AXIOM_TEMPORAL_ACCEPTANCE_REPORT")
    if not target:
        return
    root = Path(__file__).resolve().parents[3]
    revision = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=root, text=True
    ).strip()
    dirty = bool(
        subprocess.check_output(
            ["git", "status", "--porcelain"], cwd=root, text=True
        ).strip()
    )
    import temporalio

    document = {
        "revision": revision,
        "dirty": dirty,
        "exit_status": int(exitstatus),
        "sdk_version": temporalio.__version__,
        "scope": "real Temporal test server and sandboxed replay; synthetic agents/HTTP; not deployed acceptance",
        "outcomes": _OUTCOMES,
    }
    destination = Path(target)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(document, indent=2) + "\n")
