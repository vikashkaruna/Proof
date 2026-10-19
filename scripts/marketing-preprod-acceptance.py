#!/usr/bin/env python3
"""Source-bound Hosting publication and actual browser acceptance contracts.

Parent coordinator calls these APIs after its reviewed deployment preflight.
No phase is green from receipt booleans: provider identities, immutable revisions,
Hosting content bytes and actual child acceptance output are verified separately.
https://firebase.google.com/docs/reference/hosting/rest/v1beta1/sites.releases
https://firebase.google.com/docs/hosting/api-deploy
https://cloud.google.com/run/docs/reference/rest/v2/projects.locations.services/get
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import re
import subprocess  # nosec B404  # fixed reviewed local CLI argv; bounded protected evidence logs
from pathlib import Path
from urllib.parse import quote, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

ROOT = Path(__file__).resolve().parents[1]
CORE = frozenset({"marketing", "bff", "auth", "rest", "gateway"})
NAME = re.compile(r"axiom-proof-preprod-[a-z0-9-]+\Z")
SHA = re.compile(r"[a-f0-9]{64}\Z")
MAX_BODY = 16 * 1024 * 1024


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


config = module("marketing_scope", "scripts/marketing-acceptance-config.py")
readback = module("marketing_readback", "scripts/marketing-acceptance-readback.py")


def sha(body):
    return hashlib.sha256(body).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def fresh_private(path: Path, body: dict) -> None:
    if any(parent.is_symlink() for parent in [path, *path.parents]):
        raise ValueError("Symlink evidence refused")
    if path.parent.stat().st_mode & 0o077:
        raise ValueError("Protected evidence directory required")
    descriptor = os.open(
        path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600
    )
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(canonical(body) + b"\n")


def command(argv, log: Path, *, timeout=1800, env=None):
    if (
        log.exists()
        or any(parent.is_symlink() for parent in [log, *log.parents])
        or log.parent.stat().st_mode & 0o077
    ):
        raise ValueError("Fresh protected command log required")
    descriptor = os.open(
        log, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600
    )
    with os.fdopen(descriptor, "wb") as stream:
        result = subprocess.run(  # nosec B603  # fixed reviewed local CLI argv; bounded protected evidence logs
            argv,
            cwd=ROOT,
            env=env,
            stdout=stream,
            stderr=stream,
            timeout=timeout,
            check=False,
        )
    if result.returncode:
        raise ValueError("Actual command failed; protected evidence retained")


def clean_source(release_sha):
    result = subprocess.run(  # nosec B603, B607  # fixed reviewed local CLI argv; bounded protected evidence logs
        ["git", "rev-parse", "HEAD"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=10,
        check=True,
    )
    dirty = subprocess.run(  # nosec B603, B607  # fixed reviewed local CLI argv; bounded protected evidence logs
        ["git", "status", "--porcelain", "--untracked-files=normal"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=10,
        check=True,
    )
    if result.stdout.strip() != release_sha or dirty.stdout.strip():
        raise ValueError("Clean exact release source required")


def inputs(env_file, release_file, services_file):
    config.protected_read(env_file)
    parser = module("literal_marketing_acceptance", "scripts/lib/ops-env-parse.py")
    env = parser.parse(env_file)
    release, release_hash = (
        (release_file, sha(canonical(release_file)))
        if isinstance(release_file, dict)
        else config.json_input(release_file)
    )
    services, services_hash = (
        (services_file, sha(canonical(services_file)))
        if isinstance(services_file, dict)
        else config.json_input(services_file)
    )
    project = env.get("GCP_PROJECT_ID", "")
    if (
        not re.fullmatch(r"[a-z][a-z0-9-]{4,28}[a-z0-9]", project)
        or env.get("ENVIRONMENT") != "preprod"
        or env.get("GCP_REGION") != "asia-south1"
        or env.get("AXIOM_DEPLOYMENT_PROFILE") != "marketing"
        or env.get("AXIOM_CONTACT_EMAIL_MODE") != "disabled"
        or env.get("AXIOM_REPORT_EMAIL_MODE") != "disabled"
    ):
        raise ValueError("Exact Mumbai marketing preprod/no-mail profile required")
    if (
        not re.fullmatch(r"[a-f0-9]{40}", release.get("release_sha", ""))
        or set(release.get("images", {})) != CORE
        or services.get("project") != project
        or services.get("release_sha") != release["release_sha"]
        or set(services.get("cloud_run_uris", {})) != CORE
    ):
        raise ValueError("Exact immutable source and service receipt required")
    for image in release["images"].values():
        if not re.fullmatch(
            r"asia-south1-docker\.pkg\.dev/"
            + re.escape(project)
            + r"/[^/]+/[^@]+@sha256:[a-f0-9]{64}",
            image,
        ):
            raise ValueError("Same-project immutable images required")
    for component in CORE:
        if not NAME.fullmatch(
            env.get("MARKETING_" + component.upper() + "_SERVICE_NAME", "")
        ) or not NAME.fullmatch(
            env.get("MARKETING_" + component.upper() + "_ACCOUNT_ID", "")
        ):
            raise ValueError("Explicit isolated service and identity names required")
        config.origin(services["cloud_run_uris"][component], True)
    if (
        env.get("FIREBASE_MARKETING_SERVICE_ID")
        != env["MARKETING_MARKETING_SERVICE_NAME"]
        or not re.fullmatch(
            r"[a-z][a-z0-9-]{3,28}[a-z0-9]", env.get("FIREBASE_HOSTING_SITE_ID", "")
        )
        or config.origin(env["AXIOM_PROOF_MARKETING_URL"])
        != "https://stg.axiomproof.ai"
    ):
        raise ValueError("Selected preprod Hosting/service/origin binding required")
    return (
        env,
        release,
        services,
        {
            "env_sha256": sha(config.protected_read(env_file)),
            "release_sha256": release_hash,
            "services_receipt_sha256": services_hash,
        },
    )


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def get(url, token="", *, limit=MAX_BODY):  # nosec B107  # configuration secret reference/key name or absent optional bearer, never a credential value
    parsed = urlparse(url)
    if (
        parsed.scheme != "https"
        or parsed.username
        or parsed.password
        or parsed.port not in (None, 443)
        or parsed.fragment
    ):
        raise ValueError("HTTPS readback required")
    if token and parsed.hostname not in {
        "run.googleapis.com",
        "firebasehosting.googleapis.com",
    }:
        raise ValueError("Credential destination refused")
    request = Request(
        url,
        headers={
            "Accept-Encoding": "identity",
            **({"Authorization": "Bearer " + token} if token else {}),
        },
    )
    with build_opener(NoRedirect).open(request, timeout=90) as response:
        body = response.read(limit + 1)
        if response.status != 200 or len(body) > limit:
            raise ValueError("Successful bounded actual readback required")
    return body


def get_json(url, token, transport=get):
    value = json.loads(transport(url, token))
    if not isinstance(value, dict):
        raise TypeError("Provider object required")
    return value


def live_services(env, release, services, token, transport=get):
    result = {}
    for component in sorted(CORE):
        name = f"projects/{env['GCP_PROJECT_ID']}/locations/asia-south1/services/{env['MARKETING_' + component.upper() + '_SERVICE_NAME']}"
        service = get_json("https://run.googleapis.com/v2/" + name, token, transport)
        revision = service.get("latestReadyRevision", "")
        if (
            service.get("name") != name
            or service.get("uri") != services["cloud_run_uris"][component]
            or service.get("reconciling") is not False
            or str(service.get("generation")) != str(service.get("observedGeneration"))
            or service.get("terminalCondition", {}).get("state")
            != "CONDITION_SUCCEEDED"
            or revision != service.get("latestCreatedRevision")
            or not re.fullmatch(re.escape(name) + r"/revisions/[a-z0-9-]+", revision)
        ):
            raise ValueError("Exact ready service/revision/URI required")
        traffic = service.get("trafficStatuses", [])
        if (
            len(traffic) != 1
            or traffic[0].get("revision") != revision
            or traffic[0].get("percent") != 100
        ):
            raise ValueError("Entire live traffic must target reviewed ready revision")
        observed = get_json(
            "https://run.googleapis.com/v2/" + revision, token, transport
        )
        template = service.get("template", {})
        expected_account = f"{env['MARKETING_' + component.upper() + '_ACCOUNT_ID']}@{env['GCP_PROJECT_ID']}.iam.gserviceaccount.com"
        if (
            observed.get("name") != revision
            or observed.get("reconciling") is not False
            or not any(
                c.get("type") == "Ready" and c.get("state") == "CONDITION_SUCCEEDED"
                for c in observed.get("conditions", [])
            )
        ):
            raise ValueError("Actual immutable revision is not ready")
        for actual in (template, observed):
            containers = actual.get("containers", [])
            if (
                actual.get("serviceAccount") != expected_account
                or len(containers) != 1
                or containers[0].get("image") != release["images"][component]
            ):
                raise ValueError("Image or runtime identity differs from release")
            literals = {
                v["name"]: v.get("value")
                for v in containers[0].get("env", [])
                if "value" in v
            }
            if (
                literals.get("AXIOM_RELEASE_SHA") != release["release_sha"]
                or literals.get("ENVIRONMENT") != "preprod"
            ):
                raise ValueError("Live source/environment differs")
            required = {
                "gateway": {
                    "SUPABASE_AUTH_UPSTREAM": services["cloud_run_uris"]["auth"],
                    "SUPABASE_REST_UPSTREAM": services["cloud_run_uris"]["rest"],
                },
                "bff": {
                    "SUPABASE_URL": services["cloud_run_uris"]["gateway"],
                    "AXIOM_CONTACT_EMAIL_MODE": "disabled",
                    "AXIOM_REPORT_EMAIL_MODE": "disabled",
                },
                "marketing": {
                    "BFF_URL": services["cloud_run_uris"]["bff"],
                    "AXIOM_PROOF_MARKETING_URL": env["AXIOM_PROOF_MARKETING_URL"],
                    "AXIOM_PROOF_PLATFORM_URL": env["AXIOM_PROOF_PLATFORM_URL"],
                },
                "auth": {
                    "API_EXTERNAL_URL": env["AXIOM_PROOF_MARKETING_URL"],
                    "GOTRUE_SITE_URL": env["AXIOM_PROOF_MARKETING_URL"],
                },
            }.get(component, {})
            if any(literals.get(key) != value for key, value in required.items()):
                raise ValueError("Live dependency/origin/email binding differs")
        result[component] = {
            "service": name,
            "revision": revision,
            "image": release["images"][component],
            "uri": service["uri"],
            "service_account": expected_account,
            "configuration_sha256": sha(canonical(template)),
        }
    return result


def exported_config(value, env):
    hosting = value.get("hosting")
    if (
        not isinstance(hosting, dict)
        or hosting.get("site") != env["FIREBASE_HOSTING_SITE_ID"]
        or hosting.get("cleanUrls") is not True
        or hosting.get("trailingSlash") is not False
    ):
        raise ValueError("Exact selected-site static configuration required")
    expected = [
        {
            "source": path,
            "run": {
                "serviceId": env["FIREBASE_MARKETING_SERVICE_ID"],
                "region": "asia-south1",
            },
        }
        for path in ("/api/**", "/gap-scan/report/**")
    ]
    if hosting.get("rewrites") != expected or hosting.get("redirects"):
        raise ValueError("Only reviewed private runtime rewrites allowed")
    headers = {
        row["source"]: {h["key"].lower(): h["value"] for h in row["headers"]}
        for row in hosting.get("headers", [])
    }
    for path in ("/api/**", "/gap-scan/report/**"):
        if headers.get(path, {}).get("cache-control") != "private, no-store, max-age=0":
            raise ValueError("Private runtime cache refusal required")
    return {
        "cleanUrls": True,
        "trailingSlashBehavior": "REMOVE",
        "rewrites": [{"glob": row["source"], "run": row["run"]} for row in expected],
        "headers": [
            {"glob": path, "headers": value} for path, value in sorted(headers.items())
        ],
    }


def export_manifest(directory, env):
    directory = Path(directory)
    if (
        directory.is_symlink()
        or not directory.resolve().is_relative_to(ROOT / ".axiom-runtime")
        or any(parent.is_symlink() for parent in directory.parents)
        or directory.stat().st_mode & 0o077
        or directory.stat().st_uid != os.getuid()
    ):
        raise ValueError("Isolated prepared export directory required")
    file = directory / "firebase.json"
    if file.is_symlink():
        raise ValueError("Export configuration symlink refused")
    raw = file.read_bytes()
    parsed = json.loads(raw)
    serving = exported_config(parsed, env)
    public = Path(parsed["hosting"]["public"])
    if public.is_symlink() or not public.resolve().is_relative_to(directory.resolve()):
        raise ValueError("Export public root outside prepared directory")
    files = {}
    for path in sorted(public.rglob("*")):
        if path.is_symlink():
            raise ValueError("Export symlinks refused")
        if path.is_file():
            relative = path.relative_to(public).as_posix()
            if (
                not re.fullmatch(r"[a-zA-Z0-9_./-]+", relative)
                or any(part.startswith(".") for part in relative.split("/"))
                or path.stat().st_size > MAX_BODY
            ):
                raise ValueError("Unsafe or oversized exported file")
            files["/" + relative] = sha(path.read_bytes())
    if "/index.html" not in files or not files or len(files) > 10000:
        raise ValueError("Real static export required")
    return {
        "directory": str(directory.resolve()),
        "config_sha256": sha(raw),
        "serving_config": serving,
        "files": files,
        "files_sha256": sha(canonical(files)),
    }


def site_readback(env, token, transport=get):
    site = env["FIREBASE_HOSTING_SITE_ID"]
    root = "https://firebasehosting.googleapis.com/v1beta1/"
    metadata = get_json(
        root + f"projects/{env['GCP_PROJECT_ID']}/sites/{site}", token, transport
    )
    allowed = {env["GCP_PROJECT_ID"], env.get("GCP_PROJECT_NUMBER", "")}
    if (
        metadata.get("name")
        not in {f"projects/{project}/sites/{site}" for project in allowed if project}
        or config.origin(metadata["defaultUrl"]) != "https://" + site + ".web.app"
    ):
        raise ValueError("Actual Firebase site belongs to another target")
    return metadata


def normalized_live_config(value):
    # REST ServingConfig representation differs from local Firebase CLI config.
    # AUTO is the documented app-association default; no custom routing ignored.
    value = dict(value)
    if value.pop("appAssociation", "AUTO") != "AUTO":
        raise ValueError("Unexpected app association configuration")
    if value.pop("redirects", []):
        raise ValueError("Unexpected Hosting redirects")
    if value.pop("i18n", {}):
        raise ValueError("Unexpected Hosting internationalization")
    headers = value.get("headers", [])
    value["headers"] = sorted(
        [
            {
                "glob": row["glob"],
                "headers": {k.lower(): v for k, v in row["headers"].items()},
            }
            for row in headers
        ],
        key=lambda row: row["glob"],
    )
    if any(set(row) != {"glob", "headers"} for row in headers):
        raise ValueError("Unexpected Hosting header matching")
    return value


def hosting_readback(env, release, services, manifest, bindings, token, transport=get):
    site = env["FIREBASE_HOSTING_SITE_ID"]
    root = "https://firebasehosting.googleapis.com/v1beta1/"
    metadata = site_readback(env, token, transport)
    listing = get_json(root + f"sites/{site}/releases?pageSize=1", token, transport)
    releases = listing.get("releases", [])
    if len(releases) != 1:
        raise ValueError("Actual latest release required")
    active = releases[0]
    version_name = active.get("version", {}).get("name", "")
    if (
        active.get("type") != "DEPLOY"
        or not re.fullmatch(
            r"sites/" + re.escape(site) + r"/releases/[a-zA-Z0-9_-]+",
            active.get("name", ""),
        )
        or not re.fullmatch(
            r"sites/" + re.escape(site) + r"/versions/[a-zA-Z0-9_-]+", version_name
        )
    ):
        raise ValueError("Actual active immutable Hosting release required")
    version = get_json(root + version_name, token, transport)
    if (
        version.get("name") != version_name
        or version.get("status") != "FINALIZED"
        or normalized_live_config(version.get("config", {}))
        != manifest["serving_config"]
    ):
        raise ValueError("Active Hosting config/version differs from reviewed export")
    seen = {}
    for path, digest in manifest["files"].items():
        url_path = path
        if path.endswith("/index.html"):
            url_path = path[:-10].rstrip("/") or "/"
        elif path.endswith(".html"):
            url_path = path[:-5]
        body = transport(metadata["defaultUrl"] + quote(url_path, safe="/"), "")
        if sha(body) != digest:
            raise ValueError("Live Firebase static bytes differ from immutable export")
        seen[path] = digest
    after = get_json(root + f"sites/{site}/releases?pageSize=1", token, transport)
    if after.get("releases", []) != releases:
        raise ValueError("Hosting release changed during content readback")
    current = live_services(env, release, services, token, transport)
    if current != bindings:
        raise ValueError(
            "Runtime release/configuration changed during Hosting readback"
        )
    return {
        "project": env["GCP_PROJECT_ID"],
        "release_sha": release["release_sha"],
        "hosting_url": metadata["defaultUrl"],
        "site_metadata": metadata,
        "release_name": active["name"],
        "version_name": version_name,
        "serving_config_sha256": sha(
            canonical(normalized_live_config(version["config"]))
        ),
        "files_sha256": sha(canonical(seen)),
        "live_services": current,
    }


def prepare_hosting(env_file, release_file, services_file, work):
    env, release, _services, hashes = inputs(env_file, release_file, services_file)
    clean_source(release["release_sha"])
    command(
        [
            "bash",
            str(ROOT / "scripts/deploy-firebase-marketing.sh"),
            "--env-file",
            str(env_file),
            "--build-only",
            env["GCP_PROJECT_ID"],
        ],
        work / "hosting-build.private.log",
    )
    log = (work / "hosting-build.private.log").read_text(errors="replace")
    matches = re.findall(
        r"(?m)^Static export and Firebase configuration prepared at: (.+)$", log
    )
    if len(matches) != 1:
        raise ValueError("Actual prepared export output required")
    manifest = export_manifest(Path(matches[0]), env)
    plan = {
        "schema_version": 1,
        "project": env["GCP_PROJECT_ID"],
        "release_sha": release["release_sha"],
        **hashes,
        "export": manifest,
    }
    fresh_private(work / "hosting.plan.private.json", plan)
    return plan


def publish_hosting(
    env_file, release_file, services_file, work, approval, token, transport=get
):
    env, release, services, hashes = inputs(env_file, release_file, services_file)
    plan, plan_hash = config.json_input(work / "hosting.plan.private.json")
    if (
        any(plan.get(key) != value for key, value in hashes.items())
        or plan.get("release_sha") != release["release_sha"]
        or plan.get("project") != env["GCP_PROJECT_ID"]
        or export_manifest(Path(plan["export"]["directory"]), env) != plan["export"]
    ):
        raise ValueError("Hosting plan/source/export changed")
    clean_source(release["release_sha"])
    if (
        approval.get("source") != "human-user"
        or approval.get("project") != env["GCP_PROJECT_ID"]
        or approval.get("release_sha") != release["release_sha"]
        or approval.get("profile") != "marketing"
        or approval.get("region") != "asia-south1"
        or "hosting" not in approval.get("allowed_phases", [])
        or approval.get("dry_run_plan_sha256") != plan_hash
        or approval.get("rollback")
        != {"preserve_database": True, "prevent_publication": True, "production": False}
    ):
        raise ValueError("Exact reviewed Hosting plan authorization required")
    if any(
        (work / name).exists() or (work / name).is_symlink()
        for name in ("hosting.receipt.private.json", "hosting-deploy.private.log")
    ):
        raise ValueError("Hosting already has a receipt; no automatic redeploy")
    bindings = live_services(env, release, services, token, transport)
    site_readback(env, token, transport)
    command(
        [
            "firebase",
            "deploy",
            "--config",
            str(Path(plan["export"]["directory"]) / "firebase.json"),
            "--only",
            "hosting",
            "--project",
            env["GCP_PROJECT_ID"],
            "--non-interactive",
        ],
        work / "hosting-deploy.private.log",
    )
    receipt = hosting_readback(
        env, release, services, plan["export"], bindings, token, transport
    )
    receipt.update({**hashes, "hosting_plan_sha256": plan_hash})
    fresh_private(work / "hosting.receipt.private.json", receipt)
    return receipt


def run_browser_acceptance(
    env_file,
    release_file,
    services_file,
    hosting_file,
    approval_file,
    work,
    token,
    transport=get,
):
    env, release, services, _ = inputs(env_file, release_file, services_file)
    clean_source(release["release_sha"])
    hosting, _ = config.json_input(hosting_file)
    plan, _ = config.json_input(work / "hosting.plan.private.json")
    before = live_services(env, release, services, token, transport)
    current = hosting_readback(
        env, release, services, plan["export"], before, token, transport
    )
    if any(hosting.get(key) != value for key, value in current.items()):
        raise ValueError("Hosting receipt does not match actual current release")
    scope = config.prepare(env_file, services_file, hosting_file, approval_file)
    scope_path = work / "browser-config.private.json"
    fresh_private(scope_path, scope)
    browser_dir = work / "browser"
    if not browser_dir.resolve().is_relative_to(ROOT / ".axiom-runtime/review"):
        raise ValueError("Browser evidence requires a fresh protected review directory")
    command(
        [
            "pnpm",
            "exec",
            "tsx",
            str(ROOT / "scripts/verify-marketing-preprod.mts"),
            "--config",
            str(scope_path),
            "--output",
            str(browser_dir),
        ],
        work / "browser-acceptance.private.log",
        timeout=1800,
    )
    browser, browser_hash = config.json_input(browser_dir / "acceptance.private.json")
    library, library_hash = config.json_input(
        ROOT / "infra/supabase/marketing-library.json"
    )
    expected = readback.expected_source(browser, library)
    if (
        browser.get("config") != scope
        or expected.get("releaseSha") != release["release_sha"]
    ):
        raise ValueError("Actual browser source/result differs from approved scope")
    after = live_services(env, release, services, token, transport)
    current_after = hosting_readback(
        env, release, services, plan["export"], after, token, transport
    )
    if before != after or current_after != current:
        raise ValueError("Release changed during actual browser requests")
    receipt = {
        "schema_version": 1,
        "project": env["GCP_PROJECT_ID"],
        "release_sha": release["release_sha"],
        "phase": "browser-api",
        "browser_proof_sha256": browser_hash,
        "library_sha256": library_hash,
        "expected_readback": expected,
        "live_services": after,
        "hosting_version": current["version_name"],
        "remaining_gates": [
            "independent-readonly-retained-row-readback",
            "lifecycle-cold-stop-wake-and-inflight-refusal",
        ],
    }
    fresh_private(work / "browser-api.receipt.private.json", receipt)
    return receipt


# Parent coordinator-facing names; mapping manifests or protected file paths
# are accepted, and their exact canonical/file digest is bound in the plan.
prepare_hosting_export = prepare_hosting
publish_hosting_export = publish_hosting


if __name__ == "__main__":
    print("Use the reviewed marketing coordinator APIs; no action performed.")
    raise SystemExit(2)


def readback_basename(phase):
    if phase not in ("readback", "readback-postwake"):
        raise ValueError("Fixed baseline or postwake readback phase required")
    return "acceptance-" + phase


def prepare_readback_job(
    env_file, browser_file, library_file, source, work, *, phase="readback"
):
    """Prepare-only API: real browser proof + exact protected source artifact."""
    basename = readback_basename(phase)
    base = source.get("MARKETING_MIGRATION_JOB_NAME", "")
    if (
        not re.fullmatch(r"axiom-proof-preprod-[a-z0-9-]+", base)
        or source.get("MARKETING_ACCEPTANCE_JOB_NAME") != base + "-" + phase
    ):
        raise ValueError("Exact phase-specific readback Job name required")
    config.protected_read(env_file)
    parser = module("literal_readback_plan", "scripts/lib/ops-env-parse.py")
    env = parser.parse(env_file)
    for key in ("GCP_PROJECT_ID", "ENVIRONMENT", "GCP_REGION"):
        if source.get(key) != env.get(key):
            raise ValueError("Readback Job source differs from selected environment")
    browser, browser_hash = config.json_input(browser_file)
    library, library_hash = config.json_input(library_file)
    clean_source(browser["config"]["releaseSha"])
    job = module("acceptance_private_job", "scripts/marketing-acceptance-job.py")
    prepared = job.descriptor(source, browser, library)
    prepared["input_file_hashes"] = {
        "browser": browser_hash,
        "library": library_hash,
        "env": sha(config.protected_read(env_file)),
    }
    prepared["phase"] = basename
    prepared["readback_phase"] = phase
    prepared["readback_job_base"] = base
    fresh_private(work / (basename + ".plan.private.json"), prepared)
    return prepared


def record_readback_execution(
    plan_file,
    actual_job_file,
    execution_file,
    log_entries_file,
    work,
    *,
    phase="readback",
):
    """Verify provider GET and exact execution log readback; no cloud action."""
    basename = readback_basename(phase)
    if (
        Path(plan_file).resolve()
        != (work / (basename + ".plan.private.json")).resolve()
    ):
        raise ValueError("Exact phase-specific readback plan required")
    prepared, plan_hash = config.json_input(plan_file)
    base = prepared.get("readback_job_base", "")
    if (
        prepared.get("readback_phase") != phase
        or prepared.get("phase") != basename
        or not re.fullmatch(r"axiom-proof-preprod-[a-z0-9-]+", base)
        or prepared["job"]["name"].rsplit("/", 1)[1] != base + "-" + phase
    ):
        raise ValueError("Readback plan phase/Job binding differs")
    actual_job, _ = config.json_input(actual_job_file)
    execution, _ = config.json_input(execution_file)
    logs, _ = config.json_input(log_entries_file)
    job = module("acceptance_private_job_result", "scripts/marketing-acceptance-job.py")
    result = job.verify_execution(prepared, actual_job, execution, logs["entries"])
    result["plan_file_sha256"] = plan_hash
    result["phase"] = basename
    result["readback_phase"] = phase
    fresh_private(work / (basename + ".receipt.private.json"), result)
    return result
