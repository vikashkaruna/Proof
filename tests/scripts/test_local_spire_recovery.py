"""Recovery failure/resume uses real helper filesystem operations, no Docker."""

import copy
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "local_spire", ROOT / "scripts/local-spire.py"
)
spire = importlib.util.module_from_spec(spec)
spec.loader.exec_module(spire)
sys.path.insert(0, str(ROOT / "infra/workload"))
import spire_recovery as helper

PARENT = f"spiffe://{spire.TRUST_DOMAIN}/spire/agent/join_token/old"
TOKEN = "f" * 32
NEW = f"spiffe://{spire.TRUST_DOMAIN}/spire/agent/join_token/{TOKEN}"
IMAGE = "sha256:" + "a" * 64


def entries(parent=PARENT, roles=None):
    prefix = f"spiffe://{spire.TRUST_DOMAIN}"
    return [
        {
            "id": str(n),
            "spiffe_id": {
                "path": sid[len(prefix) :],
                "trust_domain": spire.TRUST_DOMAIN,
            },
            "parent_id": {
                "path": parent[len(prefix) :],
                "trust_domain": spire.TRUST_DOMAIN,
            },
            "selectors": [{"type": "unix", "value": f"uid:{uid}"}],
        }
        for n, (uid, sid) in enumerate((roles or spire.LEGACY_ROLES).values())
    ]


class FakeDocker:
    def __init__(self, base, health, failure=None):
        self.base, self.health, self.failure = base, health, failure
        self.old = {
            "Id": "old-container",
            "State": {"Running": True},
            "Config": {"Labels": {"axiom.purpose": "local-spire"}},
        }
        self.containers = {spire.NAME: self.old}
        self.current = entries()
        self.calls = []
        self.token_count = 0
        self.updated = []
        self.newnode = PARENT

    def fail_once(self, phase):
        if self.failure == phase:
            self.failure = None
            raise RuntimeError("simulated interruption")

    def run(self, args, **kwargs):
        self.calls.append((args, kwargs))
        out, code = "", 0
        if args[1] == "inspect":
            meta = self.containers.get(args[2])
            out, code = (json.dumps([meta]), 0) if meta else ("", 1)
        elif args[1:3] == ["image", "inspect"]:
            out = IMAGE
        elif args[1] == "top":
            out = "COMMAND\nspire-server\n"
        elif "generate" in args:
            self.token_count += 1
            out = "Token: " + TOKEN
        elif args[1] == "stop":
            self.old["State"]["Running"] = False
            self.fail_once("stop")
        elif args[1] == "cp":
            Path(args[-1]).mkdir()
        elif args[1] == "run" and "input" in kwargs:
            helper.stage(json.loads(kwargs["input"]), self.base, self.health)
            self.fail_once("helper")
        elif args[1] == "rename":
            self.containers[args[3]] = self.containers.pop(args[2])
            self.fail_once("rename")
        elif args[1] == "update" and "--restart" in args:
            self.fail_once("restart")
        elif "healthcheck" in args:
            code = 0 if self.newnode == NEW else 1
        elif "-entryID" in args:
            eid = args[args.index("-entryID") + 1]
            self.updated.append(eid)
            for item in self.current:
                if item["id"] == eid:
                    item["parent_id"]["path"] = NEW.split(spire.TRUST_DOMAIN, 1)[1]
            self.fail_once("update")
        return subprocess.CompletedProcess(args, code, out, "")

    def up(self, **_kwargs):
        self.newnode = NEW
        self.containers[spire.NAME] = {
            "Id": "new-container",
            "Image": IMAGE,
            "State": {"Running": True},
            "Config": self.old["Config"],
        }
        self.fail_once("start")


