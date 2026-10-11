"""Tests for the PII redactor."""

from axiom.pii_redactor import redact_dict, redact_text


def test_redacts_pan():
    r = redact_text("Customer PAN is ABCDE1234F")
    assert "ABCDE1234F" not in r.redacted_text
    assert "REDACTED:PAN" in r.redacted_text


def test_redacts_aadhaar():
    r = redact_text("Aadhaar: 1234 5678 9012")
    assert "1234 5678 9012" not in r.redacted_text
    assert "REDACTED:AADHAAR" in r.redacted_text


def test_redacts_email():
    r = redact_text("Contact me at user@example.com please")
    assert "user@example.com" not in r.redacted_text


def test_redacts_phone():
    r = redact_text("Call +91 98765 43210 for support")
    assert "98765 43210" not in r.redacted_text


def test_passes_through_clean_text():
    r = redact_text("The control library covers 46 DPDPA controls.")
    assert r.redacted_text == "The control library covers 46 DPDPA controls."
    assert r.redactions == []


def test_redact_dict_recursive():
    payload = {
        "name": "Ravi Sharma",
        "metadata": {"pan": "ABCDE1234F", "notes": "ok"},
        "list": [{"aadhaar": "1234 5678 9012"}, "no PII here"],
    }
    redacted, log = redact_dict(payload)
    assert redacted["name"] == "Ravi Sharma"  # no pattern matched
    assert "ABCDE1234F" not in str(redacted)
    assert "1234 5678 9012" not in str(redacted)
    assert any(r["type"] == "PAN" for r in log)
    assert any(r["type"] == "AADHAAR" for r in log)
