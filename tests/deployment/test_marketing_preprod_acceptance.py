"""Causal mocked provider contracts; these fixtures are not cloud acceptance."""

import copy
import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "publication", ROOT / "scripts/marketing-preprod-acceptance.py"
)
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)


@pytest.fixture
def fixture(tmp_path, monkeypatch):
    tmp_path.chmod(0o700)
    monkeypatch.setattr(h, "ROOT", tmp_path)
    directory = tmp_path / ".axiom-runtime/export"
    directory.mkdir(parents=True, mode=0o700)
    public = directory / "public"
    public.mkdir()
    (public / "index.html").write_bytes(b"immutable static fixture")
    env = {
        "FIREBASE_HOSTING_SITE_ID": "axiom-proof-preprod-fixture",
        "FIREBASE_MARKETING_SERVICE_ID": "axiom-proof-preprod-marketing",
        "GCP_PROJECT_ID": "test-project",
    }
    local = {
        "hosting": {
            "site": env["FIREBASE_HOSTING_SITE_ID"],
            "public": str(public),
            "cleanUrls": True,
            "trailingSlash": False,
            "rewrites": [
                {
                    "source": path,
                    "run": {
                        "serviceId": env["FIREBASE_MARKETING_SERVICE_ID"],
                        "region": "asia-south1",
                    },
                }
                for path in ("/api/**", "/gap-scan/report/**")
            ],
            "headers": [
                {
                    "source": path,
                    "headers": [
                        {
                            "key": "Cache-Control",
                            "value": "private, no-store, max-age=0",
                        }
                    ],
                }
                for path in ("/api/**", "/gap-scan/report/**")
            ],
        }
    }
    (directory / "firebase.json").write_text(json.dumps(local))
    manifest = h.export_manifest(directory, env)
    site = env["FIREBASE_HOSTING_SITE_ID"]
    version = {
        "name": f"sites/{site}/versions/v1",
        "status": "FINALIZED",
        "config": copy.deepcopy(manifest["serving_config"]),
    }
    release = {
        "name": f"sites/{site}/releases/r1",
        "type": "DEPLOY",
        "version": {"name": version["name"]},
    }
    metadata = {
        "name": f"projects/test-project/sites/{site}",
        "defaultUrl": f"https://{site}.web.app",
    }
    data = {
        "metadata": metadata,
        "version": version,
        "releases": [release],
        "body": b"immutable static fixture",
    }
    calls = []

    def transport(url, token):
        calls.append((url, token))
        if "firebasehosting.googleapis.com" not in url:
            assert token == ""
            return data["body"]
        if "/releases?" in url:
            value = {"releases": data["releases"]}
        elif "/versions/" in url:
            value = data["version"]
        else:
            value = data["metadata"]
        return json.dumps(value).encode()

    monkeypatch.setattr(h, "live_services", lambda *args: {"actual": "revision"})
    return env, manifest, data, transport, calls, local


def read(f):
    env, manifest, _, transport, _, _ = f
    return h.hosting_readback(
        env,
        {"release_sha": "a" * 40},
        {},
        manifest,
        {"actual": "revision"},
        "PRIVATE_TOKEN",
        transport,
    )


def test_actual_provider_release_config_content_bound(fixture):
    receipt = read(fixture)
    assert receipt["version_name"].endswith("/v1")
    assert receipt["files_sha256"] == fixture[1]["files_sha256"]
    assert all(token == "" for url, token in fixture[4] if ".web.app" in url)


@pytest.mark.parametrize(
    "mutation",
    [
        "project",
        "site",
        "content",
        "version",
        "rewrite",
        "cache",
        "slash",
        "association",
        "unknown",
    ],
)
def test_real_provider_mismatch_refuses(fixture, mutation):
    data = fixture[2]
    if mutation == "project":
        data["metadata"]["name"] = "projects/foreign/sites/axiom-proof-preprod-fixture"
    elif mutation == "site":
        data["metadata"]["defaultUrl"] = "https://foreign.web.app"
    elif mutation == "content":
        data["body"] = b"different release"
    elif mutation == "version":
        data["version"]["status"] = "CREATED"
    elif mutation == "rewrite":
        data["version"]["config"]["rewrites"][0]["run"]["serviceId"] = "foreign"
    elif mutation == "cache":
        data["version"]["config"]["headers"][0]["headers"]["cache-control"] = "public"
    elif mutation == "slash":
        data["version"]["config"]["trailingSlashBehavior"] = "ADD"
    elif mutation == "association":
        data["version"]["config"]["appAssociation"] = "NONE"
    else:
        data["version"]["config"]["unreviewed"] = "routing"
    with pytest.raises(ValueError):
        read(fixture)


