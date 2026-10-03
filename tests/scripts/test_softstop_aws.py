"""Production soft stop/start on EKS, against fake `aws` and `kubectl`.

Both fakes keep state and apply every change the real command would, so a stop
followed by a start is checked end to end: nothing is deleted and the original
replicas and node-group sizing come back exactly.
"""

import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOFTSTOP = ROOT / "scripts" / "softstop-aws.py"
OPS = ROOT / "scripts" / "axiom-ops.sh"

FAKE_AWS = textwrap.dedent(
    """\
    #!/usr/bin/env python3
    import json, os, sys
    path = os.environ["STUB_STATE"]
    st = json.load(open(path))
    a = sys.argv[1:]
    st["log"].append(["aws"] + a)

    def opt(name):
        return a[a.index(name) + 1] if name in a else None

    out = None
    if a[:2] == ["sts", "get-caller-identity"]:
        out = "123456789012\\n"
    elif a[:2] == ["eks", "list-nodegroups"]:
        out = json.dumps({"nodegroups": list(st["ng"])})
    elif a[:2] == ["eks", "describe-nodegroup"]:
        n = st["ng"][opt("--nodegroup-name")]
        out = json.dumps({"nodegroup": {"nodegroupArn": "arn:ng/" + opt("--nodegroup-name"), "status": n["status"],
            "scalingConfig": {"minSize": n["min"], "maxSize": n["max"], "desiredSize": n["desired"]}, "tags": n["tags"]}})
    elif a[:2] == ["eks", "tag-resource"]:
        name = opt("--resource-arn").split("/")[1]
        k, v = opt("--tags").split("=", 1)
        st["ng"][name]["tags"][k] = v
    elif a[:2] == ["eks", "untag-resource"]:
        name = opt("--resource-arn").split("/")[1]
        st["ng"][name]["tags"].pop(opt("--tag-keys"), None)
    elif a[:2] == ["eks", "update-nodegroup-config"]:
        cfg = dict(p.split("=") for p in opt("--scaling-config").split(","))
        n = st["ng"][opt("--nodegroup-name")]
        n["min"], n["max"], n["desired"] = int(cfg["minSize"]), int(cfg["maxSize"]), int(cfg["desiredSize"])
    else:
        sys.stderr.write("fake aws: unhandled " + " ".join(a))
        json.dump(st, open(path, "w"))
        sys.exit(9)
    json.dump(st, open(path, "w"))
    if out:
        sys.stdout.write(out)
    """
)

FAKE_KUBECTL = textwrap.dedent(
    """\
    #!/usr/bin/env python3
    import json, os, sys
    path = os.environ["STUB_STATE"]
    st = json.load(open(path))
    a = sys.argv[1:]
    st["log"].append(["kubectl"] + a)
    ns = a[a.index("-n") + 1] if "-n" in a else None
    out = None
    if a[:2] == ["get", "deployments"]:
        out = json.dumps({"items": [
            {"metadata": {"name": n, "annotations": d["ann"]}, "spec": {"replicas": d["replicas"]}}
            for n, d in st["dep"].items() if d["ns"] == ns]})
    elif a[0] == "annotate":
        d = st["dep"][a[2]]
        for item in a[3:]:
            if item.startswith("-") or item == ns or item == "--overwrite":
                continue
            if item.endswith("-") and "=" not in item:
                d["ann"].pop(item[:-1], None)
            elif "=" in item:
                k, v = item.split("=", 1)
                d["ann"][k] = v
    elif a[0] == "scale":
        st["dep"][a[2]]["replicas"] = int([x for x in a if x.startswith("--replicas=")][0].split("=")[1])
    else:
        sys.stderr.write("fake kubectl: unhandled " + " ".join(a))
        json.dump(st, open(path, "w"))
        sys.exit(9)
    json.dump(st, open(path, "w"))
    if out:
        sys.stdout.write(out)
    """
)


def initial_state():
    return {
        "log": [],
        "dep": {
            "axiom-bff": {"ns": "axiom-proof", "replicas": 2, "ann": {}},
            "axiom-web": {"ns": "axiom-proof", "replicas": 2, "ann": {}},
            "axiom-model-gateway": {"ns": "axiom-proof", "replicas": 1, "ann": {}},
            "axiom-idle": {"ns": "axiom-proof", "replicas": 0, "ann": {}},
            "coredns": {"ns": "kube-system", "replicas": 2, "ann": {}},
        },
        "ng": {
            "system": {"min": 2, "max": 4, "desired": 2, "status": "ACTIVE", "tags": {"team": "platform"}},
            "gpu": {"min": 0, "max": 4, "desired": 1, "status": "ACTIVE", "tags": {}},
        },
    }


class ProductionSoftStopTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        tmp = Path(self.tmp.name)
        for name, body in (("aws", FAKE_AWS), ("kubectl", FAKE_KUBECTL)):
            (tmp / name).write_text(body)
            (tmp / name).chmod(0o755)
        self.state_path = tmp / "state.json"
        self.state_path.write_text(json.dumps(initial_state()))
        self.env = {
            **os.environ,
            "AXIOM_AWS": str(tmp / "aws"),
            "AXIOM_KUBECTL": str(tmp / "kubectl"),
            "STUB_STATE": str(self.state_path),
            "AXIOM_POLL_SECONDS": "0",
        }

    def state(self):
        return json.loads(self.state_path.read_text())

    def run_aws(self, command, *extra, env_name="production"):
        return subprocess.run(
            [sys.executable, str(SOFTSTOP), command, "--env", env_name, "--cluster", "axiom-test", "--region", "ap-south-1", "--state-dir", str(Path(self.tmp.name) / "rec"), *extra],
            capture_output=True,
            text=True,
            env=self.env,
        )

    def test_stop_then_start_restores_replicas_and_node_sizing_exactly(self):
        before = self.state()
        stopped = self.run_aws("stop")
        self.assertEqual(stopped.returncode, 0, stopped.stdout + stopped.stderr)
        mid = self.state()
        self.assertEqual({n: d["replicas"] for n, d in mid["dep"].items() if d["ns"] == "axiom-proof"}, {"axiom-bff": 0, "axiom-web": 0, "axiom-model-gateway": 0, "axiom-idle": 0})
        self.assertEqual(mid["dep"]["axiom-bff"]["ann"], {"axiom.ai/softstop-replicas": "2"})
        self.assertEqual((mid["ng"]["system"]["min"], mid["ng"]["system"]["desired"]), (0, 0))
        self.assertEqual(mid["ng"]["system"]["tags"]["axiom-softstop-scaling"], "2-4-2")
        started = self.run_aws("start")
        self.assertEqual(started.returncode, 0, started.stdout + started.stderr)
        self.assertEqual(self.state()["dep"], before["dep"])
        self.assertEqual(self.state()["ng"], before["ng"])

    def test_nothing_is_deleted_and_other_namespaces_are_untouched(self):
        before = self.state()
        self.run_aws("stop")
        self.run_aws("start")
        after = self.state()
        self.assertEqual(after["dep"]["coredns"], before["dep"]["coredns"])
        self.assertEqual(sorted(after["dep"]), sorted(before["dep"]))
        words = {w for call in after["log"] for w in call}
        self.assertFalse({"delete", "delete-nodegroup", "delete-cluster", "drain", "cordon"} & words, words)

    def test_stopping_twice_keeps_the_original_saved_values(self):
        self.run_aws("stop")
        self.run_aws("stop")
        self.assertEqual(self.state()["dep"]["axiom-web"]["ann"], {"axiom.ai/softstop-replicas": "2"})
        self.run_aws("start")
        self.assertEqual(self.state()["dep"]["axiom-web"]["replicas"], 2)

    def test_start_waits_for_node_groups_before_scaling_deployments(self):
        self.run_aws("stop")
        self.run_aws("start")
        log = self.state()["log"]
        last_nodegroup_update = max(i for i, c in enumerate(log) if c[:3] == ["aws", "eks", "update-nodegroup-config"])
        first_scale_up = min(i for i, c in enumerate(log) if c[:2] == ["kubectl", "scale"] and any(x in ("--replicas=2", "--replicas=1") for x in c) and i > last_nodegroup_update - 1)
        self.assertGreater(first_scale_up, last_nodegroup_update)

    def test_stop_scales_deployments_before_node_groups(self):
        self.run_aws("stop")
        log = self.state()["log"]
        last_scale = max(i for i, c in enumerate(log) if c[:2] == ["kubectl", "scale"])
        first_nodegroup = min(i for i, c in enumerate(log) if c[:3] == ["aws", "eks", "update-nodegroup-config"])
        self.assertLess(last_scale, first_nodegroup)

    def test_dry_run_changes_nothing(self):
        before = self.state()
        result = self.run_aws("stop", "--dry-run")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("[dry-run]", result.stdout)
        after = self.state()
        self.assertEqual(after["dep"], before["dep"])
        self.assertEqual(after["ng"], before["ng"])

    def test_only_production_is_accepted(self):
        for name in ("preprod", "staging", "local"):
            result = self.run_aws("stop", env_name=name)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("production only", result.stderr)
        self.assertEqual(self.state()["log"], [])

    def test_status_reports_state_and_residual_cost(self):
        self.assertIn("State: RUNNING", self.run_aws("status").stdout)
        self.run_aws("stop")
        out = self.run_aws("status").stdout
        self.assertIn("State: SOFT-STOPPED", out)
        self.assertIn("ElastiCache", out)

    def test_a_cluster_with_no_objects_is_an_error(self):
        state = self.state()
        state["dep"] = {}
        state["ng"] = {}
        self.state_path.write_text(json.dumps(state))
        self.assertNotEqual(self.run_aws("stop").returncode, 0)


class ProductionWrapperTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.tmpdir = Path(self.tmp.name)
        for name, body in (("aws", FAKE_AWS), ("kubectl", FAKE_KUBECTL)):
            (self.tmpdir / name).write_text(body)
            (self.tmpdir / name).chmod(0o755)
        self.state = self.tmpdir / "state.json"
        self.state.write_text(json.dumps(initial_state()))
        self.envfile = self.tmpdir / "prod.env"
        self.envfile.write_text("ENVIRONMENT=production\nAXIOM_CLUSTER_NAME=axiom-test\nAWS_REGION=ap-south-1\n")
        self.extra = {"AXIOM_AWS": str(self.tmpdir / "aws"), "AXIOM_KUBECTL": str(self.tmpdir / "kubectl"), "STUB_STATE": str(self.state), "AXIOM_POLL_SECONDS": "0"}

    def ops(self, *args):
        base = {k: v for k, v in os.environ.items() if k not in ("AXIOM_ENV_FILE", "ENVIRONMENT", "AXIOM_CLUSTER_NAME", "AWS_REGION")}
        return subprocess.run(["bash", str(OPS), *args, "--env-file", str(self.envfile)], capture_output=True, text=True, env={**base, **self.extra}, stdin=subprocess.DEVNULL)

    def test_stopping_production_needs_the_cluster_name_typed_even_with_yes(self):
        for extra in ([], ["--yes"], ["--yes", "--confirm-production", "wrong-name"]):
            result = self.ops("stop", "--env", "production", *extra)
            self.assertNotEqual(result.returncode, 0, extra)
            self.assertIn("--confirm-production axiom-test", result.stderr)
        self.assertEqual(json.loads(self.state.read_text())["dep"]["axiom-bff"]["replicas"], 2)

    def test_stopping_production_with_the_name_and_yes_works_and_start_restores(self):
        stopped = self.ops("stop", "--env", "production", "--yes", "--confirm-production", "axiom-test")
        self.assertEqual(stopped.returncode, 0, stopped.stdout + stopped.stderr)
        self.assertEqual(json.loads(self.state.read_text())["dep"]["axiom-bff"]["replicas"], 0)
        started = self.ops("start", "--env", "production", "--yes")
        self.assertEqual(started.returncode, 0, started.stdout + started.stderr)
        self.assertEqual(json.loads(self.state.read_text())["dep"]["axiom-bff"]["replicas"], 2)

    def test_a_dry_run_needs_no_confirmation_and_changes_nothing(self):
        result = self.ops("stop", "--env", "production", "--dry-run")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("[dry-run]", result.stdout)
        self.assertEqual(json.loads(self.state.read_text())["dep"]["axiom-bff"]["replicas"], 2)

    def test_env_all_never_includes_production(self):
        root = self.tmpdir / "root"
        root.mkdir()
        (root / ".env.production").write_text(self.envfile.read_text())
        env = {k: v for k, v in os.environ.items() if k != "AXIOM_ENV_FILE"}
        result = subprocess.run(
            ["bash", str(OPS), "stop", "--env", "all", "--dry-run"],
            capture_output=True,
            text=True,
            env={**env, **self.extra, "AXIOM_ENV_SEARCH_ROOT": str(root)},
            stdin=subprocess.DEVNULL,
        )
        self.assertNotIn("production", result.stdout.replace("no env file", ""))
        self.assertEqual(json.loads(self.state.read_text())["log"], [])

    def test_the_scheduled_workflow_cannot_touch_production(self):
        text = (ROOT / ".github" / "workflows" / "preprod-nightly-stop.yml").read_text()
        self.assertNotIn("production", text.replace("production-", ""))


class WarmInstanceTests(unittest.TestCase):
    """Production and on-prem keep always-on services warm; only preprod scales to zero."""

    def test_helm_services_never_scale_to_zero(self):
        values = (ROOT / "infra" / "helm" / "axiom-proof" / "values.yaml").read_text()
        import re

        counts = [int(m) for m in re.findall(r"^\s+(?:replicaCount|minReplicas):\s*(\d+)", values, re.M)]
        self.assertTrue(counts)
        self.assertGreaterEqual(min(counts), 1)

    def test_only_preprod_defaults_to_zero_minimum_instances(self):
        variables = (ROOT / "infra" / "terraform" / "envs" / "preprod" / "variables.tf").read_text()
        block = variables.split('variable "min_instance_count"', 1)[1].split("validation", 1)[0]
        self.assertIn("default     = 0", block)


if __name__ == "__main__":
    unittest.main()