class RecoveryTests(unittest.TestCase):
    def test_writer_identity_requires_explicit_registration_command(self):
        current = entries(
            roles={
                name: value for name, value in spire.ROLES.items() if name != "karya"
            }
        )
        with (
            patch.object(spire, "node_id", return_value=PARENT),
            patch.object(spire, "entries", return_value=current),
            patch.object(spire, "run") as command,
        ):
            spire.register()
            command.assert_not_called()
            spire.register(karya_only=True)
            command.assert_called_once()
            args = command.call_args.args[0]
            self.assertIn("spiffe://local.axiomproof.test/agent/karya", args)
            self.assertIn("unix:uid:20005", args)

    def test_exact_reviewed_snapshot_only(self):
        self.assertEqual(len(spire.recovery_entries(PARENT, entries())), 4)
        self.assertEqual(
            len(
                spire.recovery_entries(PARENT, entries(roles=spire.ROLES), spire.ROLES)
            ),
            6,
        )
        with self.assertRaises(RuntimeError):
            spire.recovery_entries(PARENT, entries(roles=spire.ROLES))
        badroles = dict(spire.LEGACY_ROLES, extra=(0, "spiffe://foreign/root"))
        with self.assertRaises(RuntimeError):
            spire.recovery_entries(PARENT, entries(), badroles)
        for field, value in [
            ("admin", True),
            ("downstream", True),
            ("selectors", [{"type": "unix", "value": "uid:0"}]),
        ]:
            altered = entries()
            altered[0][field] = value
            with self.assertRaises(RuntimeError):
                spire.recovery_entries(PARENT, altered)
        for field in ("spiffe_id", "parent_id"):
            altered = entries()
            altered[0][field]["trust_domain"] = "foreign.test"
            with self.assertRaises(RuntimeError):
                spire.recovery_entries(PARENT, altered)
        for altered in (entries()[:-1], entries() + [copy.deepcopy(entries()[0])]):
            with self.assertRaises(RuntimeError):
                spire.recovery_entries(PARENT, altered)

    def test_failures_resume_exact_four_and_never_generate_again(self):
        for failure in (None, "stop", "helper", "rename", "restart", "start", "update"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as temp:
                base, health = (
                    Path(temp).resolve() / "state",
                    Path(temp).resolve() / "health",
                )
                base.mkdir()
                health.mkdir()
                (base / "agent").mkdir()
                (base / "server").mkdir()
                (base / "agent" / "old-key").write_text("retained")
                (base / "server" / "keys").write_text("server-retained")
                (base / "node-id").write_text(PARENT)
                cache = Path(temp).resolve() / "cache"
                fake = FakeDocker(base, health, failure)
                with (
                    patch.object(spire, "CACHE", cache),
                    patch.object(spire, "run", side_effect=fake.run),
                    patch.object(spire, "build"),
                    patch.object(spire, "up", side_effect=fake.up),
                    patch.object(
                        spire, "node_id", side_effect=lambda fake=fake: fake.newnode
                    ),
                    patch.object(
                        spire,
                        "entries",
                        side_effect=lambda fake=fake: copy.deepcopy(fake.current),
                    ),
                    patch("builtins.print") as output,
                ):
                    if failure:
                        with self.assertRaises(RuntimeError):
                            spire.reattest()
                        record = next(cache.glob("recovery-*/intent.json"))
                        with self.assertRaises(RuntimeError):
                            spire.reattest()  # Explicit resume is mandatory.
                        spire.reattest(record)
                    else:
                        spire.reattest()
                        record = next(cache.glob("recovery-*/intent.json"))
                    spire.reattest(
                        record
                    )  # Completed resume verifies without rewriting grants.
                    saved = json.loads(record.read_text())
                    self.assertEqual(saved["phase"], spire.COMPLETE)
                    self.assertEqual(len(saved["roles"]), 4)
                    self.assertEqual(fake.token_count, 1)
                    self.assertEqual(sorted(fake.updated), ["0", "1", "2", "3"])
                    self.assertEqual(record.stat().st_mode & 0o777, 0o600)
                    self.assertEqual(record.parent.stat().st_mode & 0o777, 0o700)
                    self.assertNotIn(TOKEN, str(output.call_args_list))
                self.assertEqual(
                    (base / "server" / "keys").read_text(), "server-retained"
                )
                self.assertEqual(len(list(base.glob("agent-retired-*"))), 1)
                self.assertEqual(
                    next(base.glob("agent-retired-*/old-key")).read_text(), "retained"
                )
                self.assertFalse(
                    any("prune" in args or args[1] == "rm" for args, _ in fake.calls)
                )

    def test_wrapper_passes_stdin_and_sanitizes_exception(self):
        with patch.object(
            spire.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)
        ) as execute:
            spire.run(["docker", "run"], input="private-payload")
            self.assertEqual(execute.call_args.kwargs["input"], "private-payload")
        for failure in (
            subprocess.CalledProcessError(1, [TOKEN], stderr=TOKEN),
            subprocess.TimeoutExpired([TOKEN], 1),
            OSError(TOKEN),
        ):
            with patch.object(spire.subprocess, "run", side_effect=failure):
                with self.assertRaises(RuntimeError) as caught:
                    spire.run(["docker", TOKEN], input=TOKEN)
                self.assertNotIn(TOKEN, str(caught.exception))

    def test_helper_retry_preserves_state_expiry_and_health_failure(self):
        with tempfile.TemporaryDirectory() as temp:
            base, health = (
                Path(temp).resolve() / "state",
                Path(temp).resolve() / "health",
            )
            base.mkdir()
            health.mkdir()
            (base / "agent").mkdir()
            (base / "node-id").write_text(PARENT)
            payload = {
                "stamp": "20261019T000000Z-abcdef123456",
                "token": TOKEN,
                "node": NEW,
                "oldNodeId": PARENT,
                "expiresAt": int(time.time()) + 600,
            }
            with (
                patch.object(helper, "publish", side_effect=OSError("unavailable")),
                self.assertRaises(OSError),
            ):
                helper.stage(payload, base, health)
            helper.stage(payload, base, health)
            helper.stage(payload, base, health)
            self.assertEqual((base / "join-token").stat().st_mode & 0o777, 0o600)
            self.assertFalse(
                json.loads((health / "status.json").read_text())["healthy"]
            )
            with self.assertRaises(RuntimeError):
                helper.stage(dict(payload, expiresAt=0), base, health)
            (base / "agent" / "new-svid").write_text("started")
            with self.assertRaises(RuntimeError):
                helper.stage(payload, base, health)

    def test_image_helper_directory_is_searchable_before_any_state_mutation(self):
        with tempfile.TemporaryDirectory() as temp:
            context = Path(temp)

            def capture(args, **_kwargs):
                if args[1] == "info":
                    return subprocess.CompletedProcess(args, 0, "arm64", "")
                dockerfile = (Path(args[-1]) / "Dockerfile").read_text()
                self.assertIn("RUN chmod 0755 /usr/local/lib/axiom", dockerfile)
                self.assertIn(
                    "spire_health.py spire_recovery.py /usr/local/lib/axiom/",
                    dockerfile,
                )
                return subprocess.CompletedProcess(args, 0, "", "")

            with (
                patch.object(spire, "run", side_effect=capture),
                patch.object(spire, "release"),
            ):
                spire.build(force=True)
            # Exercise installed helper imports in isolated Python using actual files.
            for filename in ("spire_health.py", "spire_recovery.py"):
                (context / filename).write_bytes(
                    (ROOT / "infra/workload" / filename).read_bytes()
                )
                (context / filename).chmod(0o644)
            context.chmod(0o644)
            if os.geteuid() != 0:
                denied = subprocess.run(
                    [
                        sys.executable,
                        "-I",
                        "-c",
                        "import sys;sys.path.insert(0,sys.argv[1]);import spire_recovery",
                        str(context),
                    ],
                    capture_output=True,
                    text=True,
                    check=False,
                )
                self.assertNotEqual(denied.returncode, 0)
            context.chmod(0o755)
            result = subprocess.run(
                [
                    sys.executable,
                    "-I",
                    "-c",
                    "import sys;sys.path.insert(0,sys.argv[1]);import spire_recovery",
                    str(context),
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_expired_unknown_and_unsafe_journals_refuse_without_docker(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp).resolve()
            folder.chmod(0o700)
            record = folder / "intent.json"
            intent = {
                "schemaVersion": 1,
                "stamp": "20261019T000000Z-abcdef123456",
                "oldNodeId": PARENT,
                "newNodeId": NEW,
                "roles": spire.LEGACY_ROLES,
                "entries": entries(),
                "image": IMAGE,
                "expiresAt": 0,
                "oldContainerId": "old-container",
            }
            for phase in (
                "token_issuing",
                "token_issued",
                "node_stopped",
                "backup_ready",
                "state_ready",
                "container_retiring",
                "starting",
            ):
                spire.save_intent(record, dict(intent, phase=phase))
                with (
                    patch.object(spire, "run") as command,
                    patch.object(spire, "container_meta", return_value=None),
                    self.assertRaises(RuntimeError),
                ):
                    spire.reattest(record)
                command.assert_not_called()
            record.chmod(0o644)
            with patch.object(spire, "run") as command, self.assertRaises(RuntimeError):
                spire.reattest(record)
            command.assert_not_called()
            record.chmod(0o600)
            record.write_text(json.dumps({"phase": "agent_state_preserved"}))
            with patch.object(spire, "run") as command, self.assertRaises(RuntimeError):
                spire.reattest(record)
            command.assert_not_called()

    def test_helper_refuses_symlinks_and_changed_binding_without_retiring(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp).resolve()
            (base / "agent").mkdir()
            (base / "node-id").write_text(PARENT)
            payload = {
                "stamp": "20261019T000000Z-abcdef123456",
                "token": TOKEN,
                "node": NEW,
                "oldNodeId": PARENT,
                "expiresAt": int(time.time()) + 600,
            }
            (base / "agent").rename(base / "preserve-agent")
            (base / "agent").symlink_to(
                base / "preserve-agent", target_is_directory=True
            )
            with self.assertRaises(RuntimeError):
                helper.stage(payload, base)
            self.assertFalse(list(base.glob("agent-retired-*")))
            (base / "agent").unlink()
            (base / "preserve-agent").rename(base / "agent")
            (base / "node-id").write_text("foreign-node")
            with self.assertRaises(RuntimeError):
                helper.stage(payload, base)
            self.assertFalse(list(base.glob("agent-retired-*")))

    def test_live_agent_refused_before_build(self):
        with (
            tempfile.TemporaryDirectory() as temp,
            patch.object(spire, "CACHE", Path(temp).resolve()),
            patch.object(spire, "container_meta", return_value={"Id": "old"}),
            patch.object(
                spire,
                "run",
                return_value=subprocess.CompletedProcess(
                    [], 0, "COMMAND\n1 spire-agent\n", ""
                ),
            ),
            patch.object(spire, "build") as build,
        ):
            with self.assertRaises(RuntimeError):
                spire.reattest()
            build.assert_not_called()


if __name__ == "__main__":
    unittest.main()
