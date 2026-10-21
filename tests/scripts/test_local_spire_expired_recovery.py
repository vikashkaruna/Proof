"""Explicit expired-node recovery: guarded fake Docker + native public DER parser."""
import base64
import copy
import importlib.util
import io
import json
import ssl
import subprocess
import tarfile
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("recovery_fixtures", HERE / "test_local_spire_recovery.py")
f = importlib.util.module_from_spec(spec)
spec.loader.exec_module(f)
m = f.spire

# Public self-signed expired test certificate only; no private key is retained.
EXPIRED_DER = base64.b64decode("MIIDDzCCAfegAwIBAgIBATANBgkqhkiG9w0BAQsFADAmMSQwIgYDVQQDDBtzeW50aGV0aWMtZXhwaXJlZC1ub2RlLXRlc3QwHhcNMTkwMTAxMDAwMDAwWhcNMjAwMTAxMDAwMDAwWjAmMSQwIgYDVQQDDBtzeW50aGV0aWMtZXhwaXJlZC1ub2RlLXRlc3QwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCnQfQgc765D2NKOwYjq4i9V+LNA3DugMpuAGDmx0LPJEJzrAjOp95BE43IZk7Edplz3h6DLuGBkLS9Q2YHgxnHmuGqxIr43JNo2HFej5BMq8qHrURTphB2U4rvrFm8ZzeaGYpHnFbOznITeEUtTVqcBB7esOnoiVB17KMbGUrctXBgyso2JmKeufqyR4nVLp4NGxw53aQuQgWB3DiqKYBpxwQeIi/vLT2O66w9kJnynlMBJ/BuIiHssHdVZu6hC06+NvrwZ4b+5f0wYnIbxMoUoclln7mhSqPWdZ91BP2XJ5cOaUqwLkCPj+HiQw05c0CmKMXrX0ku2yOu/mKQQVcrAgMBAAGjSDBGMEQGA1UdEQQ9MDuGOXNwaWZmZTovL2xvY2FsLmF4aW9tcHJvb2YudGVzdC9zcGlyZS9hZ2VudC9qb2luX3Rva2VuL29sZDANBgkqhkiG9w0BAQsFAAOCAQEAcX8SPUz4KYMxNdax5hYeCO3BCUu9U0UM1idPXqQjm3I7o8xNtOKjao4pV0xJDQADmSt6tcXFL7wAMLUhjLquCZ7iSux8rRKz2IKIvgR7QrebES396zsXncK/ksLucbgOkYd8RotP4w+DC7GNmHRVUN0dECaKP5bIUat3PcVNxlaC4B8CV1aG6hbR47vjDQ6MT24SgtdGk3DATRkmwAMht7ny5T8wsnYDMn3jd258lyvbAKi3N/i5ynPpHehPpkZrRksL9GvRp8jIWU4Y5XysxXyd4DdED8htcG8t/tO6+i1n7FYFzDZSYqdPVVXvbjFWhEgbGGbGQoFAOpJ7xt8BGQ==")


def archive(raw):
    raw = json.dumps({"svid": [base64.b64encode(ssl.DER_cert_to_PEM_cert(raw).encode()).decode()]}).encode()
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w") as tar:
        member = tarfile.TarInfo("agent-data.json")
        member.size = len(raw)
        tar.addfile(member, io.BytesIO(raw))
    return output.getvalue()


