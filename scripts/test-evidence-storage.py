#!/usr/bin/env python3
"""Build a pinned upstream TEST-ONLY MinIO fixture and exercise real S3 semantics.

Archived upstream software is isolated, synthetic and loopback-only here. This
is not a maintained production/on-prem recommendation or proof of AWS root
protection/residency. No existing container, bucket or parity DB is modified.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import os
import secrets
import shutil
import subprocess  # nosec B404 - test harness runs docker and pnpm with argv lists, no shell
import tarfile
import tempfile
import time
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from urllib.parse import urlparse


# http(s) only. A bare urlopen would also accept file: and other schemes; this
# opener has no handler for them, and the scheme is checked explicitly as well.
_OPENER = urllib.request.build_opener(urllib.request.HTTPHandler, urllib.request.HTTPSHandler)


def _open(url, timeout):
    if urllib.parse.urlparse(url).scheme not in ("http", "https"):
        raise ValueError(f"refusing non-http(s) URL: {url}")
    return _OPENER.open(url, timeout=timeout)


ROOT = Path(__file__).resolve().parents[1]
COMMIT = "9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a"
ARCHIVE_SHA = "45521908307306e925c98d629e1c17d78c8b72b6ee242b1bfb1409f7d8ee5841"
BUILDER = "docker.io/library/golang@sha256:4ed690d6649d63c312b99a6120025ec79ce3b542968a37da53d6236c7c61a848"
URL = f"https://codeload.github.com/minio/minio/tar.gz/{COMMIT}"


def command(args, *, log=None, timeout=1800):
    result = subprocess.run(  # nosec B603 - harness-built argv, no shell
        args,
        cwd=ROOT,
        stdout=log or subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        timeout=timeout,
        check=True,
    )
    return (result.stdout or "").strip()


def build(directory: Path, run_id: str) -> str:
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    archive = directory / "source.tar.gz"
    if not archive.exists():
        with (
            _open(URL, timeout=60) as response,
            archive.open("wb") as output,
        ):
            shutil.copyfileobj(response, output)
    verified_archive = archive.read_bytes()
    if hashlib.sha256(verified_archive).hexdigest() != ARCHIVE_SHA:
        raise RuntimeError("Source archive checksum mismatch")
    output = directory / "output"
    output.mkdir(exist_ok=True)
    log_path = directory / "build.log"
    builder_name = f"axiom-evidence-build-{run_id}"
    # A cached extracted tree is mutable and cannot inherit the archive's hash.
    # Re-extract exactly the verified bytes for every build; only Go caches persist.
    with tempfile.TemporaryDirectory(prefix="verified-source-", dir=directory) as fresh:
        with tarfile.open(fileobj=io.BytesIO(verified_archive)) as bundle:
            bundle.extractall(fresh, filter="data")
        source = Path(fresh) / f"minio-{COMMIT}"
        try:
            with log_path.open("w") as log:
                command(
                    [
                        "docker",
                        "run",
                        "--rm",
                        "--name",
                        builder_name,
                        "--cpus=2",
                        "--memory=4g",
                        "-e",
                        "GOMAXPROCS=2",
                        "-e",
                        "CGO_ENABLED=0",
                        "-e",
                        "GOCACHE=/out/cache",
                        "-e",
                        "GOMODCACHE=/out/modules",
                        "-v",
                        f"{source}:/src:ro",
                        "-v",
                        f"{output}:/out",
                        "-w",
                        "/src",
                        BUILDER,
                        "go",
                        "build",
                        "-p",
                        "2",
                        "-trimpath",
                        "-o",
                        "/out/minio",
                        ".",
                    ],
                    log=log,
                )
        finally:
            subprocess.run(  # nosec B603 B607 - fixed docker argv, no shell
                ["docker", "rm", "-f", builder_name],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        # Package the same verified archive snapshot, not a concurrently replaced path.
        return package(directory, source, output, verified_archive)


def package(directory: Path, source: Path, output: Path, verified_archive: bytes) -> str:
    context = directory / "image"
    context.mkdir(exist_ok=True)
    shutil.copy2(output / "minio", context / "minio")
    shutil.copy2(source / "LICENSE", context / "LICENSE")
    (context / "source.tar.gz").write_bytes(verified_archive)
    (context / "Dockerfile").write_text(f'''FROM scratch
LABEL org.opencontainers.image.source="https://github.com/minio/minio" axiom.fixture.source="{COMMIT}" axiom.fixture.archive="{ARCHIVE_SHA}" axiom.fixture.test-only="true"
COPY minio /minio
COPY LICENSE /LICENSE
COPY source.tar.gz /source.tar.gz
ENTRYPOINT ["/minio"]
''')
    iid = directory / "image-id"
    with (directory / "package.log").open("w") as log:
        command(["docker", "build", "--iidfile", str(iid), str(context)], log=log)
    return iid.read_text().strip()


def healthy(endpoint: str):
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        try:
            with _open(f"{endpoint}/minio/health/ready", timeout=2) as result:
                if result.status == 200:
                    return
        except Exception:
            time.sleep(0.5)
    raise RuntimeError("Isolated evidence fixture did not become healthy")


def endpoint_for(name: str) -> str:
    info = json.loads(command(["docker", "inspect", name]))[0]
    binding = info["NetworkSettings"]["Ports"]["9000/tcp"][0]
    if binding["HostIp"] != "127.0.0.1":
        raise RuntimeError("Fixture binding is not loopback")
    return f"http://127.0.0.1:{binding['HostPort']}"


def owned_provider(directory: Path):
    state = json.loads((directory / "private-fixture.json").read_text())
    info = json.loads(command(["docker", "inspect", state["name"]]))[0]
    if info["Config"]["Labels"].get("axiom.fixture.run") != state["runId"]:
        raise RuntimeError("Fixture ownership mismatch")
    config = json.loads((directory / "private-config.json").read_text())
    endpoint = urlparse(config["endpoint"])
    if endpoint.scheme != "http" or endpoint.hostname != "127.0.0.1" or not endpoint.port:
        raise RuntimeError("Private fixture endpoint is not loopback")
    # Docker Desktop omits NetworkSettings.Ports while a container is paused.
    # Ownership remains provable from its label; verify the live endpoint again
    # immediately after unpause instead of refusing the recovery operation.
    if not info["State"]["Paused"] and config["endpoint"] != endpoint_for(state["name"]):
        raise RuntimeError("Private fixture endpoint mismatch")
    return state, info


def resume_provider(directory: Path):
    state, info = owned_provider(directory)
    if info["State"]["Paused"]:
        command(["docker", "unpause", state["name"]])
    owned_provider(directory)
    healthy(endpoint_for(state["name"]))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", type=Path, default=ROOT / ".axiom-runtime/evidence-storage")
    parser.add_argument(
        "--image-id",
        help="Existing source-built fixture image; provenance labels are checked",
    )
    parser.add_argument("--build-only", action="store_true")
    parser.add_argument(
        "--pause-provider",
        action="store_true",
        help="Pause only the owned synthetic provider without changing its port",
    )
    parser.add_argument(
        "--resume-provider",
        action="store_true",
        help="Resume only the owned synthetic provider",
    )
    parser.add_argument(
        "--browser",
        action="store_true",
        help="Run evidence browser acceptance with private fixture environment",
    )
    parser.add_argument(
        "--keep-running",
        action="store_true",
        help="Keep successful synthetic fixture and private runtime.env for browser acceptance",
    )
    parser.add_argument(
        "--stop",
        action="store_true",
        help="Remove only the owned fixture identified by private-fixture.json",
    )
    args = parser.parse_args()
    os.umask(0o077)
    directory = args.directory.resolve()
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    state_file = directory / "private-fixture.json"
    if args.pause_provider or args.resume_provider:
        if args.pause_provider and args.resume_provider:
            raise RuntimeError("Choose one provider action")
        state, info = owned_provider(directory)
        if not info["State"]["Running"]:
            raise RuntimeError("Owned provider is not running")
        if args.pause_provider:
            if not info["State"]["Paused"]:
                command(["docker", "pause", state["name"]])
            print("Owned synthetic evidence provider paused")
        else:
            resume_provider(directory)
            print("Owned synthetic evidence provider resumed")
        return
    if args.browser:
        state, info = owned_provider(directory)
        if (
            info["Config"]["Labels"].get("axiom.fixture.run") != state["runId"]
            or not info["State"]["Running"]
        ):
            raise RuntimeError("Owned evidence fixture is not running")
        env = os.environ.copy()
        env.update(
            dict(
                line.split("=", 1) for line in (directory / "runtime.env").read_text().splitlines()
            )
        )
        # Cold headless Chromium can exceed the renderer's 30 s budget on a fresh
        # runner; take that cold start (and any missing-binary failure) here, with
        # the renderer's own explanation, instead of inside the first PDF journey.
        subprocess.run(  # nosec B603 B607 - fixed docker argv, no shell
            ["pnpm", "exec", "tsx", "scripts/warm-pdf-renderer.ts"],
            cwd=ROOT,
            env=env,
            timeout=300,
            check=True,
        )
        env["AXIOM_EVIDENCE_STORAGE_ACCEPTANCE"] = "true"
        env["AXIOM_EVIDENCE_FIXTURE_DIRECTORY"] = str(directory)
        raw_report = directory / "private-playwright.json"
        env["PLAYWRIGHT_JSON_OUTPUT_FILE"] = str(raw_report)
        summary = {
            "status": "failed",
            "gitRevision": command(["git", "rev-parse", "HEAD"]),
            "dirty": bool(command(["git", "status", "--porcelain"])),
            "outcomes": [],
        }
        try:
            result = subprocess.run(  # nosec B603 B607 - fixed pnpm argv, no shell
                [
                    "pnpm",
                    "--filter",
                    "@axiom/e2e",
                    "exec",
                    "playwright",
                    "test",
                    "source-bound-formats-provider.spec.ts",
                    "evidence-ingestion.spec.ts",
                    "evidence-vault.spec.ts",
                    "evidence-packs.spec.ts",
                    "evidence-packs-access.spec.ts",
                    "board-reports-provider.spec.ts",
                    "approval-archive-provider.spec.ts",
                    "--workers=1",
                    "--retries=0",
                    "--reporter=line,json",
                    "--trace=off",
                ],
                cwd=ROOT,
                env=env,
                timeout=1800,
            )
            stats = json.loads(raw_report.read_text()).get("stats", {})
            # Sum of every test() in the seven specs above (ingestion 1, vault 3,
            # packs 3, pack-access 1, board 5, approval archive 1, technical+DPB
            # source-bound formats 2). Refuse a missing or silently skipped spec.
            expected_browser_tests = 16
            summary["counts"] = {
                name: stats.get(name) for name in ["expected", "unexpected", "flaky", "skipped"]
            }
            if (
                result.returncode
                or stats.get("expected") != expected_browser_tests
                or any(stats.get(name) != 0 for name in ["unexpected", "flaky", "skipped"])
            ):
                raise RuntimeError(
                    f"Evidence browser acceptance requires all {expected_browser_tests} tests without skips or retries"
                )
            summary["status"] = "passed"
            summary["outcomes"] = [
                "real-provider-human-ingestion-and-exact-version-browser-lifecycle",
                "real-post-upload-pending-intent-reconciles-through-browser-to-exact-version",
                "begin-only-no-object-reconciliation-remains-pending-without-evidence",
                "file-and-metadata-changes-revoke-retention-review-acknowledgement",
                "paused-provider-refuses-fresh-verification-and-clears-prior-success",
                "legacy-evidence-local-hash-and-honest-search",
                "tenant-and-role-access-controls",
                "retained-pack-founder-review-release-and-independent-offline-verification",
                "pack-prepare-replay-and-honest-read-failure-rejection",
                "pack-post-upload-settlement-recovery-and-begin-only-pending",
                "pack-live-membership-internal-authority-and-export-revocation",
                "board-finalized-assessment-founder-review-exact-provider-versions-and-release",
                "board-provider-interruption-pending-build-and-founder-recovery",
                "board-manager-and-founder-browser-request-review-build-preview-and-release",
                "board-live-authority-revocation-refuses-cached-review-and-private-reads",
                "auditor-finalized-source-founder-review-exact-versions-and-release",
                "approval-human-signed-reconciliation-exact-version-founder-release-and-owner-download",
                "technical-recorded-plan-founder-source-review-exact-provider-versions-and-release",
                "dpb-reviewed-breach-notification-founder-source-review-exact-provider-versions-and-release",
            ]
        finally:
            try:
                resume_provider(directory)
            except Exception:
                summary["status"] = "failed"
                summary["cleanup"] = "provider_resume_failed"
                raise
            finally:
                (directory / "browser-results.json").write_text(
                    json.dumps(summary, indent=2) + "\n"
                )
                raw_report.unlink(missing_ok=True)
        return
    if args.stop:
        if not state_file.exists():
            print("No retained fixture to remove")
            return
        state = json.loads(state_file.read_text())
        paused = False
        for kind, name in [("container", state["name"]), ("volume", state["volume"])]:
            info = json.loads(command(["docker", kind, "inspect", name]))[0]
            labels = info["Config"]["Labels"] if kind == "container" else info["Labels"]
            if labels.get("axiom.fixture.run") != state["runId"]:
                raise RuntimeError("Fixture ownership mismatch")
            if kind == "container":
                paused = info["State"]["Paused"]
        if paused:
            command(["docker", "unpause", state["name"]])
        command(["docker", "rm", "-f", state["name"]])
        command(["docker", "volume", "rm", state["volume"]])
        for private in [
            "private.env",
            "private-config.json",
            "private-fixture.json",
            "runtime.env",
        ]:
            (directory / private).unlink(missing_ok=True)
        print("Owned evidence fixture removed")
        return
    if state_file.exists():
        raise RuntimeError("An owned fixture already exists; stop it before starting another")
    (directory / "report.json").write_text(json.dumps({"status": "running"}) + "\n")
    run_id = uuid.uuid4().hex[:12]
    image = args.image_id or build(directory / "build", run_id)
    inspected = json.loads(command(["docker", "image", "inspect", image]))[0]
    labels = inspected["Config"].get("Labels", {})
    if (
        not image.startswith("sha256:")
        or labels.get("axiom.fixture.source") != COMMIT
        or labels.get("axiom.fixture.archive") != ARCHIVE_SHA
    ):
        raise RuntimeError("Fixture image provenance mismatch")
    if args.build_only:
        print(f"Test-only evidence fixture built: {image}")
        return
    name = f"axiom-evidence-{run_id}"
    volume = f"{name}-data"
    user = f"fixture{secrets.token_hex(8)}"
    password = secrets.token_urlsafe(32)
    env_file = directory / "private.env"
    env_file.write_text(
        f"MINIO_ROOT_USER={user}\nMINIO_ROOT_PASSWORD={password}\nMINIO_KMS_SECRET_KEY=fixture-key:{base64.b64encode(secrets.token_bytes(32)).decode()}\nMINIO_REGION_NAME=ap-south-1\nMINIO_BROWSER=off\n"
    )
    outcomes = []
    keep = False
    try:
        command(
            [
                "docker",
                "volume",
                "create",
                "--label",
                f"axiom.fixture.run={run_id}",
                volume,
            ]
        )
        command(
            [
                "docker",
                "run",
                "-d",
                "--name",
                name,
                "--cpus=2",
                "--memory=1g",
                "--label",
                f"axiom.fixture.run={run_id}",
                "--env-file",
                str(env_file),
                "-p",
                "127.0.0.1::9000",
                "-v",
                f"{volume}:/data",
                image,
                "server",
                "/data",
                "--address",
                ":9000",
            ]
        )
        endpoint = endpoint_for(name)
        healthy(endpoint)
        state_file.write_text(json.dumps({"name": name, "volume": volume, "runId": run_id}))
        config = {
            "endpoint": endpoint,
            "accessKeyId": user,
            "secretAccessKey": password,
            "bucket": f"evidence-{run_id}",
            "privateStatePath": str(directory / "private-receipt.json"),
        }
        for phase in ["initial", "restart", "unavailable"]:
            if phase == "restart":
                command(["docker", "restart", name])
                endpoint = endpoint_for(name)
                config["endpoint"] = endpoint
                healthy(endpoint)
            elif phase == "unavailable":
                command(["docker", "stop", name])
            config["resultPath"] = str(directory / f"{phase}.json")
            config_file = directory / "private-config.json"
            config_file.write_text(json.dumps(config))
            print(
                command(
                    [
                        "pnpm",
                        "--filter",
                        "@axiom/evidence",
                        "exec",
                        "tsx",
                        "src/storage-acceptance.ts",
                        str(config_file),
                        phase,
                    ],
                    timeout=180,
                )
            )
            outcomes.extend(json.loads(Path(config["resultPath"]).read_text())["outcomes"])
        report = {
            "status": "passed",
            "outcomes": outcomes,
            "sourceCommit": COMMIT,
            "sourceArchiveSha256": ARCHIVE_SHA,
            "imageId": image,
            "builderImage": BUILDER,
            "gitRevision": command(["git", "rev-parse", "HEAD"]),
            "dirty": bool(command(["git", "status", "--porcelain"])),
            "scope": "isolated synthetic loopback provider; not production/cloud retention acceptance",
        }
        (directory / "report.json").write_text(json.dumps(report, indent=2) + "\n")
        print(f"Evidence storage acceptance: {len(outcomes)} real-provider outcomes passed")
        if args.keep_running:
            command(["docker", "start", name])
            endpoint = endpoint_for(name)
            healthy(endpoint)
            config["endpoint"] = endpoint
            config_file.write_text(json.dumps(config))
            (directory / "runtime.env").write_text(
                f"AXIOM_STORAGE_ENDPOINT={endpoint}\nAXIOM_EVIDENCE_BUCKET=evidence-{run_id}\nAXIOM_STORAGE_ACCESS_KEY_ID={user}\nAXIOM_STORAGE_SECRET_ACCESS_KEY={password}\nAXIOM_REGION=ap-south-1\n"
            )
            keep = True
            print(
                f"Owned fixture retained; private runtime environment: {directory / 'runtime.env'}"
            )
    except Exception:
        (directory / "report.json").write_text(
            json.dumps({"status": "failed", "completedOutcomes": outcomes}) + "\n"
        )
        raise
    finally:
        # Names include a random run ID and are owned exclusively by this harness.
        if not keep:
            subprocess.run(  # nosec B603 B607 - fixed docker argv, no shell
                ["docker", "rm", "-f", name],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            subprocess.run(  # nosec B603 B607 - fixed docker argv, no shell
                ["docker", "volume", "rm", volume],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            for private in [
                "private.env",
                "private-config.json",
                "private-fixture.json",
                "runtime.env",
            ]:
                (directory / private).unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Provider details and private arguments stay out of acceptance logs.
        print(f"Evidence storage harness failed: {type(error).__name__}")
        raise SystemExit(1) from None