def test_release_change_during_readback_refuses(fixture):
    original = fixture[3]
    count = 0

    def moving(url, token):
        nonlocal count
        if "/releases?" in url:
            count += 1
            if count == 2:
                fixture[2]["releases"][0]["name"] += "2"
        return original(url, token)

    env, manifest = fixture[:2]
    with pytest.raises(ValueError, match="changed during"):
        h.hosting_readback(
            env,
            {"release_sha": "a" * 40},
            {},
            manifest,
            {"actual": "revision"},
            "TOKEN",
            moving,
        )


def test_runtime_change_during_readback_refuses(fixture, monkeypatch):
    monkeypatch.setattr(h, "live_services", lambda *args: {"actual": "new-revision"})
    with pytest.raises(ValueError, match="Runtime release"):
        read(fixture)


def test_export_mutation_changes_descriptor(fixture):
    env, manifest = fixture[:2]
    (Path(manifest["directory"]) / "public/index.html").write_bytes(b"changed")
    assert h.export_manifest(Path(manifest["directory"]), env) != manifest


@pytest.mark.parametrize("unsafe", ["symlink", "public-outside", "public-mode"])
def test_export_escape_and_unprotected_directory_refused(fixture, tmp_path, unsafe):
    env, manifest, _, _, _, local = fixture
    directory = Path(manifest["directory"])
    if unsafe == "symlink":
        (directory / "public/leak").symlink_to(tmp_path / "secret")
    elif unsafe == "public-mode":
        directory.chmod(0o755)
    else:
        local["hosting"]["public"] = str(tmp_path)
        (directory / "firebase.json").write_text(json.dumps(local))
    with pytest.raises(ValueError):
        h.export_manifest(directory, env)


def test_command_both_streams_private_and_failure_fixed(tmp_path, capsys):
    tmp_path.chmod(0o700)
    marker = "SYNTHETIC_PRIVATE_MARKER"
    log = tmp_path / "private.log"
    with pytest.raises(ValueError, match="Actual command failed"):
        h.command(
            [
                "python3",
                "-c",
                f"import sys; print('{marker}'); print('{marker}',file=sys.stderr); sys.exit(7)",
            ],
            log,
        )
    assert marker not in str(capsys.readouterr())
    assert log.read_text().count(marker) == 2
    assert log.stat().st_mode & 0o777 == 0o600
    with pytest.raises(ValueError):
        h.command(["python3", "-c", "pass"], log)


def test_private_evidence_symlink_refused(tmp_path):
    tmp_path.chmod(0o700)
    target = tmp_path / "target"
    target.write_text("preserve")
    link = tmp_path / "link"
    link.symlink_to(target)
    with pytest.raises(ValueError):
        h.fresh_private(link, {"fake": True})
    assert target.read_text() == "preserve"


@pytest.mark.parametrize(
    "url",
    [
        "http://run.googleapis.com/v2/x",
        "https://attacker.invalid/x",
        "https://user@run.googleapis.com/v2/x",
    ],
)
def test_bearer_destination_and_https_refused_without_network(url):
    with pytest.raises(ValueError):
        h.get(url, "SYNTHETIC_TOKEN")


@pytest.fixture
def publication(fixture, tmp_path, monkeypatch):
    env, manifest = fixture[:2]
    release = {"release_sha": "a" * 40}
    hashes = {"services_receipt_sha256": "b" * 64}
    monkeypatch.setattr(h, "inputs", lambda *args: (env, release, {}, hashes))
    monkeypatch.setattr(h, "clean_source", lambda *args: None)
    plan = {
        "schema_version": 1,
        "project": env["GCP_PROJECT_ID"],
        "release_sha": release["release_sha"],
        **hashes,
        "export": manifest,
    }
    plan_path = tmp_path / "hosting.plan.private.json"
    h.fresh_private(plan_path, plan)
    approval = {
        "source": "human-user",
        "project": env["GCP_PROJECT_ID"],
        "release_sha": release["release_sha"],
        "profile": "marketing",
        "region": "asia-south1",
        "allowed_phases": ["hosting"],
        "dry_run_plan_sha256": h.sha(plan_path.read_bytes()),
        "rollback": {
            "preserve_database": True,
            "prevent_publication": True,
            "production": False,
        },
    }
    calls = []
    monkeypatch.setattr(h, "command", lambda argv, log, **kwargs: calls.append(argv))
    return approval, calls


