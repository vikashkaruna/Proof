"""Read-only release-plan preflight for the seven-image marketing profile."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
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
    shutil.copyfile(
        ROOT / "infra/docker/Dockerfile.marketing-rest",
        repo / "infra/docker/Dockerfile.marketing-rest",
    )
    for name in ("ops-env.sh", "ops-env-parse.py"):
        shutil.copyfile(ROOT / "scripts/lib" / name, repo / "scripts/lib" / name)
    shutil.copyfile(
        ROOT / "scripts/build-marketing-preprod.sh",
        repo / "scripts/build-marketing-preprod.sh",
    )
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
        "MARKETING_AUTH_SOURCE_ARCHIVE_URL": "https://codeload.github.com/supabase/auth/tar.gz/"
        + "a" * 40,
        "MARKETING_POSTGRES_CLIENT_APK_PACKAGE": "postgresql17-client=17.11-r0",
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
    build_only: bool = False,
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
    if build_only:
        args.append("--build-only")
    result = subprocess.run(
        args, cwd=repo, text=True, capture_output=True, env=env, check=False
    )
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


def test_build_only_plan_retains_source_and_environment_guards(checkout, tmp_path):
    repo, _, _ = checkout
    selected = release_file(repo, tmp_path)
    result = dry_run(checkout, selected, build_only=True)
    assert result.returncode == 0, result.stderr
    assert "independent Auth review" in result.stdout
    assert "no image publication or cloud deployment" in result.stdout
    mismatched = release_file(repo, tmp_path, AXIOM_RELEASE_SHA="f" * 40)
    result = dry_run(checkout, mismatched, build_only=True)
    assert result.returncode != 0
    assert "Build-only stops" not in result.stdout


def test_build_only_runs_candidate_pipeline_without_review_or_publication(
    checkout, tmp_path
):
    """Exercise real shell control flow with explicitly simulated image tools."""
    repo, bin_dir, marker = checkout
    selected = release_file(repo, tmp_path)
    for name in ("docker", "gcloud", "pnpm"):
        tool = bin_dir / name
        tool.write_text(
            f"#!/bin/sh\nprintf '%s\\n' \"{name} $*\" >> '{marker}'\nexit 0\n"
        )
        tool.chmod(0o755)
    python = bin_dir / "python3"
    python.write_text(
        f"#!{sys.executable}\n"
        "import os,subprocess,sys\n"
        "from pathlib import Path\n"
        "if len(sys.argv)>1 and sys.argv[1]!='-':\n"
        " if sys.argv[1].endswith('ops-env-parse.py'):\n"
        f"  raise SystemExit(subprocess.call([{sys.executable!r},*sys.argv[1:]]))\n"
        f" with Path({str(marker)!r}).open('a') as stream: stream.write('review-invoked\\n')\n"
        " raise SystemExit(96)\n"
        "body=sys.stdin.read()\n"
        "if 'AUTH_CONTEXT' in body:\n"
        " p=Path(os.environ['AUTH_CONTEXT']);(p/'context').mkdir()\n"
        " (p/'snapshot-sha256').write_text('a'*64+'\\n')\n"
        "elif 'approved-target.json' in body:\n"
        " Path('.axiom-runtime/marketing-preprod/target-manifest-sha256').write_text('b'*64+'\\n')\n"
        "elif 'rest-context.private.json' in body:\n"
        " exec(compile(body, 'fixed-rest-context', 'exec'))\n"
        "elif 'PYSCAN' not in body and 'scanner_image' in body:\n"
        " p=Path('.axiom-runtime/marketing-preprod/image-scans');p.mkdir(parents=True)\n"
        " (p/'candidate.private.json').write_text('{}\\n')\n"
    )
    python.chmod(0o755)
    env = os.environ.copy()
    env["PATH"] = f"{bin_dir}{os.pathsep}{env['PATH']}"
    result = subprocess.run(
        [
            "/bin/bash",
            str(repo / "scripts/build-marketing-preprod.sh"),
            "--env-file",
            str(selected),
            "--build-only",
        ],
        cwd=repo,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    calls = marker.read_text()
    assert calls.count("docker build ") == 7
    assert "docker pull " not in calls
    assert "docker tag " not in calls
    rest_calls = [
        line
        for line in calls.splitlines()
        if "docker build " in line and "/axiom-proof-preprod-rest:" in line
    ]
    assert len(rest_calls) == 1
    assert "--platform linux/amd64 --provenance=false" in rest_calls[0]
    assert (
        f"--build-arg UPSTREAM_POSTGREST_IMAGE=registry.example.invalid/rest@sha256:{'b' * 64}"
        in rest_calls[0]
    )
    source_sha = command("git", "rev-parse", "HEAD", cwd=repo)
    assert f"--label org.opencontainers.image.revision={source_sha}" in rest_calls[0]
    contexts = list((repo / ".axiom-runtime/marketing-preprod").glob("rest-source.*"))
    assert len(contexts) == 1
    context = contexts[0]
    assert context.stat().st_mode & 0o777 == 0o700
    dockerfile = context / "Dockerfile"
    assert (
        dockerfile.read_bytes()
        == (ROOT / "infra/docker/Dockerfile.marketing-rest").read_bytes()
    )
    assert dockerfile.stat().st_mode & 0o777 == 0o600
    manifest = context / "rest-context.private.json"
    assert manifest.stat().st_mode & 0o777 == 0o600
    assert json.loads(manifest.read_text()) == {
        "release_sha": source_sha,
        "upstream_image": f"registry.example.invalid/rest@sha256:{'b' * 64}",
        "platform": "linux/amd64",
        "dockerfile_sha256": hashlib.sha256(dockerfile.read_bytes()).hexdigest(),
    }
    assert "review-invoked" not in calls
    assert "docker push " not in calls
    assert (
        repo / ".axiom-runtime/marketing-preprod/image-scans/candidate.private.json"
    ).is_file()
    assert (
        "Independent Auth review and image clearance are still required"
        in result.stdout
    )


def test_rest_wrapper_only_resolves_same_upstream_without_content_changes():
    instructions = [
        line.strip()
        for line in (ROOT / "infra/docker/Dockerfile.marketing-rest")
        .read_text()
        .splitlines()
        if line.strip() and not line.startswith("#")
    ]
    assert instructions == [
        "ARG UPSTREAM_POSTGREST_IMAGE",
        "FROM ${UPSTREAM_POSTGREST_IMAGE}",
    ]


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
        (
            "MARKETING_AUTH_SOURCE_ARCHIVE_URL",
            "https://evil.example.invalid/auth.tar.gz",
        ),
        ("MARKETING_POSTGRES_CLIENT_APK_PACKAGE", "postgresql17-client"),
        ("MARKETING_POSTGRES_CLIENT_APK_PACKAGE", "postgresql16-client=16.15-r0"),
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


def scanner_program() -> str:
    source = (ROOT / "scripts/build-marketing-preprod.sh").read_text()
    return source.split("python3 - <<'PYSCAN'\n", 1)[1].split("\nPYSCAN", 1)[0]


def run_scanner_program(program, tmp_path, monkeypatch, rest_report='{"Results": [{"Target": "scanned"}]}\n'):
    """Execute the production scanner block; simulate only Docker transport."""
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("REGISTRY", "registry.example.invalid/review")
    monkeypatch.setenv("SOURCE_SHA", "a" * 40)
    monkeypatch.setenv("MARKETING_TRIVY_IMAGE", f"aquasec/trivy@sha256:{PIN}")
    monkeypatch.setenv("TMPDIR", "/ambient/unapproved-workspace")
    calls = []

    def inspect(args, **kwargs):
        assert args[:3] == ["docker", "image", "inspect"]
        return "sha256:" + PIN + "\n"

    def scan(args, **kwargs):
        assert args[:3] == ["docker", "run", "--rm"]
        assert "--read-only" in args
        assert args[args.index("--tmpfs") + 1] == "/tmp:rw,nosuid,nodev,size=256m"
        assert args[args.index("--cap-drop") + 1] == "ALL"
        assert args[args.index("--security-opt") + 1] == "no-new-privileges"
        assert args[args.index("--env") + 1] == "TMPDIR=/root/.cache/trivy/tmp"
        cache = tmp_path / ".axiom-runtime/marketing-preprod/image-scans/cache"
        assert str(cache.resolve()) + ":/root/.cache/trivy" in args
        assert (cache / "tmp").is_dir() and not (cache / "tmp").is_symlink()
        assert cache.stat().st_mode & 0o777 == 0o700
        assert (cache / "tmp").stat().st_mode & 0o777 == 0o700
        assert "--memory=1g" in args and "--cpus=1" in args
        assert kwargs == {"check": True, "timeout": 900}
        calls.append(args)
        report = Path(args[args.index("--output") + 1]).name
        (tmp_path / ".axiom-runtime/marketing-preprod/image-scans" / report).write_text(
            rest_report if report == "rest.scan.private.json" else '{"Results": []}\n'
        )

    monkeypatch.setattr(subprocess, "check_output", inspect)
    monkeypatch.setattr(subprocess, "run", scan)
    exec(compile(program, "reviewed-scanner-block", "exec"), {})  # noqa: S102 - fixed repository scanner block and explicit removal mutants only
    return calls


def test_actual_scanner_block_has_bounded_writable_tmp_and_readonly_root(
    tmp_path, monkeypatch
):
    calls = run_scanner_program(scanner_program(), tmp_path, monkeypatch)
    assert len(calls) == 7
    directory = tmp_path / ".axiom-runtime/marketing-preprod/image-scans"
    assert len(list(directory.glob("*.scan.private.json"))) == 7
    assert all(
        path.stat().st_mode & 0o777 == 0o600
        for path in directory.glob("*.private.json")
    )


def test_static_rest_scan_records_version_bound_no_os_evidence(tmp_path, monkeypatch):
    """A Results-less REST report invokes the reviewed collector; nothing else does."""
    (tmp_path / "scripts").mkdir()
    (tmp_path / "scripts/marketing-rest-evidence.py").write_text(
        "import json\n"
        "def collect(image_id, artifact_id, directory):\n"
        "    record = {'image_id': image_id, 'artifact_id': artifact_id, 'directory': str(directory)}\n"
        "    (directory.parent / 'collector-call.json').write_text(json.dumps(record))\n"
        "    return {'path': str(directory / 'rest-evidence.private.json'), 'sha256': 'e' * 64}\n"
    )
    artifact = "sha256:" + "c" * 64
    run_scanner_program(scanner_program(), tmp_path, monkeypatch, json.dumps({"ArtifactID": artifact}))
    directory = tmp_path / ".axiom-runtime/marketing-preprod/image-scans"
    call = json.loads((directory / "collector-call.json").read_text())
    assert call == {"image_id": "sha256:" + PIN, "artifact_id": artifact, "directory": ".axiom-runtime/marketing-preprod/image-scans/rest-evidence-" + "a" * 40}
    manifest = json.loads((directory / "candidate.private.json").read_text())
    assert manifest["images"]["rest"]["no_os_evidence"]["sha256"] == "e" * 64
    assert all("no_os_evidence" not in item for name, item in manifest["images"].items() if name != "rest")


def test_scanned_rest_results_never_invoke_the_alternate_collector(tmp_path, monkeypatch):
    run_scanner_program(scanner_program(), tmp_path, monkeypatch)
    manifest = json.loads((tmp_path / ".axiom-runtime/marketing-preprod/image-scans/candidate.private.json").read_text())
    assert all("no_os_evidence" not in item for item in manifest["images"].values())


@pytest.mark.parametrize(
    "removed",
    [
        "'--tmpfs', '/tmp:rw,nosuid,nodev,size=256m',",
        "'--read-only',",
        "'--cap-drop', 'ALL',",
        "'--security-opt', 'no-new-privileges',",
        "'--env', 'TMPDIR=/root/.cache/trivy/tmp',",
        "scratch.mkdir(mode=0o700, exist_ok=True)",
    ],
)
def test_scanner_sandbox_removal_mutants_fail_actual_command_check(
    tmp_path, monkeypatch, removed
):
    program = scanner_program()
    assert program.count(removed) == 1
    with pytest.raises((AssertionError, ValueError, FileNotFoundError)):
        run_scanner_program(program.replace(removed, ""), tmp_path, monkeypatch)


@pytest.mark.parametrize("linked", ["cache", "scratch"])
def test_scanner_disk_workspace_symlink_refused_before_docker(
    tmp_path, monkeypatch, linked
):
    cache = tmp_path / ".axiom-runtime/marketing-preprod/image-scans/cache"
    cache.parent.mkdir(parents=True)
    external = tmp_path / "external"
    external.mkdir()
    external.chmod(0o755)
    if linked == "cache":
        cache.symlink_to(external, target_is_directory=True)
    else:
        cache.mkdir()
        (cache / "tmp").symlink_to(external, target_is_directory=True)
    with pytest.raises(ValueError, match="must not be a symlink"):
        run_scanner_program(scanner_program(), tmp_path, monkeypatch)
    assert external.stat().st_mode & 0o777 == 0o755
