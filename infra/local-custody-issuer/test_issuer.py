"""Offline component tests. DB/HTTPS are injected; no transport-ready claim."""

import base64
import hmac
import importlib.util
import json
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "local_issuer", Path(__file__).with_name("issuer.py")
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Issuer unavailable")
issuer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(issuer)
ROOT = Path(__file__).resolve().parents[2]


def b64(value):
    return base64.urlsafe_b64encode(value).decode().rstrip("=")


class IssuerTests(unittest.TestCase):
    def setUp(self):
        parent = ROOT / ".axiom-runtime"
        parent.mkdir(mode=0o700, exist_ok=True)
        temp = tempfile.TemporaryDirectory(dir=parent)
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.root.chmod(0o700)
        self.now = int(time.time())
        self.key = b"synthetic-local-issuer-key-" + b"x" * 48
        wire = ".".join(
            b64(issuer.canonical(item))
            for item in (
                {"alg": "HS256", "typ": "JWT"},
                {"role": "anon", "exp": self.now + 86400},
            )
        )
        api = wire + "." + b64(hmac.digest(self.key, wire.encode(), "sha256"))

        def source(name, data):
            p = self.root / name
            p.write_bytes(data)
            p.chmod(0o600)
            return {"path": str(p), "sha256": issuer.sha(data)}

        self.source = source
        ca = source("ca.pem", b"synthetic-offline-ca-not-a-live-trust-root")
        service = f"[{issuer.SERVICE}]\nhost=localhost\nport=5432\ndbname=postgres\nuser=axiom_proof_local_issuer_operator\npassword=synthetic-only\nsslmode=verify-full\nsslrootcert={ca['path']}\nconnect_timeout=5\n"
        self.settings = {
            "version": 1,
            "psql": "/usr/bin/true",
            "service": source("service.conf", service.encode()),
            "apiKey": source("anon.key", api.encode()),
            "signingKey": source("signer.key", self.key),
            "backendCa": ca,
            "databaseCa": ca,
            "backendOrigin": "https://localhost:56321",
        }
        self.settings_path = self.root / "settings.json"
        self.save_settings()
        self.value = {
            "version": 1,
            "purpose": "local-custody-credential-issue",
            "credentialId": str(uuid.uuid4()),
            "tenantId": str(uuid.uuid4()),
            "reason": "Reviewed synthetic component fixture",
            "policyId": str(uuid.uuid4()),
            "policySha256": "a" * 64,
            "activationEventId": str(uuid.uuid4()),
            "activationEpoch": 3,
            "configurationSha256": "b" * 64,
            "workloadId": str(uuid.uuid4()),
            "principalKind": "controller",
            "servicePrincipal": "spiffe://local.axiom/controller/assessment",
            "operatorId": None,
            "predecessorId": None,
            "issuedAt": self.now,
            "expiresAt": self.now + 3600,
        }
        self.review = self.root / "review.json"
        self.save()
        self.target = self.root / "issued"
        self.calls = []
        self.probes = []
        self.registry_state = "active"
        ssl = patch.object(issuer.ssl, "create_default_context")
        ssl.start()
        self.addCleanup(ssl.stop)

    def save(self):
        self.raw = issuer.canonical(self.value)
        self.expected = issuer.sha(self.raw)
        self.review.write_bytes(self.raw)
        self.review.chmod(0o600)

    def save_settings(self):
        raw = issuer.canonical(self.settings)
        self.settings_path.write_bytes(raw)
        self.settings_path.chmod(0o600)
        self.settings_sha = issuer.sha(raw)

    def result(self):
        v = self.value
        return {
            "version": 1,
            "state": "recorded",
            **{
                key: v[key]
                for key in (
                    "credentialId",
                    "tenantId",
                    "policyId",
                    "policySha256",
                    "activationEventId",
                    "activationEpoch",
                    "configurationSha256",
                    "workloadId",
                    "principalKind",
                    "servicePrincipal",
                    "operatorId",
                    "predecessorId",
                    "issuedAt",
                    "expiresAt",
                )
            },
            "issuanceSha256": self.expected,
            "status": self.registry_state,
            "revokedAt": "2026-10-16T10:00:00+00:00"
            if self.registry_state == "revoked"
            else None,
            "revocationSha256": getattr(self, "revocation_sha", None)
            if self.registry_state == "revoked"
            else None,
            "issuanceReceipt": {"id": "42", "entryHash": "c" * 64},
            "revocationReceipt": {"id": "43", "entryHash": "d" * 64}
            if self.registry_state == "revoked"
            else None,
        }

    def db(self, settings, op, raw, expected, value):
        self.calls.append((op, raw, expected, value.copy()))
        if op == "revoke":
            self.registry_state = "revoked"
            self.revocation_sha = expected
        return self.result()

    def backend(self, settings, data, result):
        self.probes.append((settings, data, result.copy()))

    def issue(self, **kwargs):
        return issuer.issue(
            self.review,
            self.expected,
            self.settings_path,
            self.settings_sha,
            self.target,
            db=kwargs.pop("db", self.db),
            backend=kwargs.pop("backend", self.backend),
            **kwargs,
        )

    def test_actual_signer_exact_local_claims_and_separate_settings_binding(self):
        self.issue()
        self.assertNotEqual(self.settings_sha, self.value["configurationSha256"])
        token = json.loads((self.target / "backend.key").read_bytes())["accessToken"]
        parts, header, claims, signature = issuer._files.jwt_parts(token)
        self.assertEqual(header, {"alg": "HS256", "typ": "JWT"})
        self.assertTrue(
            hmac.compare_digest(
                signature, hmac.digest(self.key, ".".join(parts[:2]).encode(), "sha256")
            )
        )
        self.assertEqual(
            claims,
            {
                "role": issuer.ROLE,
                "sub": self.value["credentialId"],
                "tenant_id": self.value["tenantId"],
                "workload_id": self.value["workloadId"],
                "principal_kind": "controller",
                "service_principal": self.value["servicePrincipal"],
                "configuration_sha256": "b" * 64,
                "iat": self.now,
                "exp": self.now + 3600,
            },
        )
        self.assertEqual([c[0] for c in self.calls], ["issue", "status"])
        self.assertEqual(len(self.probes), 1)
        ready = json.loads((self.target / "ready.json").read_bytes())
        self.assertEqual(ready["policyExecutionReadiness"], "not_verified")
        self.assertEqual(ready["settingsSha256"], self.settings_sha)
        self.assertEqual(self.target.stat().st_mode & 0o777, 0o700)
        self.assertTrue(
            all(p.stat().st_mode & 0o777 == 0o600 for p in self.target.iterdir())
        )

    def test_24h_registry_never_becomes_24h_jwt_or_resume_renewal(self):
        self.value["expiresAt"] = self.now + 86400
        self.save()
        self.issue()
        key = (self.target / "backend.key").read_bytes()
        claims = issuer._files.jwt_parts(json.loads(key)["accessToken"])[2]
        self.assertEqual(claims["exp"], self.now + 3600)
        self.assertEqual(self.calls[0][3]["expiresAt"], self.now + 86400)
        self.issue(resume=True)
        self.assertEqual((self.target / "backend.key").read_bytes(), key)
        with (
            patch.object(issuer.time, "time", return_value=self.now + 3601),
            self.assertRaises(ValueError),
        ):
            self.issue(resume=True)

    def test_lost_response_retains_identical_intent_and_explicit_resume(self):
        def lost(*args):
            self.db(*args)
            raise TimeoutError("synthetic response lost")

        with self.assertRaises(TimeoutError):
            self.issue(db=lost)
        self.assertTrue((self.target / "candidate.key").exists())
        self.assertFalse((self.target / "ready.json").exists())
        before = {
            name: (self.target / name).read_bytes()
            for name in ("candidate.key", "request.json", "intent.json")
        }
        self.issue(resume=True)
        self.assertEqual(
            (self.target / "backend.key").read_bytes(), before["candidate.key"]
        )
        self.assertEqual(
            (self.target / "request.json").read_bytes(), before["request.json"]
        )
        self.assertEqual(
            (self.target / "intent.json").read_bytes(), before["intent.json"]
        )
        self.assertEqual(self.calls[0][1:], self.calls[1][1:])
        with self.assertRaises(FileExistsError):
            self.issue()

    def test_probe_refusal_and_late_revocation_never_publish(self):
        def refused(*args):
            raise ValueError("synthetic backend refusal")

        with self.assertRaises(ValueError):
            self.issue(backend=refused)
        self.assertFalse((self.target / "backend.key").exists())

        def revoked(*args):
            self.registry_state = "revoked"
            self.revocation_sha = "e" * 64

        with self.assertRaises(ValueError):
            self.issue(resume=True, backend=revoked)
        self.assertFalse((self.target / "backend.key").exists())
        self.assertFalse((self.target / "ready.json").exists())

    def test_bound_receipt_refuses_swapped_scope_or_extra_fields(self):
        for key, bad in (
            ("tenantId", str(uuid.uuid4())),
            ("policySha256", "f" * 64),
            ("activationEpoch", 4),
            ("workloadId", str(uuid.uuid4())),
            ("configurationSha256", "a" * 64),
            ("servicePrincipal", "spiffe://foreign/controller"),
            ("issuedAt", self.now - 1),
            ("unexpected", True),
        ):
            with self.subTest(key=key):
                result = {**self.result(), key: bad}
                with self.assertRaises(ValueError):
                    issuer.receipt(result, self.value, self.expected)

    def test_changed_protected_files_partial_output_and_symlink_refused(self):
        with self.assertRaises(TimeoutError):
            self.issue(db=lambda *args: (_ for _ in ()).throw(TimeoutError()))
        (self.target / "candidate.key").write_bytes(b"changed")
        with self.assertRaises(ValueError):
            self.issue(resume=True)
        self.assertFalse((self.target / "ready.json").exists())
        self.review.chmod(0o644)
        with self.assertRaises(ValueError):
            self.issue(resume=True)
        self.review.chmod(0o600)
        self.review.rename(self.root / "original.json")
        self.review.symlink_to(self.root / "original.json")
        with self.assertRaises((ValueError, OSError)):
            self.issue(resume=True)

    def test_pending_output_tamper_during_probe_refuses_publication(self):
        def changed(*_args):
            (self.target / "candidate.key").write_bytes(b"changed-during-probe")

        with self.assertRaises(ValueError):
            self.issue(backend=changed)
        self.assertFalse((self.target / "ready.json").exists())
        self.assertFalse((self.target / "backend.key").exists())

    def test_identical_bytes_replacement_during_probe_refuses_publication(self):
        def replaced(*_args):
            candidate = self.target / "candidate.key"
            replacement = self.root / "replacement.key"
            replacement.write_bytes(candidate.read_bytes())
            replacement.chmod(0o600)
            replacement.replace(candidate)

        with self.assertRaises(ValueError):
            self.issue(backend=replaced)
        self.assertFalse((self.target / "ready.json").exists())

    def test_resume_ready_checks_backend_integrity_after_probe(self):
        self.issue()
        original_ready = (self.target / "ready.json").read_bytes()

        def changed(*_args):
            (self.target / "backend.key").write_bytes(b"changed-during-resume")

        with self.assertRaises(ValueError):
            self.issue(resume=True, backend=changed)
        self.assertEqual((self.target / "ready.json").read_bytes(), original_ready)

    def test_destination_appearing_during_probe_is_not_overwritten(self):
        def changed(*_args):
            foreign = self.target / "backend.key"
            foreign.write_bytes(b"do-not-overwrite")
            foreign.chmod(0o600)

        with self.assertRaises((ValueError, FileExistsError)):
            self.issue(backend=changed)
        self.assertEqual(
            (self.target / "backend.key").read_bytes(), b"do-not-overwrite"
        )
        self.assertFalse((self.target / "ready.json").exists())

    def test_source_service_and_ca_change_preserve_uncertain_intent(self):
        for index, name in enumerate(("service", "databaseCa")):
            path = Path(self.settings[name]["path"])
            original = path.read_bytes()

            def changed(*_args, path=path):
                path.write_bytes(b"changed-original-transport-input")

            with self.subTest(name=name), self.assertRaises(ValueError):
                self.issue(resume=index > 0, backend=changed)
            self.assertTrue((self.target / "candidate.key").exists())
            self.assertFalse((self.target / "backend.key").exists())
            self.assertFalse((self.target / "ready.json").exists())
            self.assertEqual((self.target / "request.json").read_bytes(), self.raw)
            path.write_bytes(original)

    def test_output_directory_and_lock_replacement_during_probe_refused(self):
        def replaced(*_args):
            lock = self.target / "lock"
            replacement = self.root / "replacement-lock"
            replacement.write_bytes(b"")
            replacement.chmod(0o600)
            replacement.replace(lock)

        with self.assertRaises(ValueError):
            self.issue(backend=replaced)
        self.assertFalse((self.target / "ready.json").exists())

        def moved(*_args):
            displaced = self.root / "displaced-output"
            self.target.rename(displaced)
            self.target.mkdir(mode=0o700)
            for path in displaced.iterdir():
                target = self.target / path.name
                target.write_bytes(path.read_bytes())
                target.chmod(0o600)

        with self.assertRaises(ValueError):
            self.issue(resume=True, backend=moved)
        self.assertFalse((self.target / "ready.json").exists())
        self.assertTrue((self.root / "displaced-output" / "candidate.key").exists())

    def test_inputs_changing_after_probe_prevent_publication(self):
        def changed(*args):
            self.settings["backendOrigin"] = "https://elsewhere.invalid"
            self.save_settings()

        with self.assertRaises(ValueError):
            self.issue(backend=changed)
        self.assertFalse((self.target / "ready.json").exists())

    def test_request_canonical_duplicate_unknown_hash_and_invalid_scalar_refused(self):
        mutations = [
            b" " + self.raw,
            self.raw + b"\n",
            self.raw.replace(b'"version":1', b'"version":1,"version":1'),
            issuer.canonical({**self.value, "unknown": "secret-marker"}),
            issuer.canonical({**self.value, "issuedAt": True}),
            self.raw.replace(b"Reviewed synthetic component fixture", b"\\ud800"),
        ]
        for raw in mutations:
            with (
                self.subTest(rawLength=len(raw)),
                self.assertRaises((ValueError, UnicodeError)),
            ):
                issuer.request(raw, issuer.sha(raw), "issue")
        with self.assertRaises(ValueError):
            issuer.request(self.raw, "0" * 64, "issue")

    def test_request_policy_and_original_lifetime_bounds(self):
        for key, bad in (
            ("principalKind", "agent"),
            ("activationEpoch", 0),
            ("expiresAt", self.now + 86401),
            ("operatorId", str(uuid.uuid4())),
            ("predecessorId", self.value["credentialId"]),
            ("reason", " "),
        ):
            value = {**self.value, key: bad}
            raw = issuer.canonical(value)
            with self.subTest(key=key), self.assertRaises(ValueError):
                issuer.request(raw, issuer.sha(raw), "issue")

    def test_signing_key_mismatch_refused_before_registry(self):
        self.settings["signingKey"] = self.source(
            "other.key", b"different-synthetic-key-" + b"x" * 50
        )
        self.save_settings()
        with self.assertRaises(ValueError):
            self.issue()
        self.assertEqual(self.calls, [])

    def test_strict_tls_no_plaintext_fallback_or_settings_digest_substitution(self):
        with self.assertRaises(ValueError):
            issuer.configuration(self.settings_path, self.value["configurationSha256"])
        for origin in (
            "http://127.0.0.1:56321",
            "http://localhost:56321",
            "https://localhost/path",
            "https://user@localhost",
            "https://localhost?x=1",
        ):
            self.settings["backendOrigin"] = origin
            self.save_settings()
            with self.subTest(origin=origin), self.assertRaises(ValueError):
                issuer.configuration(self.settings_path, self.settings_sha)
        self.settings["backendOrigin"] = "https://localhost:56321"
        service = (
            Path(self.settings["service"]["path"])
            .read_bytes()
            .replace(b"verify-full", b"disable")
        )
        self.settings["service"] = self.source("insecure.conf", service)
        self.save_settings()
        with self.assertRaises(ValueError):
            issuer.configuration(self.settings_path, self.settings_sha)

    def test_revoke_unknown_resume_exact_original_and_status_snapshot(self):
        self.issue()
        rev = {
            "version": 1,
            "purpose": "local-custody-credential-revoke",
            "credentialId": self.value["credentialId"],
            "tenantId": self.value["tenantId"],
            "reason": "Reviewed synthetic revocation",
            "issuanceSha256": self.expected,
        }
        raw = issuer.canonical(rev)
        path = self.root / "revoke.json"
        path.write_bytes(raw)
        path.chmod(0o600)
        expected = issuer.sha(raw)
        target = self.root / "revocation"

        def lost(*args):
            self.db(*args)
            raise TimeoutError()

        with self.assertRaises(TimeoutError):
            issuer.revoke(
                path, expected, self.settings_path, self.settings_sha, target, db=lost
            )
        result = issuer.revoke(
            path,
            expected,
            self.settings_path,
            self.settings_sha,
            target,
            resume=True,
            db=self.db,
        )
        self.assertEqual(result["status"], "revoked")
        self.assertEqual(result["revocationSha256"], expected)
        self.assertFalse((target / "backend.key").exists())
        output = self.root / "status.json"
        issuer.status(
            self.review,
            self.expected,
            self.settings_path,
            self.settings_sha,
            output,
            db=self.db,
        )
        self.assertEqual(json.loads(output.read_bytes())["status"], "revoked")
        with self.assertRaises(FileExistsError):
            issuer.status(
                self.review,
                self.expected,
                self.settings_path,
                self.settings_sha,
                output,
                db=self.db,
            )

    def test_revocation_saved_request_and_intent_tamper_refuse_new_ready(self):
        value = {
            "version": 1,
            "purpose": "local-custody-credential-revoke",
            "credentialId": self.value["credentialId"],
            "tenantId": self.value["tenantId"],
            "reason": "Synthetic saved-intent integrity check",
            "issuanceSha256": self.expected,
        }
        raw = issuer.canonical(value)
        review = self.root / "revocation-review.json"
        review.write_bytes(raw)
        review.chmod(0o600)
        for index, field in enumerate(("request.json", "intent.json")):
            target = self.root / f"revocation-tamper-{index}"

            def changed(*args, target=target, field=field):
                result = self.db(*args)
                if args[1] == "status":
                    (target / field).write_bytes(b"changed-saved-intent")
                return result

            with self.subTest(field=field), self.assertRaises(ValueError):
                issuer.revoke(
                    review,
                    issuer.sha(raw),
                    self.settings_path,
                    self.settings_sha,
                    target,
                    db=changed,
                )
            self.assertFalse((target / "ready.json").exists())
            self.assertEqual((target / field).read_bytes(), b"changed-saved-intent")

    def test_revocation_resume_refuses_same_bytes_ready_inode_or_directory_swap(self):
        value = {
            "version": 1,
            "purpose": "local-custody-credential-revoke",
            "credentialId": self.value["credentialId"],
            "tenantId": self.value["tenantId"],
            "reason": "Synthetic recovery identity check",
            "issuanceSha256": self.expected,
        }
        raw = issuer.canonical(value)
        review = self.root / "revocation-recovery-review.json"
        review.write_bytes(raw)
        review.chmod(0o600)
        for index, kind in enumerate(("ready", "directory")):
            target = self.root / f"revocation-recovery-{index}"
            issuer.revoke(
                review,
                issuer.sha(raw),
                self.settings_path,
                self.settings_sha,
                target,
                db=self.db,
            )
            original = (target / "ready.json").read_bytes()

            def changed(*args, target=target, kind=kind, original=original):
                result = self.db(*args)
                if args[1] == "status":
                    if kind == "ready":
                        replacement = self.root / "replacement-ready"
                        replacement.write_bytes(original)
                        replacement.chmod(0o600)
                        replacement.replace(target / "ready.json")
                    else:
                        displaced = self.root / "displaced-revocation"
                        target.rename(displaced)
                        target.mkdir(mode=0o700)
                        for item in displaced.iterdir():
                            new = target / item.name
                            new.write_bytes(item.read_bytes())
                            new.chmod(0o600)
                return result

            with self.subTest(kind=kind), self.assertRaises(ValueError):
                issuer.revoke(
                    review,
                    issuer.sha(raw),
                    self.settings_path,
                    self.settings_sha,
                    target,
                    resume=True,
                    db=changed,
                )
            self.assertEqual((target / "ready.json").read_bytes(), original)

    def test_fixed_database_transport_sends_metadata_only_and_no_secret_environment(
        self,
    ):
        executable = self.root / "psql"
        captured = self.root / "captured.json"
        program = (
            "import json,os,sys\nfrom pathlib import Path\n"
            + f"Path({str(captured)!r}).write_text(json.dumps({{'argv':sys.argv[1:],'env':dict(os.environ),'sql':sys.stdin.read()}}))\nprint({json.dumps(self.result())!r})\n"
        )
        import sys

        executable.write_text(
            "#!" + str(Path(sys.executable).resolve()) + "\n" + program
        )
        executable.chmod(0o700)
        settings = {**self.settings, "psql": str(executable)}
        result = issuer.database(settings, "issue", self.raw, self.expected, self.value)
        self.assertEqual(result, self.result())
        call = json.loads(captured.read_text())
        self.assertIn("set local role axiom_local_custody_issuer", call["sql"])
        self.assertIn("controller_security.issue_local_custody_credential", call["sql"])
        self.assertIn("set local statement_timeout='5s'", call["sql"])
        self.assertIn("set local lock_timeout='3s'", call["sql"])
        self.assertIn(base64.b64encode(self.raw).decode(), call["sql"])
        self.assertEqual(
            call["argv"],
            [
                "-X",
                "-q",
                "-w",
                "-A",
                "-t",
                "-v",
                "ON_ERROR_STOP=1",
                "--dbname=service=" + issuer.SERVICE,
            ],
        )
        self.assertNotEqual(
            call["env"]["PGSERVICEFILE"], self.settings["service"]["path"]
        )
        self.assertFalse(Path(call["env"]["PGSERVICEFILE"]).exists())
        for field in ("PGPASSWORD", "SUPABASE_SERVICE_ROLE_KEY", "JWT_SECRET"):
            self.assertNotIn(field, call["env"])
        self.assertNotIn(self.key.decode(), json.dumps(call))
        self.assertNotIn("synthetic-only", json.dumps(call))
        executable.write_text(
            "#!"
            + str(Path(sys.executable).resolve())
            + "\nimport sys\nsys.stdin.read()\nprint('synthetic-secret',file=sys.stderr)\nraise SystemExit(1)\n"
        )
        with self.assertRaisesRegex(
            ValueError, "database operation refused or uncertain"
        ):
            issuer.database(settings, "issue", self.raw, self.expected, self.value)

    def test_actual_subprocess_uses_verified_service_and_ca_snapshots(self):
        import sys

        service = Path(self.settings["service"]["path"])
        ca = Path(self.settings["databaseCa"]["path"])
        original_service, original_ca = service.read_bytes(), ca.read_bytes()
        capture = self.root / "snapshot-proof.json"
        executable = self.root / "psql-snapshot"
        program = (
            "import os,sys,json,configparser,hashlib,stat\nfrom pathlib import Path\n"
            + f"Path({str(service)!r}).write_bytes({original_service.replace(b'host=localhost', b'host=elsewhere.invalid').replace(b'sslmode=verify-full', b'sslmode=disable')!r})\n"
            + f"Path({str(ca)!r}).write_bytes(b'changed-original-ca')\n"
            + "path=Path(os.environ['PGSERVICEFILE']); ini=configparser.ConfigParser(interpolation=None);ini.read(path);v=ini["
            + repr(issuer.SERVICE)
            + "]\n"
            + "ca=Path(v['sslrootcert']); result={'host':v['host'],'user':v['user'],'db':v['dbname'],'sslmode':v['sslmode'],'caSha256':hashlib.sha256(ca.read_bytes()).hexdigest(),'serviceMode':stat.S_IMODE(path.stat().st_mode),'caMode':stat.S_IMODE(ca.stat().st_mode),'directoryMode':stat.S_IMODE(path.parent.stat().st_mode),'passwordMatches':v['password']=='synthetic-only','snapshotPath':str(path)}\n"
            + f"Path({str(capture)!r}).write_text(json.dumps(result))\n"
            + "sys.stdin.read()\nprint("
            + repr(json.dumps(self.result()))
            + ")\n"
        )
        executable.write_text(
            "#!" + str(Path(sys.executable).resolve()) + "\n" + program
        )
        executable.chmod(0o700)
        settings = {**self.settings, "psql": str(executable)}
        self.assertEqual(
            issuer.database(settings, "issue", self.raw, self.expected, self.value),
            self.result(),
        )
        result = json.loads(capture.read_text())
        self.assertEqual(result["host"], "localhost")
        self.assertEqual(result["sslmode"], "verify-full")
        self.assertEqual(result["user"], "axiom_proof_local_issuer_operator")
        self.assertEqual(result["db"], "postgres")
        self.assertEqual(result["caSha256"], issuer.sha(original_ca))
        self.assertTrue(result["passwordMatches"])
        self.assertEqual(
            (result["serviceMode"], result["caMode"], result["directoryMode"]),
            (0o600, 0o600, 0o700),
        )
        self.assertFalse(Path(result["snapshotPath"]).parent.exists())
        self.assertNotEqual(service.read_bytes(), original_service)
        self.assertNotEqual(ca.read_bytes(), original_ca)
        # A later operation refuses the now-unreviewed originals before Popen.
        with patch.object(issuer.subprocess, "Popen") as spawn:
            with self.assertRaises(ValueError):
                issuer.database(settings, "issue", self.raw, self.expected, self.value)
            spawn.assert_not_called()

    def test_exclusive_publication_interruption_resumes_identical_pair(self):
        original_create = issuer.create

        def interrupted(path, data):
            original_create(path, data)
            if path.name == "backend.key":
                raise TimeoutError(
                    "synthetic interruption after exclusive durable creation"
                )

        with (
            patch.object(issuer, "create", side_effect=interrupted),
            self.assertRaises(TimeoutError),
        ):
            self.issue()
        self.assertTrue((self.target / "candidate.key").exists())
        original = (self.target / "backend.key").read_bytes()
        self.assertFalse((self.target / "ready.json").exists())
        self.issue(resume=True)
        self.assertEqual((self.target / "backend.key").read_bytes(), original)
        self.assertFalse((self.target / "candidate.key").exists())
        self.assertEqual(
            json.loads((self.target / "ready.json").read_bytes())["credentialSha256"],
            issuer.sha(original),
        )

    def test_cli_failures_sanitize_input_and_require_isolated_python(self):
        import subprocess
        import sys

        for isolated in (False, True):
            args = (
                [sys.executable]
                + (["-I"] if isolated else [])
                + [str(Path(issuer.__file__)), "--issue", "synthetic-secret-marker"]
            )
            result = subprocess.run(
                args, capture_output=True, text=True, check=False, timeout=5
            )
            self.assertEqual(result.returncode, 1)
            self.assertIn("refused or uncertain at input", result.stderr)
            self.assertNotIn("synthetic-secret-marker", result.stdout + result.stderr)
            self.assertNotIn("Traceback", result.stderr)

    def test_real_probe_uses_fixed_rpc_no_selectors_and_exact_identity(self):
        # Real request construction/parser; HTTP transport is mocked explicitly.
        data = issuer.credential(self.value, self.settings)
        expected = {
            "version": 1,
            **{key: self.result()[key] for key in issuer.PROBE_FIELDS},
        }
        response = unittest.mock.MagicMock()
        response.__enter__.return_value = response
        response.status = 200
        response.read.return_value = issuer.canonical(expected)
        opener = unittest.mock.MagicMock()
        opener.open.return_value = response
        with patch.object(issuer.urllib.request, "build_opener", return_value=opener):
            issuer.probe(self.settings, data, self.result())
        req = opener.open.call_args.args[0]
        self.assertEqual(
            req.full_url,
            "https://localhost:56321/rest/v1/rpc/read_local_custody_credential_identity",
        )
        self.assertEqual(req.data, b"{}")
        self.assertEqual(req.method, "POST")
        self.assertEqual(opener.open.call_args.kwargs["timeout"], 5)
        with patch.object(
            issuer.urllib.request, "build_opener", return_value=opener
        ) as build:
            issuer.probe(self.settings, data, self.result())
        redirect = build.call_args.args[1]
        with self.assertRaisesRegex(ValueError, "backend redirect refused"):
            redirect.redirect_request(
                None, None, 302, "moved", {}, "http://foreign.invalid"
            )
        for status, size in ((403, 2), (200, 4097)):
            response.status = status
            response.read.return_value = b"x" * size
            with (
                patch.object(
                    issuer.urllib.request, "build_opener", return_value=opener
                ),
                self.assertRaises(ValueError),
            ):
                issuer.probe(self.settings, data, self.result())
        response.status = 200
        for bad in (
            {**expected, "tenantId": str(uuid.uuid4())},
            {**expected, "extra": True},
            None,
        ):
            response.read.return_value = issuer.canonical(bad)
            with (
                patch.object(
                    issuer.urllib.request, "build_opener", return_value=opener
                ),
                self.assertRaises((ValueError, TypeError)),
            ):
                issuer.probe(self.settings, data, self.result())


if __name__ == "__main__":
    unittest.main()