def test_publish_fixed_command_and_real_readback(fixture, publication, tmp_path):
    approval, calls = publication
    result = h.publish_hosting(
        None, None, None, tmp_path, approval, "TOKEN", fixture[3]
    )
    assert len(calls) == 1
    assert calls[0] == [
        "firebase",
        "deploy",
        "--config",
        fixture[1]["directory"] + "/firebase.json",
        "--only",
        "hosting",
        "--project",
        "test-project",
        "--non-interactive",
    ]
    assert result["version_name"].endswith("/v1")
    assert (tmp_path / "hosting.receipt.private.json").stat().st_mode & 0o777 == 0o600


@pytest.mark.parametrize(
    "failure", ["approval", "export", "ownership", "existing-log", "symlink-receipt"]
)
def test_publish_preflight_refuses_before_mutation(
    fixture, publication, tmp_path, failure
):
    approval, calls = publication
    if failure == "approval":
        approval["dry_run_plan_sha256"] = "0" * 64
    elif failure == "export":
        (Path(fixture[1]["directory"]) / "public/index.html").write_text("changed")
    elif failure == "ownership":
        fixture[2]["metadata"]["name"] = (
            "projects/foreign/sites/axiom-proof-preprod-fixture"
        )
    elif failure == "existing-log":
        (tmp_path / "hosting-deploy.private.log").write_text("prior evidence")
    else:
        (tmp_path / "hosting.receipt.private.json").symlink_to(tmp_path / "missing")
    with pytest.raises(ValueError):
        h.publish_hosting(None, None, None, tmp_path, approval, "TOKEN", fixture[3])
    assert calls == []


def test_no_receipt_when_real_deploy_command_fails(
    fixture, publication, tmp_path, monkeypatch
):
    def fail(*args, **kwargs):
        raise ValueError("Actual command failed")

    monkeypatch.setattr(h, "command", fail)
    with pytest.raises(ValueError):
        h.publish_hosting(
            None, None, None, tmp_path, publication[0], "TOKEN", fixture[3]
        )
    assert not (tmp_path / "hosting.receipt.private.json").exists()


def test_no_green_receipt_when_postdeploy_content_differs(
    fixture, publication, tmp_path
):
    fixture[2]["body"] = b"wrong deployed content"
    with pytest.raises(ValueError):
        h.publish_hosting(
            None, None, None, tmp_path, publication[0], "TOKEN", fixture[3]
        )
    assert len(publication[1]) == 1
    assert not (tmp_path / "hosting.receipt.private.json").exists()


