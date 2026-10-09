"""Read-only release-plan preflight for the seven-image marketing profile."""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
PIN = "a" * 64


def command(*args: str, cwd: Path) -> str:
    result = subprocess.run(args, cwd=cwd, text=True, capture_output=True, check=True)
    return result.stdout.strip()


@pytest.fixture
def checkout(tmp_path: Path) -> tuple[Path, Path, Path]:
    repo = tmp_path / "checkout with spaces"
    (repo / "scripts/lib").mkdir(parents=True)
    (repo / "infra/docker/environments").mkdir(parents=True)
    for name in ("ops-env.sh", "ops-env-parse.py"):
        shutil.copyfile(ROOT / "scripts/lib" / name, repo / "scripts/lib" / name)
    shutil.copyfile(ROOT / "scripts/build-marketing-preprod.sh", repo / "scripts/build-marketing-preprod.sh")
    (repo / "infra/docker/environments/.env.preprod.example").write_text(
        "ENVIRONMENT=preprod\nGCP_PROJECT_ID=<project>\nGCP_REGION=asia-south1\n"
        "AXIOM_DEPLOYMENT_PROFILE=marketing\nAXIOM_ARTIFACT_REPOSITORY=<repo>\n"
        "AXIOM_PROOF_MARKETING_URL=https://stg.axiomproof.ai\n"
        "AXIOM_PROOF_PLATFORM_URL=https://platform.axiomproof.ai\n"
        "UPSTREAM_GOTRUE_IMAGE=<digest>\nUPSTREAM_POSTGREST_IMAGE=<digest>\n"
        "AXIOM_RELEASE_SHA=<sha>\n"
    )
    (repo / "README.md").write_text("baseline\n")
    command("git", "init", "-q", cwd=repo)
    command("git", "config", "user.email", "test@example.invalid", cwd=repo)
    command("git", "config", "user.name", "Preflight Test", cwd=repo)
    command("git", "add", ".", cwd=repo)
    command("git", "commit", "-qm", "baseline", cwd=repo)

    marker = tmp_path / "external-command-ran"
    bin_dir = tmp_path / "shadow-bin"
    bin_dir.mkdir()
    for name in ("docker", "gcloud", "firebase"):
        script = bin_dir / name
        script.write_text(f"#!/bin/sh\nprintf '%s\\n' {name} >> '{marker}'\nexit 97\n")
        script.chmod(0o755)
    return repo, bin_dir, marker


def release_file(repo: Path, tmp_path: Path, **changes: str) -> Path:
    values = {
        "ENVIRONMENT": "preprod",
        "GCP_PROJECT_ID": "axiom-proof",
        "GCP_REGION": "asia-south1",
        "AXIOM_DEPLOYMENT_PROFILE": "marketing",
        "AXIOM_ARTIFACT_REPOSITORY": "axiom-proof-preprod-images",
        "AXIOM_PROOF_MARKETING_URL": "https://stg.axiomproof.ai",
        "AXIOM_PROOF_PLATFORM_URL": "https://platform.axiomproof.ai",
        "UPSTREAM_GOTRUE_IMAGE": f"registry.example.invalid/auth@sha256:{PIN}",
        "MARKETING_AUTH_GO_BUILD_IMAGE": f"golang@sha256:{PIN}",
        "MARKETING_AUTH_SOURCE_ARCHIVE_URL": "https://codeload.github.com/supabase/auth/tar.gz/" + "a" * 40,
        "MARKETING_POSTGRES_CLIENT_APK_PACKAGE": "postgresql16-client=16.15-r0",
        "UPSTREAM_POSTGREST_IMAGE": f"registry.example.invalid/rest@sha256:{'b' * 64}",
        "MARKETING_PYTHON_RUNTIME_IMAGE": f"python@sha256:{PIN}",
        "MARKETING_POSTGRES_CLIENT_IMAGE": f"postgres@sha256:{PIN}",
        "MARKETING_NODE_RUNTIME_IMAGE": f"node@sha256:{PIN}",
        "MARKETING_TRIVY_IMAGE": f"aquasec/trivy@sha256:{PIN}",
        "CLOUD_SQL_INSTANCE_NAME": "axiom-proof-preprod-postgres",
        "AXIOM_IDLE_STATE_BUCKET": "axiom-proof-preprod-state-188516662106",
        "AXIOM_IDLE_STATE_OBJECT": "marketing-preprod/lifecycle/state.json",
        "AXIOM_RELEASE_SHA": command("git", "rev-parse", "HEAD", cwd=repo),
    }
    values.update(changes)
    selected = tmp_path / "selected.private.env"
    selected.write_text("".join(f"{key}={value}\n" for key, value in values.items()))
    selected.chmod(0o600)
    return selected


