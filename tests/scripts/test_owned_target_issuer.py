"""Existing-signer unit fixtures; no live mint/grant or HTTP crypto acceptance."""

import base64
import hashlib
import hmac
import importlib.util
import json
import tempfile
import time
import unittest
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


ISSUER = load("existing_test_issuer", "infra/credential-issuer/issuer.py")
OWNED = load("owned_test_issuer", "infra/credential-issuer/owned_target.py")
HOST = load("owned_test_host", "scripts/local-owned-deployment.py")


class OwnedTargetIssuerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(
            prefix=".axiom_owned_issuer_test_", dir=Path.home()
        )
        self.directory = Path(self.temporary.name).resolve()
        self.directory.chmod(0o700)
        self.addCleanup(self.temporary.cleanup)

    def private(self, name, value):
        path = self.directory / name
        data = value if isinstance(value, bytes) else ISSUER.encode(value)
        path.write_bytes(data)
        path.chmod(0o600)
        return path

    def fixture(self):
        key = b"owned-unit-fixture-signing-key-only-32"
        keyfile = self.private("signing.key", key)
        header = {"alg": "HS256", "typ": "JWT"}

        def b64(value):
            return (
                base64.urlsafe_b64encode(ISSUER.encode(value).rstrip(b"\n"))
                .decode()
                .rstrip("=")
            )

        unsigned = b64(header) + "." + b64({"role": "anon", "exp": 4102444800})
        anon = (
            unsigned
            + "."
            + base64.urlsafe_b64encode(hmac.digest(key, unsigned.encode(), "sha256"))
            .decode()
            .rstrip("=")
        )
        apifile = self.private("anon.key", anon.encode())
        settings = {
            "signingKey": {
                "path": str(keyfile),
                "sha256": hashlib.sha256(key).hexdigest(),
            },
            "apiKey": {
                "path": str(apifile),
                "sha256": hashlib.sha256(anon.encode()).hexdigest(),
            },
        }
        ids = [f"89110000-0000-4000-8000-{n:012d}" for n in range(1, 5)]
        host = {
            "enabled": True,
            "hostInstallerSha256": "a" * 64,
            "bffContainerId": "b" * 64,
            "bffImage": "sha256:" + "c" * 64,
        }
        hostfile = self.private("host.json", host)
        request = {
            "schemaVersion": 1,
            "purpose": "owned-target-credential-issue",
            "tenantId": ids[0],
            "bindingId": ids[1],
            "enrollmentId": ids[2],
            "credentialId": ids[3],
            "reservationSha256": "d" * 64,
            "manifestSha256": "e" * 64,
            "custodyEpoch": 2,
            "issuerConfigurationSha256": "f" * 64,
            "hostConfigurationFile": str(hostfile),
            "hostConfigurationSha256": ISSUER.sha(hostfile.read_bytes()),
        }
        now = int(time.time())
        scope = {
            field: request[field]
            for field in (
                "tenantId",
                "bindingId",
                "enrollmentId",
                "credentialId",
                "custodyEpoch",
                "manifestSha256",
                "reservationSha256",
                "issuerConfigurationSha256",
            )
        }
        scope.update(
            {
                "issuedAt": now,
                "expiresAtSeconds": now + 600,
                "expiresAt": datetime.fromtimestamp(now + 600, UTC).isoformat(),
                "scopeExpiresAtSeconds": now + 3600,
                **{
                    field: host[field]
                    for field in ("hostInstallerSha256", "bffContainerId", "bffImage")
                },
            }
        )
        review = self.private("review.json", request)

        def call(_host, path, body):
            if path.endswith("/authorize"):
                return {"data": scope}
            self.assertTrue(path.endswith("/complete"))
            data = body["credential"]
            _, _, claims, signature = ISSUER.jwt_parts(data["accessToken"])
            self.assertEqual(claims["role"], "owned_target_controller")
            self.assertEqual(claims["binding_id"], request["bindingId"])
            unsigned = ".".join(data["accessToken"].split(".")[:2])
            self.assertTrue(
                hmac.compare_digest(
                    signature, hmac.digest(key, unsigned.encode(), "sha256")
                )
            )
            return {
                "data": {
                    "state": "active",
                    "credentialId": request["credentialId"],
                    "credentialSha256": body["credentialSha256"],
                }
            }

        bridge = SimpleNamespace(
            protected_bytes=HOST.protected_bytes,
            parse_json=HOST.parse_json,
            host_source_sha256=Mock(return_value="a" * 64),
            operator_request=Mock(side_effect=call),
        )
        return SimpleNamespace(
            request=request,
            scope=scope,
            settings=settings,
            review=review,
            expected=ISSUER.sha(review.read_bytes()),
            bridge=bridge,
            target=self.directory / "output",
            config=self.directory / "settings.json",
        )

    def test_actual_existing_key_signs_only_reserved_exact_owned_scope_into_private_output(
        self,
    ):
        f = self.fixture()
        with (
            patch.object(OWNED, "bridge", return_value=f.bridge),
            patch.object(ISSUER, "configuration", return_value=f.settings),
        ):
            OWNED.issue(ISSUER, f.review, f.expected, f.config, f.target)
        data = json.loads((f.target / "backend.key").read_bytes())
        self.assertEqual(data["credentialId"], f.request["credentialId"])
        self.assertEqual((f.target / "backend.key").stat().st_mode & 0o777, 0o600)
        self.assertTrue((f.target / "ready.json").is_file())
        self.assertEqual(f.bridge.operator_request.call_count, 2)

    def test_foreign_or_expired_scope_refused_before_key_read(self):
        for field, value in [
            ("bindingId", "89110000-0000-4000-8000-000000000009"),
            ("expiresAtSeconds", 1),
            ("custodyEpoch", 3),
        ]:
            with self.subTest(field=field):
                f = self.fixture()
                f.scope[field] = value
                with (
                    patch.object(OWNED, "bridge", return_value=f.bridge),
                    patch.object(ISSUER, "configuration", return_value=f.settings),
                    patch.object(ISSUER, "source") as source,
                ):
                    with self.assertRaises(ValueError):
                        OWNED.issue(ISSUER, f.review, f.expected, f.config, f.target)
                    source.assert_not_called()
                self.assertFalse(f.target.exists())

    def test_executed_helper_update_refused_before_mint(self):
        f = self.fixture()
        f.bridge.host_source_sha256.side_effect = ["a" * 64, "a" * 64, "9" * 64]
        with (
            patch.object(OWNED, "bridge", return_value=f.bridge),
            patch.object(ISSUER, "configuration", return_value=f.settings),
            patch.object(ISSUER, "source") as source,
        ):
            with self.assertRaises(ValueError):
                OWNED.issue(ISSUER, f.review, f.expected, f.config, f.target)
            source.assert_not_called()
        self.assertFalse((f.target / "candidate.key").exists())

    def test_unconfirmed_publication_retains_candidate_without_publishing_or_retrying(
        self,
    ):
        f = self.fixture()
        f.bridge.operator_request.side_effect = [
            {"data": f.scope},
            ValueError("unconfirmed"),
        ]
        with (
            patch.object(OWNED, "bridge", return_value=f.bridge),
            patch.object(ISSUER, "configuration", return_value=f.settings),
            self.assertRaises(ValueError),
        ):
            OWNED.issue(ISSUER, f.review, f.expected, f.config, f.target)
        self.assertTrue((f.target / "candidate.key").is_file())
        self.assertFalse((f.target / "backend.key").exists())
        self.assertEqual(f.bridge.operator_request.call_count, 2)


if __name__ == "__main__":
    unittest.main()
