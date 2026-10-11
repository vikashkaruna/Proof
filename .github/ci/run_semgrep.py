"""Run a mandatory pinned community policy, or an additional configured policy."""

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = ROOT / ".github/semgrep/policy.json"
POLICY = ROOT / ".axiom-runtime/ci/semgrep-community-policy"
VERSION = "1.180.0"
UPSTREAM = "9bbf021d0acffa3095fcffd17b2bc7787eb4796d"


_RULE_PATHS = {
    "python/lang/security/audit/eval-detected.yaml",
    "python/lang/security/audit/exec-detected.yaml",
    "python/lang/security/audit/subprocess-shell-true.yaml",
    "javascript/lang/security/detect-child-process.yaml",
    "javascript/browser/security/eval-detected.yaml",
    "problem-based-packs/insecure-transport/js-node/bypass-tls-verification.yaml",
    "generic/secrets/security/detected-private-key.yaml",
    "generic/secrets/security/detected-aws-access-key-id-value.yaml",
}


def policy_manifest(path=MANIFEST):
    manifest = json.loads(path.read_text())
    if (
        manifest.get("schemaVersion") != 1
        or manifest.get("upstreamRepository")
        != "https://github.com/semgrep/semgrep-rules"
        or manifest.get("upstreamCommit") != UPSTREAM
        or manifest.get("scannerVersion") != VERSION
        or set(manifest.get("rules", {})) != _RULE_PATHS
        or any(
            not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{64}", value)
            for value in [
                manifest.get("licenseSha256", ""),
                *manifest.get("rules", {}).values(),
            ]
        )
    ):
        raise ValueError("Reviewed Semgrep policy provenance refused")
    return manifest


class NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        raise ValueError("Unreviewed Semgrep rule download redirect refused")


def download(path):
    # The only network source is this exact upstream repository+commit+path.
    # Paths are selected from the reviewed inventory, never arbitrary URLs.
    if path not in _RULE_PATHS | {"LICENSE"}:
        raise ValueError("Unreviewed Semgrep rule download path refused")
    url = (
        "https://raw.githubusercontent.com/semgrep/semgrep-rules/"
        + UPSTREAM
        + "/"
        + path
    )
    opener = urllib.request.build_opener(NoRedirects())
    with opener.open(url, timeout=30) as response:
        content = response.read(2 * 1024 * 1024 + 1)
    if len(content) > 2 * 1024 * 1024:
        raise ValueError("Semgrep rule download size refused")
    return content


def validate_policy(policy=POLICY, manifest_path=MANIFEST):
    manifest = policy_manifest(manifest_path)
    if policy.is_symlink() or (policy / "rules").is_symlink():
        raise ValueError("Symlinked Semgrep policy cache refused")
    expected = {
        "LICENSE": manifest["licenseSha256"],
        **{"rules/" + name: digest for name, digest in manifest["rules"].items()},
    }
    for name, digest in expected.items():
        rule = policy / name
        if any(parent.is_symlink() for parent in [rule, *rule.parents]):
            raise ValueError("Symlinked Semgrep policy source refused")
        if hashlib.sha256(rule.read_bytes()).hexdigest() != digest:
            raise ValueError("Semgrep rule content provenance refused")
    actual = {
        str(path.relative_to(policy / "rules"))
        for path in (policy / "rules").rglob("*")
        if path.is_file() or path.is_symlink()
    }
    if actual != _RULE_PATHS:
        raise ValueError("Semgrep rule inventory refused")


def prepare_policy(policy=POLICY, manifest_path=MANIFEST):
    manifest = policy_manifest(manifest_path)
    if policy.is_symlink():
        raise ValueError("Symlinked Semgrep policy cache refused")
    policy.mkdir(parents=True, exist_ok=True, mode=0o700)
    policy.chmod(0o700)
    expected = {"LICENSE": manifest["licenseSha256"], **manifest["rules"]}
    for source, digest in expected.items():
        target = policy / source if source == "LICENSE" else policy / "rules" / source
        if any(parent.is_symlink() for parent in [target, *target.parents]):
            raise ValueError("Symlinked Semgrep policy source refused")
        if target.exists():
            if hashlib.sha256(target.read_bytes()).hexdigest() != digest:
                raise ValueError("Altered Semgrep policy cache refused without repair")
            continue
        content = download(source)
        if hashlib.sha256(content).hexdigest() != digest:
            raise ValueError("Semgrep rule download checksum refused")
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        # mkdir(parents=True) applies its mode only to the leaf directory.
        # Protect every generated directory inside this internal policy cache.
        for directory in [target.parent, *target.parent.parents]:
            if directory == policy.parent:
                break
            directory.chmod(0o700)
        with tempfile.NamedTemporaryFile(
            dir=target.parent, prefix=".verified-", delete=False
        ) as output:
            temporary = Path(output.name)
            output.write(content)
        temporary.replace(target)
        target.chmod(0o600)
    validate_policy(policy, manifest_path)


