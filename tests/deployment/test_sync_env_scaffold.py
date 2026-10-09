"""Scaffold adds only missing declarations, never replaces operator configuration."""

import os
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def repo(tmp_path):
    root = tmp_path / "scaffold fixture"
    lib = root / "scripts/lib"
    lib.mkdir(parents=True)
    shutil.copyfile(ROOT / "scripts/sync-env.sh", root / "scripts/sync-env.sh")
    for name in ("ops-env.sh", "ops-env-parse.py"):
        shutil.copyfile(ROOT / "scripts/lib" / name, lib / name)
    config = root / "infra/docker/environments"
    config.mkdir(parents=True)
    (config / ".env.preprod.example").write_text(
        "ENVIRONMENT=preprod\nGCP_PROJECT_ID=template-project\nRESEND_API_KEY=<fill-in>\nMARKETING_EMAIL_ENABLED=false\nNEW_CONFIG=template-default\n"
    )
    return root


def scaffold(repo, selected=None):
    env = os.environ.copy()
    env.pop("AXIOM_ENV_FILE", None)
    if selected:
        env["AXIOM_ENV_FILE"] = str(selected)
    return subprocess.run(
        ["/bin/bash", str(repo / "scripts/sync-env.sh"), "preprod", "scaffold"],
        cwd=repo,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )


@pytest.mark.parametrize(
    "project_line",
    [
        "GCP_PROJECT_ID=operator-value",
        'export GCP_PROJECT_ID="operator-value"',
        "GCP_PROJECT_ID = operator-value",
    ],
)
def test_existing_values_and_empty_declarations_untouched(repo, project_line):
    path = repo / "infra/docker/environments/.env.preprod"
    original = (
        "# retained comment\nENVIRONMENT=preprod\n"
        + project_line
        + "\nRESEND_API_KEY=synthetic-secret-canary\nMARKETING_EMAIL_ENABLED=\n"
    )
    path.write_text(original)
    run = scaffold(repo)
    assert run.returncode == 0, run.stdout + run.stderr
    result = path.read_text()
    assert result.startswith(original)
    assert result.count("GCP_PROJECT_ID") == 1
    assert result.count("RESEND_API_KEY=") == 1
    assert result.count("MARKETING_EMAIL_ENABLED=") == 1
    assert "NEW_CONFIG=template-default" in result
    assert "synthetic-secret-canary" not in run.stdout + run.stderr
    before = result
    again = scaffold(repo)
    assert again.returncode == 0, again.stdout + again.stderr
    assert path.read_text() == before


def test_conflicting_canonical_files_neither_written(repo):
    top = repo / ".env.preprod"
    canonical = repo / "infra/docker/environments/.env.preprod"
    top.write_text("GCP_PROJECT_ID=one\n")
    canonical.write_text("GCP_PROJECT_ID=two\n")
    before = [top.read_bytes(), canonical.read_bytes()]
    run = scaffold(repo)
    assert run.returncode != 0
    assert [top.read_bytes(), canonical.read_bytes()] == before


def test_explicit_selection_only_scaffolds_selected_file(repo):
    canonical = repo / "infra/docker/environments/.env.preprod"
    canonical.write_text("GCP_PROJECT_ID=canonical\n")
    selected = repo / "explicit.env"
    selected.write_text("GCP_PROJECT_ID=chosen\n")
    run = scaffold(repo, selected)
    assert run.returncode == 0, run.stdout + run.stderr
    assert canonical.read_text() == "GCP_PROJECT_ID=canonical\n"
    assert selected.read_text().startswith("GCP_PROJECT_ID=chosen\n")
    assert "NEW_CONFIG=template-default" in selected.read_text()


def test_initial_scaffold_creates_private_template_file(repo):
    path = repo / "infra/docker/environments/.env.preprod"
    assert not path.exists()
    run = scaffold(repo)
    assert run.returncode == 0, run.stdout + run.stderr
    assert path.stat().st_mode & 0o777 == 0o600
    assert path.read_bytes() == (path.parent / ".env.preprod.example").read_bytes()


@pytest.mark.parametrize(
    "bad",
    ["GCP_PROJECT_ID=one\nGCP_PROJECT_ID=secret-canary\n", "invalid-secret-canary\n"],
)
def test_invalid_selected_file_is_not_scaffolded(repo, bad):
    path = repo / "infra/docker/environments/.env.preprod"
    path.write_text(bad)
    run = scaffold(repo)
    assert run.returncode != 0
    assert path.read_text() == bad
    assert "secret-canary" not in run.stdout + run.stderr


def test_missing_explicit_file_never_creates_canonical_file(repo):
    run = scaffold(repo, repo / "missing.explicit.env")
    assert run.returncode != 0
    assert not (repo / "infra/docker/environments/.env.preprod").exists()
