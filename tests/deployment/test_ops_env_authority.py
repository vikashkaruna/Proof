"""Selected file authority, strict inert parsing, and tool-transport preservation."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def repo(tmp_path):
    root = tmp_path / "fixture repo"
    lib = root / "scripts/lib"
    lib.mkdir(parents=True)
    for name in ("ops-env.sh", "ops-env-parse.py"):
        shutil.copyfile(ROOT / "scripts/lib" / name, lib / name)
    templates = root / "infra/docker/environments"
    templates.mkdir(parents=True)
    (templates / ".env.preprod.example").write_text(
        "ENVIRONMENT=preprod\nGCP_PROJECT_ID=<project>\nMARKETING_EMAIL_ENABLED=false\nROOT=old\nroot=old\n"
    )
    (templates / ".env.local.example").write_text("OPTIONAL_OTHER_ENV=default\n")
    return root


def shell(repo, body, *, env=None):
    merged = os.environ.copy()
    merged.pop("AXIOM_ENV_FILE", None)
    merged.update(env or {})
    return subprocess.run(
        [
            "/bin/bash",
            "-c",
            'set -eu; source "$1/scripts/lib/ops-env.sh"; ' + body,
            "fixture",
            str(repo),
        ],
        text=True,
        capture_output=True,
        env=merged,
        check=False,
    )


def write(repo, value):
    path = repo / "selected.env"
    path.write_text(value)
    return path


def test_file_overrides_inherited_and_clears_all_template_declared_absences(repo):
    write(repo, 'GCP_PROJECT_ID="chosen project"\nENVIRONMENT=preprod\nroot=chosen\n')
    run = shell(
        repo,
        "ops_load_env_file \"$1/selected.env\"; python3 -c 'import os,json; print(json.dumps(dict(os.environ)))'",
        env={
            "GCP_PROJECT_ID": "wrong",
            "MARKETING_EMAIL_ENABLED": "true",
            "OPTIONAL_OTHER_ENV": "stale",
            "root": "wrong",
        },
    )
    assert run.returncode == 0, run.stderr
    values = json.loads(run.stdout)
    assert values["GCP_PROJECT_ID"] == "chosen project"
    assert values["root"] == "chosen"
    assert "MARKETING_EMAIL_ENABLED" not in values
    assert "OPTIONAL_OTHER_ENV" not in values
    assert values["PATH"] == os.environ["PATH"]


def test_explicit_empty_is_authoritative_and_tool_credentials_survive(repo):
    write(repo, "GCP_PROJECT_ID=\n")
    transport = {
        "GOOGLE_APPLICATION_CREDENTIALS": "/synthetic/credentials.json",
        "AWS_PROFILE": "operator",
        "AWS_SESSION_TOKEN": "transport-only",
    }
    run = shell(
        repo,
        "ops_load_env_file \"$1/selected.env\"; python3 -c 'import os,json; print(json.dumps(dict(os.environ)))'",
        env={**transport, "GCP_PROJECT_ID": "wrong"},
    )
    assert run.returncode == 0, run.stderr
    values = json.loads(run.stdout)
    assert values["GCP_PROJECT_ID"] == ""
    assert all(values[key] == value for key, value in transport.items())


def test_template_union_is_dynamic(repo):
    (repo / "infra/docker/environments/.env.future.example").write_text(
        "NEW_FUTURE_KEY=default\n"
    )
    write(repo, "ENVIRONMENT=preprod\n")
    run = shell(
        repo,
        'ops_load_env_file "$1/selected.env"; test -z "${NEW_FUTURE_KEY+x}"',
        env={"NEW_FUTURE_KEY": "wrong"},
    )
    assert run.returncode == 0, run.stderr


@pytest.mark.parametrize(
    "bad",
    [
        "malformed-secret-without-equals",
        "BAD-KEY=secret-canary",
        "GOOD=before\nGOOD=secret-canary",
        'BAD="secret-canary',
        "BAD=secret-canary'",
        "PATH=secret-canary",
        "ACTION=secret-canary",
        "REPO_ROOT=secret-canary",
        "DRY_RUN=secret-canary",
        "MINT_FORCE=secret-canary",
        "GOOGLE_APPLICATION_CREDENTIALS=secret-canary",
        "IFS=secret-canary",
        "OPS_ENV_protocol=secret-canary",
        "BASH_ENV=secret-canary",
        "BAD=secret-canary\0",
    ],
)
def test_invalid_file_refuses_atomically_without_secret_output(repo, bad):
    write(repo, "GCP_PROJECT_ID=should-not-apply\n" + bad + "\n")
    run = shell(
        repo,
        'if ops_load_env_file "$1/selected.env"; then exit 90; fi; test "$GCP_PROJECT_ID" = original; test "$MARKETING_EMAIL_ENABLED" = original',
        env={"GCP_PROJECT_ID": "original", "MARKETING_EMAIL_ENABLED": "original"},
    )
    assert run.returncode == 0, run.stderr
    assert "secret-canary" not in run.stdout + run.stderr
    assert "should-not-apply" not in run.stdout + run.stderr
    assert "error:" in run.stderr


def test_readonly_refusal_is_atomic(repo):
    write(repo, "ENVIRONMENT=changed\nGCP_PROJECT_ID=changed\n")
    run = shell(
        repo,
        'readonly GCP_PROJECT_ID=original; if ops_load_env_file "$1/selected.env"; then exit 90; fi; test "$ENVIRONMENT" = original',
        env={"ENVIRONMENT": "original"},
    )
    assert run.returncode == 0, run.stderr
    assert "readonly" in run.stderr


def test_values_are_literal_never_executed(repo):
    sentinel = repo / "should never exist"
    write(
        repo,
        f"GCP_PROJECT_ID=\"$(touch '{sentinel}')\"\nTOKEN='`touch other` # literal'\nEMPTY=\nexport ROOT = \"literal $HOME\"\n",
    )
    run = shell(
        repo,
        "ops_load_env_file \"$1/selected.env\"; python3 -c 'import os,json; print(json.dumps(dict(os.environ)))'",
    )
    assert run.returncode == 0, run.stderr
    values = json.loads(run.stdout)
    assert values["GCP_PROJECT_ID"] == f"$(touch '{sentinel}')"
    assert values["TOKEN"] == "`touch other` # literal"
    assert values["ROOT"] == "literal $HOME"
    assert not sentinel.exists()


@pytest.mark.parametrize("kind", ["conflict", "identical", "symlink", "explicit"])
def test_resolution_refuses_conflict_unless_explicit(repo, kind):
    canonical = repo / "infra/docker/environments/.env.preprod"
    canonical.write_text("GCP_PROJECT_ID=canonical\n")
    top = repo / ".env.preprod"
    if kind == "symlink":
        top.symlink_to(canonical)
    else:
        top.write_text(
            "GCP_PROJECT_ID="
            + ("canonical" if kind == "identical" else "different")
            + "\n"
        )
    env = {"AXIOM_ENV_FILE": str(canonical)} if kind == "explicit" else {}
    run = shell(repo, 'ops_find_env_file preprod "$1"', env=env)
    if kind == "conflict":
        assert run.returncode != 0
        assert run.stdout == ""
        assert "GCP_PROJECT_ID=" not in run.stderr  # No file content.
        assert "different" not in run.stderr
    else:
        assert run.returncode == 0, run.stderr
        assert Path(run.stdout.strip()) == (canonical if kind == "explicit" else top)


def test_missing_explicit_file_does_not_fallback(repo):
    (repo / ".env.preprod").write_text("GCP_PROJECT_ID=available\n")
    run = shell(
        repo,
        'ops_find_env_file preprod "$1"',
        env={"AXIOM_ENV_FILE": str(repo / "missing")},
    )
    assert run.returncode != 0
    assert run.stdout == ""


def test_integer_caller_attributes_cannot_reinterpret_values(repo):
    write(repo, "ENVIRONMENT=changed\nGCP_PROJECT_ID=2+2\n")
    run = shell(
        repo,
        'declare -i GCP_PROJECT_ID=7; if ops_load_env_file "$1/selected.env"; then exit 90; fi; test "$ENVIRONMENT" = original; test "$GCP_PROJECT_ID" = 7',
        env={"ENVIRONMENT": "original"},
    )
    assert run.returncode == 0, run.stderr
    assert "unsupported caller attributes" in run.stderr


def test_crlf_tab_export_and_no_final_newline_are_supported(repo):
    path = repo / "selected.env"
    path.write_bytes(
        b"# comment\r\nexport\tGCP_PROJECT_ID = 'chosen'\r\nENVIRONMENT=preprod"
    )
    run = shell(
        repo,
        'ops_load_env_file "$1/selected.env"; test "$GCP_PROJECT_ID" = chosen; test "$ENVIRONMENT" = preprod',
    )
    assert run.returncode == 0, run.stderr
