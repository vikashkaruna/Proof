"""Real script imports with the exact environment from each SQL fixture."""

import os
import shlex
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]


@pytest.mark.parametrize(
    ("fixture", "entrypoint"),
    [
        ("prativedan-assessment-codec-fixture.sh", "prativedan_assessment_interop.py"),
        ("prativedan-assessment-runtime-fixture.sh", "prativedan_assessment_runtime_interop.py"),
    ],
)
def test_actual_entrypoint_has_shared_package_without_pytest_pythonpath(
    fixture: str, entrypoint: str
) -> None:
    declarations = [
        line
        for line in (ROOT / "tests/database" / fixture).read_text().splitlines()
        if line.startswith("export PYTHONPATH=")
    ]
    assert len(declarations) == 1
    environment = {k: v for k, v in os.environ.items() if k != "PYTHONPATH"}
    # Execute the fixture declaration, not pytest's configured additional paths.
    command = (
        declarations[0]
        + "\nexec "
        + shlex.join(
            [sys.executable, str(ROOT / "services/agent-runtime/tests" / entrypoint), "--help"]
        )
    )
    result = subprocess.run(
        ["bash", "-euc", command],
        cwd=ROOT,
        env=environment,
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert "--fixture" in result.stdout
    assert "--output-dir" in result.stdout


def test_actual_runtime_audit_script_imports_without_pytest_pythonpath() -> None:
    environment = {k: v for k, v in os.environ.items() if k != "PYTHONPATH"}
    # Run original top-level imports without its destructive/live main routine.
    command = (
        "import runpy; result=runpy.run_path("
        + repr(str(ROOT / "scripts/verify-runtime-audit.py"))
        + ",run_name='entrypoint_import_probe'); assert 'BaseAgent' in result"
    )
    result = subprocess.run(
        [sys.executable, "-c", command],
        cwd=ROOT / "services/agent-runtime",
        env=environment,
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )
    assert result.returncode == 0, result.stderr
