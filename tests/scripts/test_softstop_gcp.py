"""Soft stop/start of a non-production GCP environment, against a fake gcloud.

The fake keeps its own state and applies every mutation the real command would,
so a stop followed by a start is checked end to end: nothing is deleted, every
object keeps its name, and the original sizing comes back exactly.
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
SOFTSTOP = ROOT / "scripts" / "softstop-gcp.py"
OPS = ROOT / "scripts" / "axiom-ops.sh"

FAKE_GCLOUD = textwrap.dedent(
    """\
    #!/usr/bin/env python3
    import json, os, sys
    path = os.environ["STUB_STATE"]
    st = json.load(open(path))
    a = sys.argv[1:]
    st["log"].append(a)

    def opt(name):
        return a[a.index(name) + 1] if name in a else None

    def labels(text):
        return dict(p.split("=", 1) for p in text.split(",")) if text else {}

    out = None
    if a[:2] == ["auth", "list"]:
        out = "operator@example.com\\n"
    elif a[:3] == ["run", "services", "list"]:
        out = json.dumps([
            {"metadata": {"name": n, "labels": s["labels"]},
             "spec": {"template": {"metadata": {"annotations": {"autoscaling.knative.dev/minScale": str(s["min"])}}}}}
            for n, s in st["run"].items()])
    elif a[:3] == ["run", "services", "update"]:
        s = st["run"][a[3]]
        if opt("--min-instances") is not None:
            s["min"] = int(opt("--min-instances"))
        s["labels"].update(labels(opt("--update-labels")))
        for k in (opt("--remove-labels") or "").split(","):
            s["labels"].pop(k, None)
    elif a[:3] == ["sql", "instances", "list"]:
        out = json.dumps([
            {"name": n, "state": i["state"], "settings": {"activationPolicy": i["policy"], "userLabels": i["labels"]}}
            for n, i in st["sql"].items()])
    elif a[:3] == ["sql", "instances", "patch"]:
        i = st["sql"][a[3]]
        if opt("--activation-policy"):
            i["policy"] = opt("--activation-policy")
            i["state"] = "RUNNABLE" if i["policy"] == "ALWAYS" else "STOPPED"
        i["labels"].update(labels(opt("--update-labels")))
        for k in (opt("--remove-labels") or "").split(","):
            i["labels"].pop(k, None)
    elif a[:3] == ["compute", "instances", "list"]:
        out = json.dumps([
            {"name": n, "zone": "https://x/zones/" + v["zone"], "status": v["status"], "labels": v["labels"]}
            for n, v in st["vm"].items()])
    elif a[:3] == ["compute", "instances", "stop"]:
        st["vm"][a[3]]["status"] = "TERMINATED"
    elif a[:3] == ["compute", "instances", "start"]:
        st["vm"][a[3]]["status"] = "RUNNING"
    elif a[:3] == ["compute", "instances", "add-labels"]:
        st["vm"][a[3]]["labels"].update(labels(opt("--labels")))
    elif a[:3] == ["compute", "instances", "remove-labels"]:
        st["vm"][a[3]]["labels"].pop(opt("--labels"), None)
    else:
        sys.stderr.write("fake gcloud: unhandled " + " ".join(a))
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
        "run": {
            "axiom-bff-preprod": {"min": 1, "labels": {}},
            "axiom-web-preprod": {"min": 2, "labels": {}},
            "axiom-model-gateway-preprod": {"min": 0, "labels": {}},
            "axiom-bff-staging": {"min": 1, "labels": {}},
            "unrelated-service": {"min": 1, "labels": {}},
        },
        "sql": {
            "axiom-proof-preprod-pg-ab12": {"state": "RUNNABLE", "policy": "ALWAYS", "labels": {}},
            "axiom-proof-staging-pg-cd34": {"state": "RUNNABLE", "policy": "ALWAYS", "labels": {}},
        },
        "vm": {
            "axiom-preprod-issuer": {"zone": "asia-south1-a", "status": "RUNNING", "labels": {}},
            "axiom-preprod-runner": {"zone": "asia-south1-a", "status": "TERMINATED", "labels": {}},
            "axiom-staging-issuer": {"zone": "asia-south1-a", "status": "RUNNING", "labels": {}},
        },
    }


class SoftStopTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        tmp = Path(self.tmp.name)
        self.stub = tmp / "gcloud"
        self.stub.write_text(FAKE_GCLOUD)
        self.stub.chmod(0o755)
        self.state_path = tmp / "state.json"
        self.state_path.write_text(json.dumps(initial_state()))
        self.env = {**os.environ, "AXIOM_GCLOUD": str(self.stub), "STUB_STATE": str(self.state_path), "AXIOM_POLL_SECONDS": "0"}

    def state(self):
        return json.loads(self.state_path.read_text())

    def run_softstop(self, command, env_name="preprod", *extra):
        return subprocess.run(
            [sys.executable, str(SOFTSTOP), command, "--env", env_name, "--project", "p", "--region", "asia-south1", "--state-dir", str(Path(self.tmp.name) / "rec"), *extra],
            capture_output=True,
            text=True,
            env=self.env,
        )

    def test_stop_then_start_restores_the_original_sizing_exactly(self):
        before = self.state()
        stopped = self.run_softstop("stop")
        self.assertEqual(stopped.returncode, 0, stopped.stdout + stopped.stderr)
        mid = self.state()
        self.assertEqual({n: s["min"] for n, s in mid["run"].items() if n.endswith("-preprod")}, {"axiom-bff-preprod": 0, "axiom-web-preprod": 0, "axiom-model-gateway-preprod": 0})
        self.assertEqual(mid["run"]["axiom-bff-preprod"]["labels"], {"axiom-softstop-min": "1"})
        self.assertEqual(mid["run"]["axiom-web-preprod"]["labels"], {"axiom-softstop-min": "2"})
        self.assertEqual(mid["sql"]["axiom-proof-preprod-pg-ab12"]["policy"], "NEVER")
        self.assertEqual(mid["vm"]["axiom-preprod-issuer"]["status"], "TERMINATED")

        started = self.run_softstop("start")
        self.assertEqual(started.returncode, 0, started.stdout + started.stderr)
        after = self.state()
        for kind in ("run", "sql", "vm"):
            self.assertEqual(after[kind], before[kind], kind)

    def test_nothing_is_ever_deleted_and_object_names_never_change(self):
        before = self.state()
        self.run_softstop("stop")
        self.run_softstop("start")
        after = self.state()
        for kind in ("run", "sql", "vm"):
            self.assertEqual(sorted(after[kind]), sorted(before[kind]))
        verbs = {word for call in after["log"] for word in call}
        self.assertFalse({"delete", "remove", "destroy"} & verbs, verbs)

    def test_other_environments_and_unrelated_objects_are_untouched(self):
        before = self.state()
        self.run_softstop("stop")
        after = self.state()
        for name in ("axiom-bff-staging", "unrelated-service"):
            self.assertEqual(after["run"][name], before["run"][name])
        self.assertEqual(after["sql"]["axiom-proof-staging-pg-cd34"], before["sql"]["axiom-proof-staging-pg-cd34"])
        self.assertEqual(after["vm"]["axiom-staging-issuer"], before["vm"]["axiom-staging-issuer"])

    def test_a_vm_an_operator_stopped_is_not_started_by_start(self):
        self.run_softstop("stop")
        self.run_softstop("start")
        self.assertEqual(self.state()["vm"]["axiom-preprod-runner"]["status"], "TERMINATED")

    def test_a_database_stopped_by_someone_else_is_left_alone(self):
        state = self.state()
        state["sql"]["axiom-proof-preprod-pg-ab12"].update(policy="NEVER", state="STOPPED")
        self.state_path.write_text(json.dumps(state))
        result = self.run_softstop("start")
        self.assertIn("stopped by someone else", result.stdout)
        self.assertEqual(self.state()["sql"]["axiom-proof-preprod-pg-ab12"]["policy"], "NEVER")

    def test_stopping_twice_keeps_the_original_saved_minimum(self):
        self.run_softstop("stop")
        self.run_softstop("stop")
        self.assertEqual(self.state()["run"]["axiom-web-preprod"]["labels"], {"axiom-softstop-min": "2"})
        self.run_softstop("start")
        self.assertEqual(self.state()["run"]["axiom-web-preprod"]["min"], 2)

    def test_dry_run_changes_nothing_and_says_what_it_would_do(self):
        before = self.state()
        result = self.run_softstop("stop", "preprod", "--dry-run")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("[dry-run]", result.stdout)
        after = self.state()
        for kind in ("run", "sql", "vm"):
            self.assertEqual(after[kind], before[kind])

    def test_production_is_refused(self):
        for name in ("production", "prod"):
            result = self.run_softstop("stop", name)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("production is never stopped", result.stderr)
        self.assertEqual(self.state()["log"], [])

    def test_status_reports_state_and_the_cost_that_remains(self):
        result = self.run_softstop("status")
        self.assertIn("State: RUNNING", result.stdout)
        self.run_softstop("stop")
        result = self.run_softstop("status")
        self.assertIn("State: SOFT-STOPPED", result.stdout)
        self.assertIn("Cloud SQL storage and backups", result.stdout)
        self.assertNotIn("connector", result.stdout.lower())

    def test_no_objects_for_the_environment_is_an_error_not_a_silent_success(self):
        result = self.run_softstop("stop", "nosuchenv")
        self.assertNotEqual(result.returncode, 0)


class OpsWrapperTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.tmpdir = Path(self.tmp.name)

    def env_file(self, text):
        path = self.tmpdir / "env"
        path.write_text(text)
        return str(path)

    def ops(self, *args, env=None):
        base = {k: v for k, v in os.environ.items() if k not in ("GCP_PROJECT_ID", "GCP_REGION", "ENVIRONMENT", "AXIOM_ENV_FILE")}
        return subprocess.run(["bash", str(OPS), *args], capture_output=True, text=True, env={**base, **(env or {})}, stdin=subprocess.DEVNULL)

    def test_production_is_refused_for_every_command(self):
        for name in ("production", "prod"):
            for command in ("deploy", "build", "stop", "start", "status"):
                result = self.ops(command, "--env", name)
                self.assertNotEqual(result.returncode, 0, (name, command))
                self.assertIn("not driven by this tool", result.stderr)

    def test_onprem_and_all_only_allow_the_soft_closure_commands(self):
        for name in ("onprem", "all"):
            for command in ("deploy", "build"):
                result = self.ops(command, "--env", name)
                self.assertNotEqual(result.returncode, 0, (name, command))
        self.assertIn("only for stop, start and status", self.ops("deploy", "--env", "all").stderr)

    def test_all_walks_every_nonprod_env_that_has_a_file_and_skips_the_rest(self):
        root = self.tmpdir / "root"
        root.mkdir()
        (root / ".env.preprod").write_text("ENVIRONMENT=preprod\nGCP_PROJECT_ID=p\nGCP_REGION=asia-south1\n")
        (root / ".env.staging").write_text("ENVIRONMENT=staging\n")
        (root / ".env.production").write_text("ENVIRONMENT=production\nGCP_PROJECT_ID=prod-proj\nGCP_REGION=asia-south1\n")
        stub = self.tmpdir / "gcloud"
        stub.write_text(FAKE_GCLOUD)
        stub.chmod(0o755)
        state = self.tmpdir / "state.json"
        state.write_text(json.dumps(initial_state()))
        result = self.ops(
            "stop", "--env", "all", "--dry-run",
            env={"AXIOM_ENV_SEARCH_ROOT": str(root), "AXIOM_GCLOUD": str(stub), "STUB_STATE": str(state)},
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        out = result.stdout
        self.assertIn("== stop preprod", out)
        self.assertIn("== stop staging", out)
        self.assertIn("local: no env file, skipped", out)
        self.assertIn("onprem: no env file, skipped", out)
        self.assertNotIn("prod-proj", out)
        self.assertNotIn("stop production", out)
        self.assertNotIn("delete", " ".join(sum(json.loads(state.read_text())["log"], [])))

    def test_env_is_required_and_must_be_known(self):
        self.assertNotEqual(self.ops("deploy").returncode, 0)
        result = self.ops("deploy", "--env", "qa")
        self.assertIn("unknown environment", result.stderr)

    def test_a_missing_env_file_says_how_to_create_it(self):
        result = self.ops("stop", "--env", "preprod", "--env-file", str(self.tmpdir / "absent"))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("environments/.env.preprod.example", result.stderr)

    def test_an_env_file_that_names_a_different_tier_is_refused(self):
        path = self.env_file("ENVIRONMENT=production\nGCP_PROJECT_ID=p\nGCP_REGION=asia-south1\n")
        result = self.ops("stop", "--env", "preprod", "--env-file", path)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ENVIRONMENT=production", result.stderr)

    def test_a_placeholder_project_is_refused(self):
        path = self.env_file("ENVIRONMENT=preprod\nGCP_PROJECT_ID=<your-project>\nGCP_REGION=asia-south1\n")
        result = self.ops("stop", "--env", "preprod", "--env-file", path, "--dry-run")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("GCP_PROJECT_ID", result.stderr)

    def test_values_come_from_the_env_file_and_are_never_executed(self):
        marker = self.tmpdir / "pwned"
        path = self.env_file(f'ENVIRONMENT=preprod\nGCP_PROJECT_ID="my-proj"\nGCP_REGION=asia-south1\nTRAP=$(touch {marker})\n')
        stub = self.tmpdir / "gcloud"
        stub.write_text(FAKE_GCLOUD)
        stub.chmod(0o755)
        state = self.tmpdir / "state.json"
        state.write_text(json.dumps(initial_state()))
        result = self.ops("stop", "--env", "preprod", "--env-file", path, "--dry-run", env={"AXIOM_GCLOUD": str(stub), "STUB_STATE": str(state)})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("--project my-proj", result.stdout)
        self.assertFalse(marker.exists())

    def test_a_cloud_stop_without_a_terminal_needs_yes(self):
        path = self.env_file("ENVIRONMENT=preprod\nGCP_PROJECT_ID=p\nGCP_REGION=asia-south1\n")
        result = self.ops("stop", "--env", "preprod", "--env-file", path)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("--yes", result.stderr)

    def test_real_env_files_are_ignored_and_the_templates_are_not(self):
        def ignored(name):
            return subprocess.run(["git", "check-ignore", "-q", name], cwd=ROOT).returncode == 0

        for env in ("local", "staging", "preprod", "production", "onprem"):
            self.assertTrue(ignored(f".env.{env}"), f".env.{env} must be gitignored")
        for env in ("local", "staging", "preprod"):
            self.assertFalse(ignored(f".env.{env}.example"), f".env.{env}.example must be tracked")
            self.assertTrue((ROOT / f".env.{env}.example").is_file())


class OpsWorkflowTests(unittest.TestCase):
    """The cloud operations workflow must stay operator-triggered and main-only."""

    text = (ROOT / ".github" / "workflows" / "ops-preprod.yml").read_text()

    def test_only_a_manual_dispatch_can_start_it(self):
        triggers = self.text.split("on:", 1)[1].split("permissions:", 1)[0]
        self.assertIn("workflow_dispatch:", triggers)
        for forbidden in ("push:", "pull_request", "schedule:", "workflow_run", "release:"):
            self.assertNotIn(forbidden, triggers)

    def test_it_runs_only_from_main_with_a_gated_environment_and_no_stored_key(self):
        self.assertIn("if: github.ref == 'refs/heads/main'", self.text)
        self.assertIn("environment: preprod-ops", self.text)
        self.assertIn("git merge-base --is-ancestor", self.text)
        self.assertIn("workload_identity_provider", self.text)
        self.assertNotIn("credentials_json", self.text)

    def test_it_defaults_to_a_dry_run(self):
        self.assertRegex(self.text, r"dry_run:[\s\S]*?default: true")


class NightlyStopWorkflowTests(unittest.TestCase):
    """The nightly job may only stop, and only when the operator opted in."""

    text = (ROOT / ".github" / "workflows" / "preprod-nightly-stop.yml").read_text()
    body = text.split("jobs:", 1)[1]

    def test_it_can_only_run_the_stop_command(self):
        commands = [line for line in self.body.splitlines() if "axiom-ops.sh" in line]
        self.assertEqual(len(commands), 1)
        self.assertIn("axiom-ops.sh stop --env preprod", commands[0])
        for forbidden in (" deploy", " build", " start"):
            self.assertNotIn(forbidden, commands[0])

    def test_it_is_opt_in_and_main_only(self):
        self.assertIn("vars.NIGHTLY_STOP_ENABLED == 'true'", self.text)
        self.assertIn("github.ref == 'refs/heads/main'", self.text)
        self.assertIn("schedule:", self.text)

    def test_the_manual_operations_workflow_still_has_no_schedule(self):
        manual = (ROOT / ".github" / "workflows" / "ops-preprod.yml").read_text()
        self.assertNotIn("schedule:", manual.split("permissions:", 1)[0])


class EdgeProtectionTests(unittest.TestCase):
    """Optional production edge protection stays off unless explicitly enabled."""

    def test_default_off_and_creation_is_gated_on_the_switch(self):
        prod = ROOT / "infra" / "terraform" / "envs" / "prod"
        variables = (prod / "variables.tf").read_text()
        block = variables.split('variable "enable_edge_protection"', 1)[1].split("}", 1)[0]
        self.assertIn("default     = false", block)
        self.assertIn("var.enable_edge_protection ? 1 : 0", (prod / "waf.tf").read_text())
        example = (ROOT / "infra" / "docker" / "environments" / ".env.production.example").read_text()
        self.assertIn("AXIOM_ENABLE_EDGE_PROTECTION=false", example)


if __name__ == "__main__":
    unittest.main()