def dry_run(
    checkout: tuple[Path, Path, Path],
    selected: Path | None,
    *,
    inherited: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    repo, bin_dir, marker = checkout
    env = os.environ.copy()
    env.pop("AXIOM_ENV_FILE", None)
    env["PATH"] = f"{bin_dir}{os.pathsep}{env['PATH']}"
    env.update(inherited or {})
    args = ["/bin/bash", str(repo / "scripts/build-marketing-preprod.sh")]
    if selected is not None:
        args.extend(("--env-file", str(selected)))
    args.append("--dry-run")
    result = subprocess.run(args, cwd=repo, text=True, capture_output=True, env=env, check=False)
    assert not marker.exists(), "Dry-run invoked Docker, gcloud, or Firebase"
    return result


def test_valid_file_owned_plan_never_invokes_cloud_tools(checkout, tmp_path):
    repo, _, _ = checkout
    selected = release_file(repo, tmp_path)
    result = dry_run(
        checkout,
        selected,
        inherited={"GCP_PROJECT_ID": "wrong-project", "GCP_REGION": "us-central1"},
    )
    assert result.returncode == 0, result.stderr
    assert "project=axiom-proof" in result.stdout
    assert "region=asia-south1" in result.stdout
    assert command("git", "rev-parse", "HEAD", cwd=repo) in result.stdout
    assert "wrong-project" not in result.stdout + result.stderr


@pytest.mark.parametrize("selected_kind", ("missing", "example"))
def test_missing_or_example_file_never_falls_back(checkout, tmp_path, selected_kind):
    repo, _, _ = checkout
    if selected_kind == "missing":
        selected = None
    else:
        selected = tmp_path / "selected.env.example"
        selected.write_text(release_file(repo, tmp_path).read_text())
    result = dry_run(checkout, selected, inherited={"GCP_PROJECT_ID": "axiom-proof"})
    assert result.returncode != 0
    assert "Validated seven-image release plan" not in result.stdout


@pytest.mark.parametrize(
    ("change", "value"),
    [
        ("AXIOM_DEPLOYMENT_PROFILE", "full"),
        ("ENVIRONMENT", "production"),
        ("GCP_REGION", "us-central1"),
        ("MARKETING_AUTH_GO_BUILD_IMAGE", "golang:latest"),
        ("MARKETING_TRIVY_IMAGE", "aquasec/trivy:latest"),
        ("MARKETING_AUTH_SOURCE_ARCHIVE_URL", "https://evil.example.invalid/auth.tar.gz"),
        ("MARKETING_POSTGRES_CLIENT_APK_PACKAGE", "postgresql16-client"),
        ("UPSTREAM_POSTGREST_IMAGE", "registry.example.invalid/rest@sha256:short"),
        ("AXIOM_ARTIFACT_REPOSITORY", "production-images"),
        ("AXIOM_PROOF_MARKETING_URL", ""),
    ],
)
def test_wrong_profile_region_repository_or_unpinned_images_refused(
    checkout, tmp_path, change, value
):
    repo, _, _ = checkout
    selected = release_file(repo, tmp_path, **{change: value})
    result = dry_run(checkout, selected)
    assert result.returncode != 0, result.stdout
    assert "Validated seven-image release plan" not in result.stdout


def test_mismatched_source_sha_refused_before_release_plan(checkout, tmp_path):
    repo, _, _ = checkout
    selected = release_file(repo, tmp_path, AXIOM_RELEASE_SHA="f" * 40)
    result = dry_run(checkout, selected)
    assert result.returncode != 0, result.stdout
    assert "Validated seven-image release plan" not in result.stdout


def test_dirty_checkout_refused_even_for_dry_run(checkout, tmp_path):
    repo, _, _ = checkout
    selected = release_file(repo, tmp_path)
    (repo / "README.md").write_text("dirty source\n")
    result = dry_run(checkout, selected)
    assert result.returncode != 0, result.stdout
    assert "Validated seven-image release plan" not in result.stdout