@pytest.fixture
def runtime():
    env = {
        "GCP_PROJECT_ID": "test-project",
        "AXIOM_PROOF_MARKETING_URL": "https://stg.axiomproof.ai",
        "AXIOM_PROOF_PLATFORM_URL": "https://app.axiomproof.ai",
    }
    release = {
        "release_sha": "a" * 40,
        "images": {
            c: "asia-south1-docker.pkg.dev/test-project/runtime/"
            + c
            + "@sha256:"
            + "b" * 64
            for c in h.CORE
        },
    }
    services = {
        "cloud_run_uris": {
            c: f"https://axiom-proof-preprod-{c}-fixture.run.app" for c in h.CORE
        }
    }
    data = {}
    for c in h.CORE:
        env["MARKETING_" + c.upper() + "_SERVICE_NAME"] = "axiom-proof-preprod-" + c
        env["MARKETING_" + c.upper() + "_ACCOUNT_ID"] = "axiom-proof-preprod-" + c
        name = f"projects/test-project/locations/asia-south1/services/axiom-proof-preprod-{c}"
        revision = name + "/revisions/rev-1"
        literals = {"AXIOM_RELEASE_SHA": "a" * 40, "ENVIRONMENT": "preprod"}
        literals.update(
            {
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
            }.get(c, {})
        )
        template = {
            "serviceAccount": f"axiom-proof-preprod-{c}@test-project.iam.gserviceaccount.com",
            "containers": [
                {
                    "image": release["images"][c],
                    "env": [{"name": k, "value": v} for k, v in literals.items()],
                }
            ],
        }
        data[name] = {
            "name": name,
            "uri": services["cloud_run_uris"][c],
            "reconciling": False,
            "generation": "2",
            "observedGeneration": "2",
            "terminalCondition": {"state": "CONDITION_SUCCEEDED"},
            "latestReadyRevision": revision,
            "latestCreatedRevision": revision,
            "trafficStatuses": [{"revision": revision, "percent": 100}],
            "template": copy.deepcopy(template),
        }
        data[revision] = {
            "name": revision,
            "reconciling": False,
            "conditions": [{"type": "Ready", "state": "CONDITION_SUCCEEDED"}],
            **copy.deepcopy(template),
        }

    def transport(url, token):
        assert token == "TOKEN"
        return json.dumps(
            data[url.removeprefix("https://run.googleapis.com/v2/")]
        ).encode()

    return env, release, services, data, transport


def test_real_service_and_immutable_revision_bindings(runtime):
    env, release, services, _, transport = runtime
    result = h.live_services(env, release, services, "TOKEN", transport)
    assert set(result) == h.CORE
    assert all(row["image"].endswith("b" * 64) for row in result.values())


@pytest.mark.parametrize(
    "failure",
    [
        "image",
        "identity",
        "source",
        "email",
        "uri",
        "traffic",
        "generation",
        "ready",
        "replacement",
    ],
)
def test_runtime_readback_refuses_changed_binding(runtime, failure):
    env, release, services, data, transport = runtime
    name = (
        "projects/test-project/locations/asia-south1/services/axiom-proof-preprod-bff"
    )
    service = data[name]
    revision = data[service["latestReadyRevision"]]
    if failure == "image":
        revision["containers"][0]["image"] = release["images"]["auth"]
    elif failure == "identity":
        revision["serviceAccount"] = "foreign@test-project.iam.gserviceaccount.com"
    elif failure in ("source", "email"):
        key = "AXIOM_RELEASE_SHA" if failure == "source" else "AXIOM_REPORT_EMAIL_MODE"
        next(row for row in revision["containers"][0]["env"] if row["name"] == key)[
            "value"
        ] = "WRONG"
    elif failure == "uri":
        service["uri"] = services["cloud_run_uris"]["auth"]
    elif failure == "traffic":
        service["trafficStatuses"][0]["percent"] = 99
    elif failure == "generation":
        service["observedGeneration"] = "1"
    elif failure == "ready":
        revision["conditions"][0]["state"] = "CONDITION_FAILED"
    else:
        service["latestCreatedRevision"] += "2"
    with pytest.raises(ValueError):
        h.live_services(env, release, services, "TOKEN", transport)


@pytest.mark.parametrize("form", ["single", "multiple", "missing", "outside"])
def test_build_only_exact_export_output(fixture, tmp_path, monkeypatch, form):
    env, manifest = fixture[:2]
    monkeypatch.setattr(
        h, "inputs", lambda *args: (env, {"release_sha": "a" * 40}, {}, {})
    )
    monkeypatch.setattr(h, "clean_source", lambda *args: None)
    calls = []

    def build(argv, log):
        calls.append(argv)
        line = (
            "Static export and Firebase configuration prepared at: "
            + manifest["directory"]
            + "\n"
        )
        text = {
            "single": line,
            "multiple": line + line,
            "missing": "success boolean is not proof",
            "outside": "Static export and Firebase configuration prepared at: /tmp\n",
        }[form]
        log.write_text(text)
        log.chmod(0o600)

    monkeypatch.setattr(h, "command", build)
    if form == "single":
        plan = h.prepare_hosting_export(tmp_path / "env", {}, {}, tmp_path)
        assert plan["export"] == manifest
        assert "--build-only" in calls[0]
        assert calls[0][-1] == "test-project"
        assert (tmp_path / "hosting.plan.private.json").stat().st_mode & 0o777 == 0o600
    else:
        with pytest.raises(ValueError):
            h.prepare_hosting_export(tmp_path / "env", {}, {}, tmp_path)
        assert not (tmp_path / "hosting.plan.private.json").exists()


