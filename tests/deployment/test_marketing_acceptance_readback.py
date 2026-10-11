"""Mock observation contract tests; not actual SQL/cloud acceptance."""

import importlib.util
import json
from copy import deepcopy
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "readback", ROOT / "scripts/marketing-acceptance-readback.py"
)
readback = importlib.util.module_from_spec(spec)
spec.loader.exec_module(readback)


def fixture(source_change=None):
    run = "a5aa6282-612f-42e6-86ac-2fc73c7ae511"
    browser = {
        "run": run,
        "status": "browser-and-api-green-storage-and-lifecycle-pending",
        "config": {
            "environment": "preprod",
            "project": "test-project",
            "releaseSha": "a" * 40,
            "approvalSha256": "b" * 64,
        },
        "contacts": [
            {
                "channel": channel,
                "email": prefix + run + "@example.invalid",
                "response": {"id": identity, "delivery": "not_configured"},
            }
            for channel, prefix, identity in [
                ("bff", "marketing-", "0b8f3334-dd5c-4bba-94ae-0315d0be2860"),
                (
                    "firebase-browser",
                    "browser-",
                    "4c6545a8-8cbf-4b2f-8f63-b8a00fc3eabc",
                ),
            ]
        ],
        "gapScans": [
            {
                "id": "01159be3-a51c-4da5-8df2-6269b55a1b12",
                "questionIds": ["q" + str(i) for i in range(1, 13)],
                "sessionCookie": {"accessProofSha256": "c" * 64},
                "response": {
                    "emailSent": False,
                    "postureScore": 20,
                    "estimatedExposureInr": 500,
                    "findingsCount": 1,
                },
            }
        ],
    }
    browser["health"] = {
        "status": "healthy",
        "profile": "marketing",
        "releaseSha": "a" * 40,
    }
    browser["emailConfiguration"] = {
        "contact": {"emailDeliveryEnabled": False},
        "report": {"emailDeliveryEnabled": False},
    }
    seed = {
        "version": "0.1.1",
        "controls": [{"id": "MOCK", "library_version": "0.1.1"}],
    }
    library = {
        "schemaVersion": 1,
        "releaseSha": "a" * 40,
        "seed": seed,
        "seedSha256": readback.digest(json.dumps(seed, separators=(",", ":"))),
        "controlCount": 1,
        "sourceHashes": {"mock": "d" * 64},
    }
    if source_change == "health":
        browser["health"]["releaseSha"] = "f" * 40
    elif source_change == "email":
        browser["emailConfiguration"]["contact"]["emailDeliveryEnabled"] = True
    elif source_change == "library-digest":
        library["seedSha256"] = "0" * 64
    elif source_change == "library-source":
        library["sourceHashes"] = {}
    elif source_change == "control-count":
        library["controlCount"] = 2
    expected = readback.expected_source(browser, library)
    actual = {
        "database": "test-db",
        "role": "limited-admin",
        "role_posture": {"superuser": False, "bypassrls": False},
        "ssl": True,
        "transaction_read_only": "on",
        "contacts": [
            {
                **c,
                "delivery_status": "not_configured",
                "created_at": "2026-10-09T00:00:00Z",
                "delivery_attempted_at": None,
                "delivery_completed_at": None,
                "provider_message_id": None,
                "delivery_error_code": None,
            }
            for c in expected["contacts"]
        ],
        "gap": [
            {
                k: v
                for k, v in expected["gap"].items()
                if k not in ("access_hash", "findings_count")
            }
        ],
        "budgets": [],
    }
    actual["gap"][0].update(
        access_token_hash=expected["gap"]["access_hash"],
        report_snapshot={
            "postureScore": 20,
            "estimatedExposureInr": 500,
            "findings": [{"mock": "explicit fixture"}],
        },
        contact_email=None,
        follow_up_requested=False,
        created_at="2026-10-09T00:00:00Z",
    )
    keys = [
        ("contact-sender", readback.digest(c["email"].lower()))
        for c in expected["contacts"]
    ] + [("gap-scan-create", expected["gap"]["access_hash"])]
    actual["budgets"] = [
        {
            "bucket": bucket,
            "subject": subject,
            "attempts": 1,
            "window_ends_at": "2026-10-09T01:00:00Z",
        }
        for bucket, subject in keys
    ]
    return expected, actual


