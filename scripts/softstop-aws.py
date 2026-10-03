#!/usr/bin/env python3
"""Soft stop and start of the PRODUCTION Axiom Proof environment on AWS EKS.

This is the production counterpart of scripts/softstop-gcp.py. It is a cost and
maintenance-window tool, not an outage button: it is never run by a schedule,
never part of `--env all`, and `stop` demands a typed confirmation of the
cluster name (done by scripts/axiom-ops.sh). Nothing is deleted, so every ID and
wiring survives.

  Deployments  in the application namespace: replicas -> 0. The previous count
               is kept in the annotation `axiom.ai/softstop-replicas`; `start`
               restores it exactly. HPAs stay in place and take over again as
               soon as replicas are above zero. Fargate pods stop billing when
               they are gone.
  Node groups  EKS managed node groups: min and desired size -> 0. The previous
               (min,max,desired) is kept in the node group tag
               `axiom-softstop-scaling`; `start` restores it and waits until the
               group is ACTIVE before any deployment is scaled back up.

Order: stop = deployments, then node groups. start = node groups, then
deployments.

It cannot pause the EKS control plane, NAT gateways, ElastiCache, EBS volumes,
the S3 evidence bucket and its KMS keys, or third-party services (the managed
Supabase project, Temporal Cloud); `status` lists them as the residual cost.
Standard library only; shells out to `aws` and `kubectl` (override with
AXIOM_AWS and AXIOM_KUBECTL; AXIOM_KUBE_CONTEXT selects a kubectl context).
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess  # nosec B404 - runs aws and kubectl with argv lists, no shell
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ANNOTATION = "axiom.ai/softstop-replicas"
TAG = "axiom-softstop-scaling"
PRODUCTION_ENVS = {"production", "prod"}
RESIDUAL_COST = (
    "EKS control plane",
    "NAT gateways and load balancers",
    "ElastiCache (cannot be stopped)",
    "EBS volumes and the S3 evidence bucket with its KMS keys (never touched)",
    "Third-party services (managed Supabase project, Temporal Cloud)",
)


class OpsError(Exception):
    pass


class Runner:
    def __init__(self, cluster: str, region: str, namespace: str, dry_run: bool) -> None:
        self.cluster, self.region, self.namespace, self.dry_run = cluster, region, namespace, dry_run
        self.aws = os.environ.get("AXIOM_AWS", "aws")
        self.kubectl = os.environ.get("AXIOM_KUBECTL", "kubectl")
        self.context = os.environ.get("AXIOM_KUBE_CONTEXT", "")
        self.actions: list[dict] = []

    def _kubectl_base(self) -> list[str]:
        return [self.kubectl, *(["--context", self.context] if self.context else [])]

    def _run(self, argv: list[str]) -> subprocess.CompletedProcess:
        return subprocess.run(argv, capture_output=True, text=True)  # nosec B603 - argv is built in this file from validated names, no shell

    def aws_json(self, args: list[str]) -> dict:
        r = self._run([self.aws, *args, "--region", self.region, "--output", "json"])
        if r.returncode != 0:
            raise OpsError(f"aws {' '.join(args)} failed: {r.stderr.strip()}")
        return json.loads(r.stdout or "{}")

    def kube_json(self, args: list[str]) -> dict:
        r = self._run([*self._kubectl_base(), *args, "-o", "json"])
        if r.returncode != 0:
            raise OpsError(f"kubectl {' '.join(args)} failed: {r.stderr.strip()}")
        return json.loads(r.stdout or "{}")

    def mutate(self, what: str, argv: list[str]) -> None:
        self.actions.append({"what": what, "command": argv, "dry_run": self.dry_run})
        if self.dry_run:
            print(f"  [dry-run] {what}: {' '.join(argv)}")
            return
        r = self._run(argv)
        if r.returncode != 0:
            raise OpsError(f"{what} failed: {r.stderr.strip()}")
        print(f"  done: {what}")

    def mutate_aws(self, what: str, args: list[str]) -> None:
        self.mutate(what, [self.aws, *args, "--region", self.region])

    def mutate_kube(self, what: str, args: list[str]) -> None:
        self.mutate(what, [*self._kubectl_base(), *args])

    def require_login(self) -> None:
        r = self._run([self.aws, "sts", "get-caller-identity", "--query", "Account", "--output", "text"])
        if r.returncode != 0 or not r.stdout.strip():
            raise OpsError("No active AWS login. Run `aws sso login` (or export credentials) first.")


def deployments(rn: Runner) -> list[dict]:
    items = rn.kube_json(["get", "deployments", "-n", rn.namespace]).get("items", [])
    return sorted(
        (
            {
                "name": i["metadata"]["name"],
                "replicas": int(i.get("spec", {}).get("replicas", 0) or 0),
                "saved": (i["metadata"].get("annotations") or {}).get(ANNOTATION),
            }
            for i in items
        ),
        key=lambda d: d["name"],
    )


def nodegroups(rn: Runner) -> list[dict]:
    names = rn.aws_json(["eks", "list-nodegroups", "--cluster-name", rn.cluster]).get("nodegroups", [])
    out = []
    for name in sorted(names):
        ng = rn.aws_json(["eks", "describe-nodegroup", "--cluster-name", rn.cluster, "--nodegroup-name", name])["nodegroup"]
        sc = ng.get("scalingConfig", {})
        out.append(
            {
                "name": name,
                "arn": ng.get("nodegroupArn", ""),
                "min": int(sc.get("minSize", 0)),
                "max": int(sc.get("maxSize", 1)),
                "desired": int(sc.get("desiredSize", 0)),
                "status": ng.get("status", ""),
                "saved": (ng.get("tags") or {}).get(TAG),
            }
        )
    return out


def wait_active(rn: Runner, names: set[str], timeout_s: int) -> None:
    if rn.dry_run or not names:
        return
    poll = float(os.environ.get("AXIOM_POLL_SECONDS", "15"))
    deadline = time.monotonic() + timeout_s
    while True:
        pending = [g["name"] for g in nodegroups(rn) if g["name"] in names and g["status"] != "ACTIVE"]
        if not pending:
            return
        if time.monotonic() > deadline:
            raise OpsError(f"node groups not ACTIVE after {timeout_s}s: {', '.join(pending)}")
        time.sleep(poll)


def do_stop(rn: Runner) -> None:
    print("1/2 Deployments: replicas to 0 (previous count kept in an annotation)")
    for d in deployments(rn):
        if d["replicas"] == 0:
            print(f"  skip {d['name']}: already at 0")
            continue
        rn.mutate_kube(f"{d['name']} annotate", ["annotate", "deployment", d["name"], "-n", rn.namespace, f"{ANNOTATION}={d['replicas']}", "--overwrite"])
        rn.mutate_kube(f"{d['name']} replicas {d['replicas']} -> 0", ["scale", "deployment", d["name"], "-n", rn.namespace, "--replicas=0"])
    print("2/2 Node groups: min and desired size to 0 (previous sizing kept in a tag)")
    for g in nodegroups(rn):
        if g["min"] == 0 and g["desired"] == 0:
            print(f"  skip {g['name']}: already at 0")
            continue
        rn.mutate_aws(f"{g['name']} tag", ["eks", "tag-resource", "--resource-arn", g["arn"], "--tags", f"{TAG}={g['min']}-{g['max']}-{g['desired']}"])
        rn.mutate_aws(
            f"{g['name']} sizing {g['min']}/{g['max']}/{g['desired']} -> 0/{g['max']}/0",
            ["eks", "update-nodegroup-config", "--cluster-name", rn.cluster, "--nodegroup-name", g["name"], "--scaling-config", f"minSize=0,maxSize={g['max']},desiredSize=0"],
        )


def parse_saved(saved: str) -> tuple[int, int, int]:
    lo, hi, want = (int(x) for x in saved.split("-"))
    return lo, hi, want


def do_start(rn: Runner, timeout_s: int) -> None:
    print("1/2 Node groups: restore recorded sizing, wait until ACTIVE")
    restored: set[str] = set()
    for g in nodegroups(rn):
        if g["saved"] is None:
            print(f"  skip {g['name']}: no recorded sizing (min {g['min']}, desired {g['desired']})")
            continue
        lo, hi, want = parse_saved(g["saved"])
        rn.mutate_aws(
            f"{g['name']} sizing -> {lo}/{hi}/{want}",
            ["eks", "update-nodegroup-config", "--cluster-name", rn.cluster, "--nodegroup-name", g["name"], "--scaling-config", f"minSize={lo},maxSize={hi},desiredSize={want}"],
        )
        rn.mutate_aws(f"{g['name']} untag", ["eks", "untag-resource", "--resource-arn", g["arn"], "--tag-keys", TAG])
        restored.add(g["name"])
    wait_active(rn, restored, timeout_s)
    print("2/2 Deployments: restore recorded replicas")
    for d in deployments(rn):
        if d["saved"] is None:
            print(f"  skip {d['name']}: no recorded replicas ({d['replicas']})")
            continue
        rn.mutate_kube(f"{d['name']} replicas -> {d['saved']}", ["scale", "deployment", d["name"], "-n", rn.namespace, f"--replicas={d['saved']}"])
        rn.mutate_kube(f"{d['name']} un-annotate", ["annotate", "deployment", d["name"], "-n", rn.namespace, f"{ANNOTATION}-"])


def do_status(rn: Runner) -> int:
    deps, groups = deployments(rn), nodegroups(rn)
    print(f"Production cluster {rn.cluster} ({rn.region}), namespace {rn.namespace}\n")
    print("Deployments")
    for d in deps:
        note = f" (saved replicas {d['saved']})" if d["saved"] is not None else ""
        print(f"  {d['name']}: {d['replicas']}{note}")
    print("Node groups")
    for g in groups:
        note = f" (saved {g['saved']})" if g["saved"] is not None else ""
        print(f"  {g['name']}: min {g['min']} max {g['max']} desired {g['desired']}, {g['status']}{note}")
    billable = any(d["replicas"] > 0 for d in deps) or any(g["desired"] > 0 or g["min"] > 0 for g in groups)
    stopped_any = any(d["saved"] is not None for d in deps) or any(g["saved"] is not None for g in groups)
    if not (deps or groups):
        verdict = "NO OBJECTS FOUND"
    elif not billable:
        verdict = "SOFT-STOPPED"
    elif not stopped_any:
        verdict = "RUNNING"
    else:
        verdict = "PARTIAL"
    print(f"\nState: {verdict}")
    print("Cost that continues while soft-stopped:")
    for line in RESIDUAL_COST:
        print(f"  - {line}")
    return 0 if verdict in ("SOFT-STOPPED", "RUNNING") else 2


def record(state_dir: Path, command: str, rn: Runner) -> None:
    state_dir.mkdir(parents=True, exist_ok=True)
    path = state_dir / "production.json"
    history = json.loads(path.read_text()) if path.exists() else []
    history.append({"at": datetime.now(timezone.utc).isoformat(), "command": command, "cluster": rn.cluster, "actions": rn.actions})
    path.write_text(json.dumps(history[-50:], indent=2) + "\n")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("command", choices=["stop", "start", "status"])
    p.add_argument("--env", required=True)
    p.add_argument("--cluster", required=True)
    p.add_argument("--region", required=True)
    p.add_argument("--namespace", default="axiom-proof")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--node-timeout", type=int, default=1200)
    p.add_argument("--state-dir", default=".axiom-runtime/softstop")
    args = p.parse_args(argv)
    try:
        if args.env.lower() not in PRODUCTION_ENVS:
            raise OpsError(f"softstop-aws.py handles production only, not '{args.env}'.")
        rn = Runner(args.cluster, args.region, args.namespace, args.dry_run)
        rn.require_login()
        if args.command == "status":
            return do_status(rn)
        if args.command == "stop":
            do_stop(rn)
        else:
            do_start(rn, args.node_timeout)
        if not args.dry_run:
            record(Path(args.state_dir), args.command, rn)
            code = do_status(rn)
            if args.command == "stop" and code == 2:
                raise OpsError("The environment is not fully soft-stopped; see status above.")
        return 0
    except OpsError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