@pytest.fixture
def readback_scope(tmp_path, monkeypatch):
    """Wrapper fixtures; real SQL/provider verifier has its independent suite."""
    from types import SimpleNamespace

    tmp_path.chmod(0o700)
    env = {
        "GCP_PROJECT_ID": "test-project",
        "ENVIRONMENT": "preprod",
        "GCP_REGION": "asia-south1",
    }
    env_file, browser_file, library_file = [
        tmp_path / name for name in ("env", "browser.json", "library.json")
    ]
    env_file.write_text("selected protected fixture")
    browser_file.write_text(json.dumps({"config": {"releaseSha": "a" * 40}}))
    library_file.write_text(json.dumps({"fixture": "library-source"}))
    for path in (env_file, browser_file, library_file):
        path.chmod(0o600)
    base = "axiom-proof-preprod-migrations"
    source = {
        **env,
        "MARKETING_MIGRATION_JOB_NAME": base,
        "MARKETING_ACCEPTANCE_JOB_NAME": base + "-readback",
    }
    calls = []

    def descriptor(source, browser, library):
        calls.append((source, browser, library))
        return {
            "phase": "acceptance-readback",
            "project": source["GCP_PROJECT_ID"],
            "release_sha": browser["config"]["releaseSha"],
            "job": {
                "name": "projects/test-project/locations/asia-south1/jobs/"
                + source["MARKETING_ACCEPTANCE_JOB_NAME"]
            },
            "expected_sha256": h.sha(h.canonical(browser)),
        }

    def verified(*args):
        calls.append("provider-proof-validated")
        return {
            "phase": "acceptance-readback",
            "project": "test-project",
            "release_sha": "a" * 40,
            "sql_proof": "independent-verifier-fixture",
        }

    job = SimpleNamespace(descriptor=descriptor, verify_execution=verified)
    monkeypatch.setattr(
        h,
        "module",
        lambda name, path: (
            SimpleNamespace(parse=lambda _: env)
            if path.endswith("ops-env-parse.py")
            else job
        ),
    )
    monkeypatch.setattr(
        h, "clean_source", lambda release: calls.append(("source", release))
    )
    return env_file, browser_file, library_file, source, tmp_path, calls


def prepared_scope(scope, phase="readback"):
    env, browser, library, source, work, _ = scope
    source["MARKETING_ACCEPTANCE_JOB_NAME"] = (
        source["MARKETING_MIGRATION_JOB_NAME"] + "-" + phase
    )
    return h.prepare_readback_job(env, browser, library, source, work, phase=phase)


def record_scope(scope, phase="readback"):
    work = scope[4]
    files = [
        work / (phase + "-" + name + ".json") for name in ("job", "execution", "logs")
    ]
    for path, value in zip(
        files,
        ({"actual": "job"}, {"actual": "execution"}, {"entries": []}),
        strict=True,
    ):
        path.write_text(json.dumps(value))
        path.chmod(0o600)
    return h.record_readback_execution(
        work / ("acceptance-" + phase + ".plan.private.json"), *files, work, phase=phase
    )


def test_baseline_default_paths_and_source_hashes_preserved(readback_scope):
    env, browser, library, source, work, _ = readback_scope
    plan = h.prepare_readback_job(env, browser, library, source, work)
    assert plan["phase"] == "acceptance-readback"
    assert plan["input_file_hashes"] == {
        "env": h.sha(env.read_bytes()),
        "browser": h.sha(browser.read_bytes()),
        "library": h.sha(library.read_bytes()),
    }
    assert (
        work / "acceptance-readback.plan.private.json"
    ).stat().st_mode & 0o777 == 0o600


def test_postwake_distinct_job_plan_receipt_preserves_baseline(readback_scope):
    work = readback_scope[4]
    prepared_scope(readback_scope)
    record_scope(readback_scope)
    paths = [
        work / ("acceptance-readback." + suffix)
        for suffix in ("plan.private.json", "receipt.private.json")
    ]
    baseline = [path.read_bytes() for path in paths]
    plan = prepared_scope(readback_scope, "readback-postwake")
    receipt = record_scope(readback_scope, "readback-postwake")
    assert plan["job"]["name"].endswith("-readback-postwake")
    assert receipt["phase"] == "acceptance-readback-postwake"
    assert [path.read_bytes() for path in paths] == baseline
    assert (
        work / "acceptance-readback-postwake.receipt.private.json"
    ).stat().st_mode & 0o777 == 0o600


