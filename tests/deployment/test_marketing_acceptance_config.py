"""Manifest/authorization unit fixtures only; never represent hosted acceptance."""

import hashlib
import importlib.util
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "acceptance", ROOT / "scripts/marketing-acceptance-config.py"
)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


def write(path, value):
    path.write_text(json.dumps(value) if isinstance(value, dict) else value)
    path.chmod(0o600)
    return hashlib.sha256(path.read_bytes()).hexdigest()


@pytest.fixture
def inputs(tmp_path):
    env = tmp_path / "selected.env"
    write(
        env,
        "ENVIRONMENT=preprod\nGCP_REGION=asia-south1\nGCP_PROJECT_ID=test-project\nAXIOM_CONTACT_EMAIL_MODE=disabled\nAXIOM_REPORT_EMAIL_MODE=disabled\nAXIOM_PROOF_MARKETING_URL=https://fixture.web.app\n",
    )
    services, hosting, approval = [
        tmp_path / name for name in ["services.json", "hosting.json", "approval.json"]
    ]
    source = {"project": "test-project", "release_sha": "a" * 40}
    s = write(
        services,
        {
            **source,
            "cloud_run_uris": {
                "bff": "https://axiom-proof-preprod-bff-fixture.run.app"
            },
        },
    )
    h = write(
        hosting,
        {
            **source,
            "hosting_url": "https://fixture.web.app",
            "services_receipt_sha256": s,
        },
    )
    write(
        approval,
        {
            **source,
            "kind": "marketing-preprod-synthetic-acceptance",
            "approved_by": "unit-fixture-only",
            "services_receipt_sha256": s,
            "hosting_receipt_sha256": h,
            "expires_at": (
                datetime.now(timezone.utc) + timedelta(minutes=10)
            ).isoformat(),
            "max_contacts": 2,
            "max_gap_scans": 1,
        },
    )
    return env, services, hosting, approval


def test_prepare_uses_exact_published_origin_and_release_without_network(inputs):
    value = helper.prepare(*inputs)
    assert value["marketingUrl"] == "https://fixture.web.app"
    assert value["bffUrl"] == "https://axiom-proof-preprod-bff-fixture.run.app"
    assert value["releaseSha"] == "a" * 40
    assert value["scope"]["maxContacts"] == 2


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("project", "different-project"),
        ("release_sha", "b" * 40),
        ("services_receipt_sha256", "0" * 64),
        ("hosting_receipt_sha256", "0" * 64),
        ("kind", "production"),
        ("approved_by", ""),
        ("max_contacts", 20),
        ("max_gap_scans", 2),
        ("expires_at", "2000-01-01T00:00:00Z"),
    ],
)
def test_stale_or_mismatched_recorded_scope_refused(inputs, key, value):
    approval = inputs[-1]
    data = json.loads(approval.read_text())
    data[key] = value
    write(approval, data)
    with pytest.raises(ValueError):
        helper.prepare(*inputs)


@pytest.mark.parametrize(
    "content",
    [
        "ENVIRONMENT=production\n",
        "AXIOM_CONTACT_EMAIL_MODE=delivery\n",
        "AXIOM_REPORT_EMAIL_MODE=delivery\n",
        "GCP_REGION=us-central1\n",
        "GCP_PROJECT_ID=\n",
    ],
)
def test_wrong_deployment_environment_or_email_delivery_refused(inputs, content):
    env = inputs[0]
    key = content.split("=", 1)[0]
    env.write_text(
        "\n".join(
            line
            for line in env.read_text().splitlines()
            if not line.startswith(key + "=")
        )
        + "\n"
        + content
    )
    with pytest.raises(ValueError):
        helper.prepare(*inputs)


@pytest.mark.parametrize(
    "url",
    [
        "http://fixture.web.app",
        "https://localhost",
        "https://127.0.0.2",
        "https://192.168.1.2",
        "https://user:secret@fixture.web.app",
        "https://fixture.web.app/path",
        "https://fixture.web.app:8443",
    ],
)
def test_guessed_local_or_nonorigin_url_refused(url):
    with pytest.raises(ValueError):
        helper.origin(url)


def test_changed_service_manifest_invalidates_recorded_approval(inputs):
    path = inputs[1]
    path.write_text(path.read_text() + "\n")
    with pytest.raises(ValueError):
        helper.prepare(*inputs)


def test_unsafe_input_permissions_and_symlink_refused(inputs, tmp_path):
    inputs[1].chmod(0o644)
    with pytest.raises(ValueError):
        helper.prepare(*inputs)
    link = tmp_path / "link"
    link.symlink_to(inputs[0])
    with pytest.raises(OSError):
        helper.protected_read(link)


def test_output_symlink_keeps_original_bytes(tmp_path):
    target = tmp_path / "retained"
    target.write_text("original")
    link = tmp_path / "link"
    link.symlink_to(target)
    with pytest.raises(OSError):
        helper.write_private(link, {"private": True})
    assert target.read_text() == "original"


@pytest.mark.parametrize("change", [None, "project", "site", "default-url", "missing"])
def test_actual_firebase_default_url_before_operator_dns_is_strictly_bound(
    inputs, change
):
    env, services, hosting, approval = inputs
    env.write_text(
        env.read_text().replace("https://fixture.web.app", "https://stg.axiomproof.ai")
        + "FIREBASE_HOSTING_SITE_ID=fixture\n"
    )
    data = json.loads(hosting.read_text())
    data["site_metadata"] = {
        "name": "projects/test-project/sites/fixture",
        "defaultUrl": "https://fixture.web.app",
    }
    if change == "project":
        data["site_metadata"]["name"] = "projects/foreign-project/sites/fixture"
    elif change == "site":
        data["site_metadata"]["name"] = "projects/test-project/sites/foreign"
    elif change == "default-url":
        data["site_metadata"]["defaultUrl"] = "https://foreign.web.app"
    elif change == "missing":
        del data["site_metadata"]
    host_hash = write(hosting, data)
    scope = json.loads(approval.read_text())
    scope["hosting_receipt_sha256"] = host_hash
    write(approval, scope)
    if change:
        with pytest.raises(ValueError):
            helper.prepare(*inputs)
    else:
        prepared = helper.prepare(*inputs)
        assert prepared["marketingUrl"] == "https://fixture.web.app"
        assert prepared["publishedCanonicalUrl"] == "https://stg.axiomproof.ai"
