"""Finite standing approval, rate bounds and crash-safe exact-request recovery."""
import importlib.util
import json
import tempfile
import time
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value)
    return value
m = load("local_recovery_tests", "scripts/lib/local_runtime_recovery.py")
a = load("local_renewal_api", "scripts/local-runtime-renewal.py")


class RecoveryPolicy(unittest.TestCase):
    def fixture(self, directory):
        root = Path(directory).resolve()
        now = int(time.time())
        policy = {"schemaVersion": 1, "purpose": "local-existing-runtime-identity-recovery",
                  "approvalReference": "recorded-human-approval", "approvedAt": now - 5, "expiresAt": now + 86400, "maxPer24Hours": 4,
                  "scope": {"reviewed": True}, "spireImage": "sha256:" + "a" * 64,
                  "spireGrantsSha256": "b" * 64}
        return root, {"localRecovery": policy}

    def test_policy_expiry_changed_scope_and_optout_refuse_before_actions(self):
        with tempfile.TemporaryDirectory() as directory:
            state, config = self.fixture(directory)
            with patch.object(m, "scope", return_value={"reviewed": True}):
                self.assertIs(m.check_policy(config, {}, state, a), config["localRecovery"])
                for field, value in (("expiresAt", 1), ("maxPer24Hours", 5), ("approvedAt", int(time.time()) + 60)):
                    changed = {"localRecovery": dict(config["localRecovery"], **{field: value})}
                    with self.subTest(field=field), self.assertRaises(ValueError):m.check_policy(changed, {}, state, a)
            with patch.object(m, "scope", return_value={"reviewed": False}), self.assertRaises(ValueError):
                m.check_policy(config, {}, state, a)
            a.write_private(state / "recovery.disabled", b"disabled")
            with patch.object(m, "scope") as scope:
                self.assertIsNone(m.check_policy(config, {}, state, a)); scope.assert_not_called()

    def test_docker_or_active_workers_defer_without_consuming_quota(self):
        with tempfile.TemporaryDirectory() as directory:
            state, config = self.fixture(directory)
            config.update(dockerExecutable="/reviewed/docker", environment={})
            api = types.SimpleNamespace(run=Mock(return_value=1))
            result = m.recover(config, {}, state, api)
            self.assertTrue(result[0]["deferredForDocker"])
            self.assertFalse((state / "recovery.json").exists())
            api.run.return_value = 0
            api.worker_idle_state = Mock(return_value="busy")
            with patch.object(m, "check_policy", return_value=config["localRecovery"]):
                self.assertTrue(m.recover(config, {}, state, api)[0]["deferredForWorkers"])
            self.assertFalse((state / "recovery.json").exists())

    def test_four_daily_recoveries_and_pending_resume_uses_same_quota(self):
        with tempfile.TemporaryDirectory() as directory:
            state, _config = self.fixture(directory)
            value = m.journal(state, a)
            for _ in range(4):
                first = m.begin(value, "kosha", state, a)
                self.assertIs(m.begin(value, "kosha", state, a), first)
                value["pending"] = None
            self.assertEqual(len(value["events"]), 4)
            with self.assertRaises(ValueError):m.begin(value, "kosha", state, a)
            # Another existing tenant has its own bound; pending work cannot switch.
            m.begin(value, "nimbus", state, a)
            with self.assertRaises(ValueError):m.begin(value, "kosha", state, a)

    def test_token_unknown_or_unapproved_journal_never_invokes_recovery(self):
        with tempfile.TemporaryDirectory() as directory:
            state, config = self.fixture(directory)
            cache = state / "spire"; cache.mkdir(mode=0o700)
            folder = cache / "recovery-test"; folder.mkdir(mode=0o700)
            path = folder / "intent.json"
            a.write_private(path, json.dumps({"phase": "token_issuing", "approvedRecoveryImage": config["localRecovery"]["spireImage"], "expectedGrantsSha256": "b" * 64}).encode())
            config.update(environment={}, dockerExecutable="docker", runtimeBindings={"peers": []})
            api = types.SimpleNamespace(run=Mock(return_value=0), worker_idle_state=lambda _: "idle",
                                       stable_bff=lambda _: ({"id": "c" * 64}, "net"), read_private=a.read_private,
                                       write_private=a.write_private, owned=a.owned, digest=a.digest)
            spire = types.SimpleNamespace(CACHE=cache, NAME="fixture", COMPLETE="complete", container_meta=lambda _: {"Image": config["localRecovery"]["spireImage"]}, grants_sha256=lambda _: "b" * 64, entries=list)
            with patch.object(m, "check_policy", return_value=config["localRecovery"]), patch.object(m, "module", return_value=spire), patch.object(m, "checked") as issue:
                with self.assertRaisesRegex(ValueError, "Uncertain"):
                    m.recover(config, {}, state, api)
                issue.assert_not_called()

    def test_interrupted_published_credentials_and_restaging_resume_without_reissue(self):
        with tempfile.TemporaryDirectory() as directory:
            state, config = self.fixture(directory)
            cache = state / "spire"; cache.mkdir(mode=0o700)
            controller = state / "controller"; controller.mkdir(mode=0o700)
            tenant_dir = controller / "kosha"; tenant_dir.mkdir(mode=0o700)
            credentials = tenant_dir / "credentials"; credentials.mkdir(mode=0o700)
            custody_root = state / "custody"; custody_root.mkdir(mode=0o700)
            (custody_root / "credentials").mkdir(mode=0o700)
            custody = custody_root / "credentials" / "tenant"; custody.mkdir(mode=0o700)
            a.write_private(credentials / "current.json", json.dumps({"credentialId": "old-controller"}).encode())
            for kind in ("producer", "controller"):a.write_private(custody / (kind + ".last"), ("old-" + kind).encode())
            runtime = {"controllerImage": "pin", "schedulerImage": "pin", "workerImage": "pin", "namespace": "same", "temporalAddress": "temporal:7233", "supabaseUrl": "http://localhost:57121", "dockerGid": 0}
            a.write_private(tenant_dir / "runtime.json", json.dumps(runtime).encode())
            peers = [{"name": kind, "purpose": kind, "kind": kind, "tenant": "kosha", "image": "pin"} for kind in ("key", "controller", "scheduler", "producer")]
            config.update(workspace=str(ROOT), python="python", tenants=["kosha"], dockerExecutable="docker", environment={"AXIOM_LOCAL_CONTROLLER_DIR": str(controller), "AXIOM_LOCAL_CUSTODY_ISSUER_DIR": str(custody_root)}, runtimeBindings={"peers": peers})
            config["localRecovery"]["scope"] = {"tenants": {"kosha": {"tenantId": "tenant", "custodyKinds": ["producer", "controller"], "controllerApprovalReference": "existing-approved"}}}
            spire = types.SimpleNamespace(CACHE=cache, NAME="spire", COMPLETE="complete", container_meta=lambda _: {"Image": config["localRecovery"]["spireImage"]}, grants_sha256=lambda _: "b" * 64, entries=list)
            issued = []; removed = set(); failures = ["issue", "key", "stage"]
            producer = {"id": "old-producer", "running": True, "image": "pin", "network": "container:bff", "labels": {}}
            producer_calls = []
            key = {"id": "old-key", "running": True, "image": "pin", "network": "container:bff", "labels": {}}
            def run(args, **_kwargs):
                if args[:2] == ["docker", "stop"]:
                    if args[-1] == key["id"]:key["running"] = False
                    else:self.assertEqual(args[-1], producer["id"]); producer["running"] = False; producer_calls.append("stop")
                if args[:2] == ["docker", "rm"]:
                    if args[-1] == key["id"]:
                        self.assertFalse(key["running"]); removed.add("key")
                        if failures and failures[0] == "key":failures.pop(0); return 1
                    else:self.assertFalse(producer["running"]); removed.add("producer"); producer_calls.append("remove")
                if args[:3] == ["repair", "key", "serve"]:
                    self.assertIn("key", removed)
                    key.update(id="new-key", running=True, labels={"axiom.recovery.owner": args[-1]}); removed.discard("key")
                if args[:3] == ["repair", "producer", "stage"]:
                    self.assertIn("producer", removed, "Real producer stage refuses a running/existing producer")
                    producer_calls.append("stage")
                if args[:3] == ["repair", "producer", "serve"]:
                    self.assertIn("producer", removed)
                    producer.update(id="new-producer", running=True, labels={"axiom.recovery.owner": args[-1]})
                    removed.discard("producer"); producer_calls.append("serve")
                if len(args) > 3 and args[3] == "issue":
                    if "custody" in args[2]:
                        kind = args[args.index("--kind") + 1]
                        issued.append(kind); a_path = custody / (kind + ".last")
                        a_path.write_text("new-" + kind)
                    else:
                        issued.append("assessment-controller"); (credentials / "current.json").write_text(json.dumps({"credentialId": "new-controller"}))
                    if failures and failures[0] == "issue":failures.pop(0); return 1
                if len(args) > 3 and args[3] == "stage" and failures:
                    failures.pop(0); removed.add("controller"); return 1
                if len(args) > 3 and args[3] == "serve":removed.discard("controller")
                return 0
            api = types.SimpleNamespace(run=run, worker_idle_state=lambda _: "idle", stable_bff=lambda _: ({"id": "bff"}, "network"),
                metadata=lambda _config, name, *_: producer if name == "producer" else key if name == "key" else {"image": "pin", "network": "container:bff"}, namespace=lambda *_: "network",
                docker_read=lambda *_: "\n".join(p["name"] for p in peers if p["name"] not in removed),
                read_private=a.read_private, write_private=a.write_private, owned=a.owned, digest=a.digest, unexpired=lambda *_: False,
                validate_sources=lambda _: None, repair_command=lambda _config, peer, action: ["repair", peer["name"], action])
            with patch.object(m, "check_policy", return_value=config["localRecovery"]), patch.object(m, "module", return_value=spire):
                for _ in range(3):
                    with self.assertRaises(ValueError):m.recover(config, {}, state, api)
                result = m.recover(config, {}, state, api)
            self.assertTrue(result[-1]["ok"])
            self.assertCountEqual(issued, ["producer", "controller", "assessment-controller"])
            self.assertIsNone(m.journal(state, a)["pending"])
            self.assertEqual([event["component"] for event in m.journal(state, a)["events"]], ["kosha", "producer"])
            self.assertEqual(producer_calls, ["stop", "remove", "stage", "serve"])

    def test_producer_stop_remove_stage_serve_resume_and_foreign_collision(self):
        for failure in ("remove", "stage", "serve"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                state, config = self.fixture(directory)
                config.update(dockerExecutable="docker", environment={})
                peer = {"name": "producer", "kind": "producer", "purpose": "producer", "image": "pin"}
                config["runtimeBindings"] = {"peers": [peer]}
                current = {"value": {"id": "old", "image": "pin", "network": "container:bff", "running": True, "labels": {}}}
                failed = []; calls = []
                def run(args, current=current, calls=calls, failed=failed, failure=failure, **_kwargs):
                    action = args[1] if args[0] == "docker" else args[2]
                    calls.append(action)
                    if action == "stop":
                        self.assertEqual(args[-1], "old"); current["value"]["running"] = False
                    if action == "rm":
                        self.assertEqual(args[-1], "old"); self.assertFalse(current["value"]["running"]); current["value"] = None
                    if action == "stage":self.assertIsNone(current["value"], "stage must never see the running producer")
                    if action == "serve":
                        self.assertIsNone(current["value"])
                        current["value"] = {"id": "new", "image": "pin", "network": "container:bff", "running": True, "labels": {"axiom.recovery.owner": args[-1]}}
                    if not failed and action == {"remove": "rm"}.get(failure, failure):failed.append(action); return 1
                    return 0
                api = types.SimpleNamespace(run=run, read_private=a.read_private, write_private=a.write_private, owned=a.owned,
                    docker_read=lambda *_, current=current: "producer" if current["value"] else "", metadata=lambda *_, current=current: current["value"],
                    worker_idle_state=lambda _: "idle", validate_sources=lambda _: None, namespace=lambda *_: "net",
                    stable_bff=lambda _: ({"id": "bff"}, "net"), repair_command=lambda _c, _p, action: ["repair", "producer", action])
                record = {"producerPhase": "needed", "events": [], "pending": None}
                with patch.object(m, "check_policy", return_value={}):
                    with self.assertRaises(ValueError):m.restore_producer(config, {}, state, api, record, {"id": "bff"}, "net")
                    if failure == "remove":
                        current["value"] = {"id": "foreign", "image": "pin", "network": "container:bff", "running": False, "labels": {}}
                        before = list(calls)
                        with self.assertRaisesRegex(ValueError, "Foreign"):
                            m.restore_producer(config, {}, state, api, record, {"id": "bff"}, "net")
                        self.assertEqual(calls, before)
                        current["value"] = None
                    m.restore_producer(config, {}, state, api, record, {"id": "bff"}, "net")
                self.assertIsNone(record["producerPhase"])
                self.assertEqual(calls.count("stop"), 1)
                self.assertEqual(calls.count("serve"), 1)
                self.assertLess(calls.index("stop"), calls.index("stage"))

    def test_unhealthy_unexpired_spire_does_not_reserve_quota(self):
        with tempfile.TemporaryDirectory() as directory:
            state, config = self.fixture(directory)
            cache = state / "cache"; cache.mkdir(mode=0o700)
            config.update(dockerExecutable="docker", environment={}, runtimeBindings={"peers": []})
            api = types.SimpleNamespace(run=lambda args, **_: 1 if "healthcheck" in args else 0,
                worker_idle_state=lambda _: "idle", stable_bff=lambda _: ({"id": "bff"}, "net"),
                read_private=a.read_private, digest=a.digest)
            spire = types.SimpleNamespace(CACHE=cache, NAME="spire", container_meta=lambda _: {"Image": config["localRecovery"]["spireImage"]}, expired_node_proof=Mock(side_effect=ValueError("Not expired")))
            with patch.object(m, "check_policy", return_value=config["localRecovery"]), patch.object(m, "module", return_value=spire), self.assertRaisesRegex(ValueError, "Not expired"):
                m.recover(config, {}, state, api)
            self.assertFalse((state / "recovery.json").exists())

    def test_missing_spire_requires_exact_retired_journal_binding(self):
        for phase, foreign in (("container_retiring", False), ("starting", False), ("prepared", False), ("starting", True)):
            with self.subTest(phase=phase, foreign=foreign), tempfile.TemporaryDirectory() as directory:
                state, config = self.fixture(directory)
                cache = state / "spire"; cache.mkdir(mode=0o700)
                folder = cache / "recovery-native"; folder.mkdir(mode=0o700)
                intent = {"phase": phase, "stamp": "20261021T000000Z-" + "a" * 12, "oldContainerId": "a" * 64,
                          "approvedRecoveryImage": config["localRecovery"]["spireImage"], "expectedGrantsSha256": "b" * 64}
                a.write_private(folder / "intent.json", json.dumps(intent).encode())
                retired = {"Id": ("b" if foreign else "a") * 64, "Image": config["localRecovery"]["spireImage"], "State": {"Running": False}}
                spire = types.SimpleNamespace(CACHE=cache, NAME="spire", COMPLETE="complete", container_meta=lambda name, retired=retired: None if name == "spire" else retired)
                config.update(workspace=str(ROOT), python="python", spireCache=str(cache), dockerExecutable="docker", environment={}, runtimeBindings={"peers": []})
                api = types.SimpleNamespace(run=lambda args, **_: 1 if "healthcheck" in args else 0,
                    worker_idle_state=lambda _: "idle", stable_bff=lambda _: ({"id": "bff"}, "net"),
                    read_private=a.read_private, write_private=a.write_private, owned=a.owned, digest=a.digest)
                with patch.object(m, "check_policy", return_value=config["localRecovery"]), patch.object(m, "module", return_value=spire), patch.object(m, "checked", side_effect=ValueError("qualified resume")) as resume, self.assertRaises(ValueError):
                    m.recover(config, {}, state, api)
                self.assertEqual(resume.call_count, 1 if phase in ("container_retiring", "starting") and not foreign else 0)
                if resume.call_count:self.assertIn("--resume", resume.call_args.args[1])

    def test_key_replacement_rejects_foreign_nonce_without_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            state, config = self.fixture(directory)
            pending = {"keyPhase": "creating", "keyOwner": "a" * 32, "keyOldId": "a" * 64}
            current = {"id": "foreign", "image": "pin", "network": "container:bff", "running": True, "labels": {"axiom.recovery.owner": "b" * 32}}
            api = types.SimpleNamespace(docker_read=lambda *_: "key", metadata=lambda *_: current, run=Mock())
            with self.assertRaisesRegex(ValueError, "Owned key service"):
                m.restore_key(config, {}, state, api, {}, pending, {"name": "key", "purpose": "key", "image": "pin"}, {"id": "bff"}, "net")
            api.run.assert_not_called()

    def test_renamed_original_cid_blocks_key_and_producer_recreation(self):
        for component, phase in (("key", "removing"), ("key", "creating"), ("key", "ready"), ("producer", "removing"), ("producer", "staging"), ("producer", "serving")):
            for original_exists in (True, False):
                with self.subTest(component=component, phase=phase, original_exists=original_exists), tempfile.TemporaryDirectory() as directory:
                    state, config = self.fixture(directory)
                    identifier = "d" * 64
                    peer = {"kind": component, "name": component, "purpose": component, "image": "pin"}
                    config["runtimeBindings"] = {"peers": [peer]}
                    # The original NAME is absent, but immutable CID still exists
                    # under a different name (running or stopped both appear).
                    def inventory(_config, args, original_exists=original_exists, identifier=identifier):
                        return identifier if args[-1] == "{{.ID}}" and original_exists else ""
                    api = types.SimpleNamespace(docker_read=inventory, run=Mock(), write_private=a.write_private, owned=a.owned, repair_command=lambda _c, _p, action: ["repair", action])
                    pending = {"keyPhase": phase, "keyOldId": identifier, "keyOwner": "a" * 32}
                    record = {"producerPhase": phase, "producerOldId": identifier, "producerOwner": "a" * 32}
                    with patch.object(m, "checked", side_effect=ValueError("safe create reached")) as create, self.assertRaises(ValueError) as refusal:
                        if component == "key":m.restore_key(config, {}, state, api, {}, pending, peer, {"id": "bff"}, "net")
                        else:m.restore_producer(config, {}, state, api, record, {"id": "bff"}, "net")
                    if original_exists:
                        self.assertIn("CID still exists", str(refusal.exception)); create.assert_not_called()
                    elif phase != "ready":
                        self.assertEqual(str(refusal.exception), "safe create reached"); self.assertEqual(create.call_count, 1)
                    api.run.assert_not_called()

    def test_optout_or_active_worker_rechecked_before_each_helper(self):
        api = types.SimpleNamespace(run=Mock(return_value=0), validate_sources=Mock(), worker_idle_state=lambda _: "busy", stable_bff=Mock())
        with patch.object(m, "check_policy", return_value=None), self.assertRaises(ValueError):
            m.checked({}, ["would-mutate"], api, state=Path("/unused"), deployments={})
        api.run.assert_not_called()
        with patch.object(m, "check_policy", return_value={}), self.assertRaises(ValueError):
            m.checked({}, ["would-mutate"], api, state=Path("/unused"), deployments={})
        api.run.assert_not_called()

    def test_capture_requires_explicit_reference_and_bounded_review(self):
        for reference, days in ((None, 7), ("short", 7), ("human-approval", 0), ("human-approval", 31)):
            with self.subTest(reference=reference, days=days), self.assertRaises(ValueError):
                m.capture({}, {}, reference, days, a)

if __name__ == "__main__":unittest.main()