@pytest.mark.parametrize(
    "phase", ["../readback", "readback-other", "", "acceptance-readback", "postwake"]
)
def test_arbitrary_readback_phase_refused_before_source_read(readback_scope, phase):
    env, browser, library, source, work, calls = readback_scope
    with pytest.raises(ValueError):
        h.prepare_readback_job(env, browser, library, source, work, phase=phase)
    assert calls == []
    with pytest.raises(ValueError):
        h.record_readback_execution(
            work / "missing",
            work / "missing",
            work / "missing",
            work / "missing",
            work,
            phase=phase,
        )


@pytest.mark.parametrize(
    "name",
    [
        "axiom-proof-preprod-other",
        "axiom-proof-preprod-migrations-readback",
        "../readback-postwake",
    ],
)
def test_wrong_postwake_job_name_refused(readback_scope, name):
    env, browser, library, source, work, calls = readback_scope
    source["MARKETING_ACCEPTANCE_JOB_NAME"] = name
    with pytest.raises(ValueError):
        h.prepare_readback_job(
            env, browser, library, source, work, phase="readback-postwake"
        )
    assert calls == []


def test_no_automatic_plan_or_receipt_overwrite(readback_scope):
    plan = prepared_scope(readback_scope, "readback-postwake")
    work = readback_scope[4]
    path = work / "acceptance-readback-postwake.plan.private.json"
    before = path.read_bytes()
    with pytest.raises(FileExistsError):
        prepared_scope(readback_scope, "readback-postwake")
    assert path.read_bytes() == before
    assert plan["readback_phase"] == "readback-postwake"
    record_scope(readback_scope, "readback-postwake")
    path = work / "acceptance-readback-postwake.receipt.private.json"
    before = path.read_bytes()
    with pytest.raises(FileExistsError):
        record_scope(readback_scope, "readback-postwake")
    assert path.read_bytes() == before


@pytest.mark.parametrize(
    "field", ["readback_phase", "phase", "readback_job_base", "job"]
)
def test_swapped_plan_source_phase_refused_before_provider_verifier(
    readback_scope, field
):
    prepared_scope(readback_scope, "readback-postwake")
    work, calls = readback_scope[4:]
    path = work / "acceptance-readback-postwake.plan.private.json"
    plan = json.loads(path.read_bytes())
    if field == "job":
        plan["job"]["name"] = plan["job"]["name"].removesuffix("-postwake")
    else:
        plan[field] = "readback"
    path.write_text(json.dumps(plan))
    calls.clear()
    with pytest.raises(ValueError):
        record_scope(readback_scope, "readback-postwake")
    assert calls == []


@pytest.mark.parametrize(
    "field,value",
    [
        ("GCP_PROJECT_ID", "foreign-project"),
        ("GCP_REGION", "us-central1"),
        ("ENVIRONMENT", "production"),
    ],
)
def test_postwake_selected_source_binding_refused(readback_scope, field, value):
    env, browser, library, source, work, calls = readback_scope
    source["MARKETING_ACCEPTANCE_JOB_NAME"] = (
        source["MARKETING_MIGRATION_JOB_NAME"] + "-readback-postwake"
    )
    source[field] = value
    with pytest.raises(ValueError):
        h.prepare_readback_job(
            env, browser, library, source, work, phase="readback-postwake"
        )
    assert calls == []


def test_record_rejects_baseline_plan_for_postwake(readback_scope):
    prepared_scope(readback_scope)
    work = readback_scope[4]
    with pytest.raises(ValueError):
        h.record_readback_execution(
            work / "acceptance-readback.plan.private.json",
            work / "missing",
            work / "missing",
            work / "missing",
            work,
            phase="readback-postwake",
        )


def test_fixed_readback_phase_names_only():
    assert h.readback_basename("readback-postwake") == "acceptance-readback-postwake"
    with pytest.raises(ValueError):
        h.readback_basename("../arbitrary")