def test_exact_mock_observations_produce_hashed_concrete_rows_not_verified_booleans():
    expected, actual = fixture()
    proof = readback.validate_readback(expected, actual)
    assert proof["observations"] == actual
    assert len(proof["observationSha256"]) == 64
    assert "verified" not in proof


@pytest.mark.parametrize(
    "change",
    [
        "super",
        "bypass",
        "no-tls",
        "write-transaction",
        "missing-contact",
        "changed-email",
        "changed-message",
        "mail-attempt",
        "wrong-access",
        "changed-answers",
        "different-library",
        "missing-budget",
        "extra-attempt",
        "expired-rate-window",
        "changed-report",
    ],
)
def test_actual_observation_mismatch_fails_closed(change):
    expected, actual = fixture()
    if change == "super":
        actual["role_posture"]["superuser"] = True
    elif change == "bypass":
        actual["role_posture"]["bypassrls"] = True
    elif change == "no-tls":
        actual["ssl"] = False
    elif change == "write-transaction":
        actual["transaction_read_only"] = "off"
    elif change == "missing-contact":
        actual["contacts"].pop()
    elif change == "changed-email":
        actual["contacts"][0]["email"] = "real-customer@example.com"
    elif change == "changed-message":
        actual["contacts"][0]["message"] = "different"
    elif change == "mail-attempt":
        actual["contacts"][0]["provider_message_id"] = "attempted"
    elif change == "wrong-access":
        actual["gap"][0]["access_token_hash"] = "0" * 64
    elif change == "changed-answers":
        actual["gap"][0]["answers"] = {}
    elif change == "different-library":
        actual["gap"][0]["library_version"] = "different"
    elif change == "missing-budget":
        actual["budgets"].pop()
    elif change == "extra-attempt":
        actual["budgets"][0]["attempts"] = 2
    elif change == "expired-rate-window":
        actual["budgets"][0]["window_ends_at"] = "2026-10-08T00:00:00Z"
    else:
        actual["gap"][0]["report_snapshot"]["postureScore"] = 21
    with pytest.raises(ValueError):
        readback.validate_readback(expected, actual)


def test_sql_is_fixed_readonly_and_filters_original_content_and_access_hash():
    expected, _ = fixture()
    sql = readback.readback_sql(expected)
    assert sql.startswith("begin transaction read only;")
    assert sql.rstrip().endswith("rollback;")
    assert "g.access_token_hash=s->'gap'->>'access_hash'" in sql
    assert "(c.name,c.email,c.company,c.message)" in sql
    assert "statement_timeout" in sql


@pytest.mark.parametrize(
    "change",
    [
        "extra-contact",
        "customer-email",
        "edited-original-body",
        "unbounded-answers",
        "bad-proof-hash",
    ],
)
def test_caller_cannot_turn_expected_source_into_arbitrary_row_read(change):
    expected, _ = fixture()
    expected = deepcopy(expected)
    if change == "extra-contact":
        expected["contacts"].append(expected["contacts"][0])
    elif change == "customer-email":
        expected["contacts"][0]["email"] = "customer@example.com"
    elif change == "edited-original-body":
        expected["contacts"][0]["message"] = "Different source"
    elif change == "unbounded-answers":
        expected["gap"]["answers"]["extra"] = False
    else:
        expected["gap"]["access_hash"] = "not-proof"
    with pytest.raises(ValueError):
        readback.readback_sql(expected)


@pytest.mark.parametrize(
    "change", ["health", "email", "library-digest", "library-source", "control-count"]
)
def test_source_metadata_mismatch_refuses_preparation(change):
    with pytest.raises(ValueError):
        fixture(change)


def test_boolean_attempt_is_not_integer_budget_observation():
    expected, actual = fixture()
    actual["budgets"][0]["attempts"] = True
    with pytest.raises(ValueError):
        readback.validate_readback(expected, actual)