def verify_completed_scan(report):
    document = json.loads(report.read_text())
    if (
        document.get("version") != VERSION
        or document.get("errors") != []
        or not document.get("paths", {}).get("scanned")
    ):
        raise ValueError(
            "Semgrep scan did not complete without errors over source files"
        )


def private_scan_directory(root):
    directory = root / ".axiom-runtime/review/semgrep"
    for parent in (root / ".axiom-runtime", directory.parent, directory):
        if parent.is_symlink():
            raise ValueError("Symlinked Semgrep private evidence refused")
        parent.mkdir(exist_ok=True, mode=0o700)
        parent.chmod(0o700)
    return directory


def scan(*, managed=False, root=ROOT, policy=POLICY):
    env = dict(os.environ)
    kind = "managed" if managed else "community"
    report = root / f"semgrep-{kind}.json"
    sarif = root / f"semgrep-{kind}.sarif"
    for output in (report, sarif):
        output.unlink(missing_ok=True)
    if managed and not env.get("SEMGREP_APP_TOKEN"):
        print(
            "Managed Semgrep policy unavailable: no token configured. Mandatory community baseline remains required."
        )
        # Operational fact only; never record token values or scan content.
        status = private_scan_directory(root) / "managed-policy-status.json"
        if status.is_symlink():
            raise ValueError("Symlinked Semgrep private evidence refused")
        status.write_text(
            json.dumps(
                {
                    "managedPolicy": "unavailable",
                    "reason": "SEMGREP_APP_TOKEN not configured",
                    "communityPolicyRequired": True,
                }
            )
            + "\n"
        )
        status.chmod(0o600)
        return
    if not managed:
        prepare_policy(policy)
        # Local rules/metrics-off/version-check-off make this an offline scan.
        env.pop("SEMGREP_APP_TOKEN", None)
    args = ["semgrep", "ci" if managed else "scan"]
    args += (
        ["--no-suppress-errors"]
        if managed
        else ["--config", str(policy / "rules"), "--error", "--strict"]
    )
    args += [
        "--sarif-output",
        str(sarif),
        "--json-output",
        str(report),
        "--metrics=off",
        "--disable-version-check",
    ]
    if not managed:
        args += ["."]
    private = private_scan_directory(root)
    log = private / f"semgrep-{kind}.private.log"
    if log.is_symlink():
        raise ValueError("Symlinked Semgrep private evidence refused")
    previous_umask = os.umask(0o077)
    try:
        with log.open("w") as output:
            log.chmod(0o600)
            result = subprocess.run(
                args,
                cwd=root,
                env=env,
                check=False,
                stdout=output,
                stderr=subprocess.STDOUT,
            )
    finally:
        os.umask(previous_umask)
        for output in (report, sarif):
            if output.is_file():
                output.chmod(0o600)
    if report.is_file():
        findings = json.loads(report.read_text()).get("results", [])
        if not isinstance(findings, list):
            raise ValueError("Semgrep findings evidence refused")
        secret_finding = any(
            isinstance(finding, dict)
            and str(finding.get("check_id", "")).endswith(
                ("detected-private-key", "detected-aws-access-key-id-value")
            )
            for finding in findings
        )
        if findings and (managed or secret_finding):
            # Finding snippets can contain the actual credential. Keep raw
            # evidence private and remove every report exposed to upload steps.
            for output in (report, sarif):
                if output.is_file():
                    target = private / (output.name + ".private")
                    if target.is_symlink():
                        raise ValueError("Symlinked Semgrep private evidence refused")
                    output.replace(target)
                    target.chmod(0o600)
            raise RuntimeError(
                f"Semgrep {kind} refused {len(findings)} finding(s); reports withheld because source snippets may contain credentials"
            )
    if result.returncode:
        raise RuntimeError(f"Semgrep {kind} scan refused (exit {result.returncode})")
    verify_completed_scan(report)
    if not sarif.is_file():
        raise ValueError("Semgrep SARIF evidence missing")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--managed-if-configured", action="store_true")
    parser.add_argument("--prepare-policy", action="store_true")
    args = parser.parse_args()
    try:
        if args.prepare_policy:
            prepare_policy()
        else:
            scan(managed=args.managed_if_configured)
    except (OSError, ValueError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