class OfflineDocker(f.FakeDocker):
    def __init__(self, base, health, failure=None):
        super().__init__(base, health, failure)
        self.old.update(Id="c" * 64, Image=f.IMAGE,
            Mounts=[{"Type": "volume", "Name": name, "Destination": target, "RW": True}
                    for name, target in m.VOLUMES.items()])
        self.helper_id = "e" * 64
        self.helper_name = None

    def lookup(self, target):
        return self.containers.get(target) or next(
            (v for v in self.containers.values() if v["Id"] == target), None)

    def run(self, args, **kwargs):
        if args[1] == "inspect":
            self.calls.append((args, kwargs))
            value = self.lookup(args[2])
            return subprocess.CompletedProcess(args, 0 if value else 1,
                                               json.dumps([value]) if value else "", "")
        if args[1] == "exec" and len(args) > 3 and args[2] == self.helper_id and "healthcheck" in args:
            self.calls.append((args, kwargs))
            return subprocess.CompletedProcess(args, 0, "", "")
        if args[1] == "create":
            self.calls.append((args, kwargs))
            name = args[args.index("--name") + 1]
            self.helper_name = name
            nonce = next(v.split("=", 1)[1] for v in args if v.startswith("axiom.recovery.owner="))
            self.containers[name] = {
                "Id": self.helper_id, "Name": "/" + name, "Image": f.IMAGE,
                "State": {"Running": False},
                "Config": {"Labels": {"axiom.purpose": "local-spire-recovery-server",
                                      "axiom.recovery.owner": nonce},
                           "Entrypoint": ["spire-server"],
                           "Cmd": ["run", "-config", "/etc/spire/server.conf"]},
                "HostConfig": {"NetworkMode": "none", "PortBindings": {}, "Binds": [],
                               "ReadonlyRootfs": True, "Privileged": False,
                               "CapDrop": ["ALL"], "PidMode": "", "RestartPolicy": {"Name": "no"},
                               "SecurityOpt": ["no-new-privileges:true"],
                               "Tmpfs": {"/run/spire-server": "rw,nosuid,noexec,size=16m,mode=0700"}},
                "Mounts": [{"Type": "volume", "Name": "axiom-spire-data",
                            "Destination": "/var/lib/spire", "RW": True}],
            }
            self.fail_once("create")
            return subprocess.CompletedProcess(args, 0, self.helper_id, "")
        if len(args) > 2 and args[2] == self.helper_id:
            if args[1] == "start":
                self.calls.append((args, kwargs))
                self.lookup(self.helper_id)["State"]["Running"] = True
                self.fail_once("helper_start")
                return subprocess.CompletedProcess(args, 0, "", "")
            if args[1] == "stop":
                self.calls.append((args, kwargs))
                self.lookup(self.helper_id)["State"]["Running"] = False
                self.fail_once("helper_stop")
                return subprocess.CompletedProcess(args, 0, "", "")
            if args[1] == "rm":
                self.calls.append((args, kwargs))
                self.containers.pop(self.helper_name)
                self.fail_once("helper_rm")
                return subprocess.CompletedProcess(args, 0, "", "")
        return super().run(args, **kwargs)


class ExpiredRecovery(unittest.TestCase):
    def setup_state(self, root, failure=None):
        base, health = root / "state", root / "health"
        base.mkdir(); health.mkdir(); (base / "agent").mkdir(); (base / "server").mkdir()
        (base / "agent/old-key").write_text("retained-agent")
        (base / "server/old-key").write_text("retained-server")
        (base / "node-id").write_text(f.PARENT)
        return base, health, OfflineDocker(base, health, failure)

    def test_offline_failures_resume_one_token_and_preserve_original_state(self):
        for failure in (None, "stop", "create", "helper_start", "helper_stop", "helper_rm", "helper", "rename", "start", "update"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary).resolve()
                base, health, docker = self.setup_state(root, failure)
                proof = {"oldNodeId": f.PARENT, "certificateSha256": "a" * 64,
                         "certificateExpiredAt": int(time.time()) - 100,
                         "originalImage": f.IMAGE}
                with (
                    patch.object(m, "CACHE", root / "cache"),
                    patch.object(m, "run", side_effect=docker.run),
                    patch.object(m, "expired_node_proof", return_value=proof),
                    patch.object(m, "public_node_certificate", return_value=("a" * 64, {})),
                    patch.object(m, "read_node_id_from_container", return_value=f.PARENT),
                    patch.object(m, "node_id", side_effect=lambda: docker.newnode),
                    patch.object(m, "entries", side_effect=lambda *args: copy.deepcopy(docker.current)),
                    patch.object(m, "build"), patch.object(m, "up", side_effect=docker.up),
                    patch("builtins.print") as output,
                ):
                    if failure:
                        with self.assertRaises(RuntimeError):m.reattest(expired_agent=True)
                        record = next((root / "cache").glob("recovery-*/intent.json"))
                        with self.assertRaises(RuntimeError):m.reattest(expired_agent=True)
                        m.reattest(record)
                    else:
                        m.reattest(expired_agent=True)
                        record = next((root / "cache").glob("recovery-*/intent.json"))
                    m.reattest(record)
                    intent = json.loads(record.read_text())
                    self.assertEqual(intent["phase"], m.COMPLETE)
                    self.assertTrue(intent["offlineHelperRemoved"])
                    self.assertEqual(docker.token_count, 1)
                    self.assertIsNone(docker.lookup(docker.helper_id))
                    self.assertNotIn(f.TOKEN, str(output.call_args_list))
                self.assertEqual((base / "server/old-key").read_text(), "retained-server")
                self.assertEqual(next(base.glob("agent-retired-*/old-key")).read_text(), "retained-agent")
                removes = [args for args, _ in docker.calls if args[1] == "rm"]
                self.assertTrue(all(args == ["docker", "rm", docker.helper_id] for args in removes))
                self.assertFalse(any("volume" in args and "rm" in args for args, _ in docker.calls))

    def test_expired_token_cleans_owned_helper_before_refusing_state_changes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            base, _health, docker = self.setup_state(root, "helper_stop")
            proof = {"oldNodeId": f.PARENT, "certificateSha256": "a" * 64,
                     "certificateExpiredAt": int(time.time()) - 100,
                     "originalImage": f.IMAGE}
            with (
                patch.object(m, "CACHE", root / "cache"),
                patch.object(m, "run", side_effect=docker.run),
                patch.object(m, "expired_node_proof", return_value=proof),
                patch.object(m, "public_node_certificate", return_value=("a" * 64, {})),
                patch.object(m, "read_node_id_from_container", return_value=f.PARENT),
                patch.object(m, "entries", side_effect=lambda *args: copy.deepcopy(docker.current)),
                patch.object(m, "build"), patch.object(m, "up") as start,
                patch("builtins.print"),
            ):
                with self.assertRaises(RuntimeError):m.reattest(expired_agent=True)
                record = next((root / "cache").glob("recovery-*/intent.json"))
                intent = json.loads(record.read_text())
                self.assertEqual(intent["phase"], "offline_helper_stopping")
                intent["expiresAt"] = 0
                record.write_text(json.dumps(intent))
                with self.assertRaisesRegex(RuntimeError, "expired"):
                    m.reattest(record)
                intent = json.loads(record.read_text())
                self.assertEqual(intent["phase"], "node_stopped")
                self.assertTrue(intent["offlineHelperRemoved"])
                self.assertIsNone(docker.lookup(docker.helper_id))
                self.assertEqual(docker.token_count, 1)
                self.assertFalse(any("backup_ready" == row["phase"] for row in intent["history"]))
                start.assert_not_called()
            self.assertEqual((base / "agent/old-key").read_text(), "retained-agent")

    def test_native_public_der_parser_and_expiry_binding_guards(self):
        with patch.object(m.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, archive(EXPIRED_DER), b"")):
            sha, decoded = m.public_node_certificate(m.NAME)
        self.assertEqual(len(sha), 64)
        self.assertEqual(decoded["subjectAltName"], (("URI", f.PARENT),))
        with tempfile.TemporaryDirectory() as temporary:
            _base, _health, docker = self.setup_state(Path(temporary))
            for healthy, node, expiry in ((True, f.PARENT, "Jan  1 00:00:00 2020 GMT"),
                                         (False, "spiffe://foreign.test/node", "Jan  1 00:00:00 2020 GMT"),
                                         (False, f.PARENT, "Jan  1 00:00:00 2099 GMT")):
                with (
                    self.subTest(healthy=healthy, node=node, expiry=expiry),
                    patch.object(m, "run", return_value=subprocess.CompletedProcess([], 0 if healthy else 1, "", "")) as command,
                    patch.object(m, "read_node_id_from_container", return_value=f.PARENT),
                    patch.object(m, "public_node_certificate", return_value=("a" * 64, {"subjectAltName": (("URI", node),), "notAfter": expiry})),
                    self.assertRaises(RuntimeError),
                ):
                    m.expired_node_proof(docker.old)
                self.assertFalse(any(call.args[0][1] in ("stop", "create", "rm") for call in command.call_args_list))

    def test_cached_public_chain_rejects_malformed_and_oversized_content(self):
        for raw in (b"{}", b'{"svid":[]}', b'{"svid":["not base64!"]}',
                    b'{"svid":["' + b"A" * 32769 + b'"]}'):
            with self.subTest(size=len(raw)):
                output = io.BytesIO()
                with tarfile.open(fileobj=output, mode="w") as tar:
                    member = tarfile.TarInfo("agent-data.json")
                    member.size = len(raw)
                    tar.addfile(member, io.BytesIO(raw))
                with patch.object(m.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, output.getvalue(), b"")), self.assertRaisesRegex(RuntimeError, "certificate refused"):
                    m.public_node_certificate(m.NAME)

    def test_uncertain_create_foreign_collision_never_removed(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            _base, _health, docker = self.setup_state(root)
            intent = {"oldContainerId": docker.old["Id"], "originalImage": f.IMAGE, "recoveryImage": f.IMAGE,
                      "offlineServer": {"name": "axiom-proof-local-collision", "nonce": "a" * 32}}
            foreign = copy.deepcopy(docker.old)
            foreign.update(Name="/axiom-proof-local-collision")
            docker.containers["axiom-proof-local-collision"] = foreign
            with patch.object(m, "run", side_effect=docker.run), self.assertRaises(RuntimeError):
                m.offline_helper_meta(intent)
            self.assertFalse(any(args[1] in ("stop", "rm") for args, _ in docker.calls))


if __name__ == "__main__":unittest.main()
