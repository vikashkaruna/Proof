#!/usr/bin/env python3
"""Soft stop and start of a non-production Axiom Proof environment on GCP.

Cuts cloud spend while the environment is idle WITHOUT deleting anything, so
every object keeps its ID and every wiring (Cloud Run -> VPC connector -> Cloud
SQL private IP -> Secret Manager) stays valid.

What it touches, and how it is reversed:

  Cloud Run   axiom-proof-<env>-*  manual scaling -> 0 (disabled, including requests).
                                   Previous revision/service minima and manual
                                   scaling are restored by start. Legacy names
                                   axiom-*-<env> are also supported.
                                   The previous minimum is
                                   kept in the label `axiom-softstop-min`, and
                                   `start` puts it back. Scale-to-zero services
                                   cost nothing while idle.
  Compute VM  axiom-<env>-*        `instances stop` (disks and addresses stay).
                                   Only VMs that were RUNNING are stopped and
                                   labelled `axiom-softstopped`; `start` starts
                                   exactly those, so a VM an operator stopped on
                                   purpose is never started behind their back.
  Cloud SQL   axiom-proof-<env>-pg-*   activation policy NEVER (instance
                                   stopped, storage and backups kept). `start`
                                   sets ALWAYS and waits until it is RUNNABLE
                                   before anything that needs the database.

Order: stop = Cloud Run, VMs, then SQL. start = SQL, VMs, then Cloud Run.

Cloud Run uses Direct VPC egress (no connector), so nothing in the network layer
bills while idle. It cannot pause Cloud SQL storage, Artifact Registry images,
Secret Manager secrets or the S3 evidence bucket; `status` lists them as the
residual cost. Production is refused outright.

State lives on the objects themselves (labels), so a different laptop can run
`start`. A JSON record of each action is also written under --state-dir.
Standard library only; shells out to `gcloud` (override with AXIOM_GCLOUD).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess  # nosec B404
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

LABEL_MIN = "axiom-softstop-min"
LABEL_STOPPED = "axiom-softstopped"
LABEL_MODE = "axiom-softstop-manual"
LABEL_SERVICE_MIN = "axiom-softstop-service-min"
PROTECTED_ENVS = {"production", "prod"}
RESIDUAL_COST = (
    "Cloud SQL storage and backups (instance is stopped, disk is kept)",
    "Compute disks of stopped VMs",
    "Artifact Registry images and Secret Manager secrets",
    "S3 evidence storage (production Compliance locks protected; nonprod cleanup separate)",
    "Third-party subscriptions (Temporal Cloud, Upstash)",
)


class OpsError(Exception):
    pass


class Gcloud:
    def __init__(self, project: str, dry_run: bool) -> None:
        self.project = project
        self.dry_run = dry_run
        self.binary = os.environ.get("AXIOM_GCLOUD", "gcloud")
        self.actions: list[dict] = []

    def _run(self, args: list[str]) -> subprocess.CompletedProcess:
        return subprocess.run(
            [self.binary, *args], capture_output=True, text=True, timeout=900
        )  # nosec B603

    def read_json(self, args: list[str]) -> list[dict]:
        result = self._run([*args, "--project", self.project, "--format=json"])
        if result.returncode != 0:
            raise OpsError(f"gcloud {' '.join(args)} failed: {result.stderr.strip()}")
        return json.loads(result.stdout or "[]")

    def mutate(self, what: str, args: list[str]) -> None:
        full = [*args, "--project", self.project, "--quiet"]
        self.actions.append(
            {"what": what, "command": ["gcloud", *full], "dry_run": self.dry_run}
        )
        if self.dry_run:
            print(f"  [dry-run] {what}: gcloud {' '.join(full)}")
            return
        result = self._run(full)
        if result.returncode != 0:
            raise OpsError(f"{what} failed: {result.stderr.strip()}")
        print(f"  done: {what}")

    def require_login(self) -> None:
        result = self._run(
            ["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"]
        )
        if result.returncode != 0 or not result.stdout.strip():
            raise OpsError("No active gcloud login. Run `gcloud auth login` first.")


def last_segment(url: str) -> str:
    return url.rstrip("/").rsplit("/", 1)[-1]


def owned_name(name: str, env: str, kind: str) -> bool:
    """Exact environment boundary; support current and previously deployed names."""
    if not re.fullmatch(r"[a-z][a-z0-9-]*", name):
        return False
    if name.startswith(f"axiom-proof-{env}-"):
        return True
    if kind == "run":
        return name.startswith("axiom-") and name.endswith(f"-{env}")
    return kind == "vm" and name.startswith(f"axiom-{env}-")


def run_services(gc: Gcloud, region: str, env: str) -> list[dict]:
    items = gc.read_json(["run", "services", "list", "--region", region])
    wanted = []
    for item in items:
        name = item.get("metadata", {}).get("name", "")
        if owned_name(name, env, "run"):
            annotations = (
                item.get("spec", {})
                .get("template", {})
                .get("metadata", {})
                .get("annotations", {})
                or {}
            )
            service = item.get("metadata", {}).get("annotations") or {}
            labels = item.get("metadata", {}).get("labels") or {}
            wanted.append(
                {
                    "name": name,
                    "min": int(
                        annotations.get("autoscaling.knative.dev/minScale", "0") or 0
                    ),
                    "label": labels.get(LABEL_MIN),
                    "serviceMin": int(
                        service.get("run.googleapis.com/minScale", "0") or 0
                    ),
                    "mode": service.get("run.googleapis.com/scalingMode", "automatic"),
                    "manual": int(
                        service.get("run.googleapis.com/manualInstanceCount", "0") or 0
                    ),
                    "savedManual": labels.get(LABEL_MODE),
                    "savedServiceMin": labels.get(LABEL_SERVICE_MIN),
                }
            )
    return sorted(wanted, key=lambda s: s["name"])


def sql_instances(gc: Gcloud, env: str) -> list[dict]:
    items = gc.read_json(["sql", "instances", "list"])
    return sorted(
        (
            {
                "name": i["name"],
                "state": i.get("state", ""),
                "policy": i.get("settings", {}).get("activationPolicy", ""),
                "tier": i.get("settings", {}).get("tier", "unknown"),
                "edition": i.get("settings", {}).get("edition", "ENTERPRISE"),
                "availability": i.get("settings", {}).get("availabilityType", "ZONAL"),
                "databaseVersion": i.get("databaseVersion", ""),
                "replica": bool(i.get("masterInstanceName") or i.get("replicaNames")),
                "diskGb": i.get("settings", {}).get("dataDiskSizeGb", "unknown"),
                "stopped_by_us": (i.get("settings", {}).get("userLabels") or {}).get(
                    LABEL_STOPPED
                )
                == "true",
            }
            for i in items
            if owned_name(i.get("name", ""), env, "sql")
            and i.get("region", os.environ.get("GCP_REGION", ""))
            in (os.environ.get("GCP_REGION", ""), "")
        ),
        key=lambda i: i["name"],
    )


def vms(gc: Gcloud, env: str) -> list[dict]:
    items = gc.read_json(["compute", "instances", "list"])
    return sorted(
        (
            {
                "name": i["name"],
                "zone": last_segment(i.get("zone", "")),
                "status": i.get("status", ""),
                "stopped_by_us": (i.get("labels") or {}).get(LABEL_STOPPED) == "true",
            }
            for i in items
            if owned_name(i.get("name", ""), env, "vm")
            and last_segment(i.get("zone", "")).startswith(
                os.environ.get("GCP_REGION", "") + "-"
            )
        ),
        key=lambda v: v["name"],
    )


def wait_sql_runnable(gc: Gcloud, env: str, names: set[str], timeout_s: int) -> None:
    """Wait for the instances this run started; one left stopped on purpose is not awaited."""
    if gc.dry_run or not names:
        return
    poll = float(os.environ.get("AXIOM_POLL_SECONDS", "10"))
    deadline = time.monotonic() + timeout_s
    while True:
        pending = [
            i["name"]
            for i in sql_instances(gc, env)
            if i["name"] in names and i["state"] != "RUNNABLE"
        ]
        if not pending:
            return
        if time.monotonic() > deadline:
            raise OpsError(
                f"Cloud SQL not RUNNABLE after {timeout_s}s: {', '.join(pending)}"
            )
        time.sleep(poll)


def do_stop(gc: Gcloud, region: str, env: str, smallest_sql: bool = False) -> None:
    instances = sql_instances(gc, env)
    if smallest_sql:
        for inst in instances:
            if inst["tier"] != "db-f1-micro" and (
                inst["edition"] != "ENTERPRISE"
                or inst["availability"] != "ZONAL"
                or inst["replica"]
                or not inst["databaseVersion"].startswith("POSTGRES_")
            ):
                raise OpsError(
                    "Smallest SQL tier requires a standalone ZONAL PostgreSQL Enterprise instance; no implicit HA/edition/replica conversion."
                )
    print("1/3 Cloud Run: disable request-triggered startup (manual scaling 0)")
    for svc in run_services(gc, region, env):
        if svc["mode"] == "manual" and svc["manual"] == 0:
            print(f"  skip {svc['name']}: disabled (manual scaling 0)")
            continue
        saved = {
            LABEL_MIN: str(svc["label"] if svc["label"] is not None else svc["min"])
        }
        if svc["mode"] == "manual":
            saved[LABEL_MODE] = str(svc["manual"])
        if svc["savedServiceMin"] is not None or svc["serviceMin"]:
            saved[LABEL_SERVICE_MIN] = str(svc["savedServiceMin"] or svc["serviceMin"])
        gc.mutate(
            f"{svc['name']} scaling -> 0",
            [
                "run",
                "services",
                "update",
                svc["name"],
                "--region",
                region,
                "--scaling",
                "0",
                "--min",
                "0",
                "--min-instances",
                "0",
                "--update-labels",
                ",".join(k + "=" + v for k, v in saved.items()),
            ],
        )
    print("2/3 Compute VMs: stop running ones (disks kept)")
    for vm in vms(gc, env):
        if vm["status"] != "RUNNING":
            print(f"  skip {vm['name']}: {vm['status'] or 'not running'}")
            continue
        gc.mutate(
            f"{vm['name']} label",
            [
                "compute",
                "instances",
                "add-labels",
                vm["name"],
                "--zone",
                vm["zone"],
                "--labels",
                f"{LABEL_STOPPED}=true",
            ],
        )
        gc.mutate(
            f"{vm['name']} stop",
            ["compute", "instances", "stop", vm["name"], "--zone", vm["zone"]],
        )
    print("3/3 Cloud SQL: activation policy NEVER (instance and disk kept)")
    for inst in instances:
        if smallest_sql and inst["tier"] != "db-f1-micro":
            if (
                inst["edition"] != "ENTERPRISE"
                or inst["availability"] != "ZONAL"
                or inst["replica"]
                or not inst["databaseVersion"].startswith("POSTGRES_")
            ):
                raise OpsError(
                    "Smallest SQL tier requires a standalone ZONAL PostgreSQL Enterprise instance; no implicit HA/edition/replica conversion."
                )
            gc.mutate(
                f"{inst['name']} test tier -> db-f1-micro",
                ["sql", "instances", "patch", inst["name"], "--tier", "db-f1-micro"],
            )
        if inst["policy"] == "NEVER":
            print(f"  skip {inst['name']}: already stopped")
            continue
        gc.mutate(
            f"{inst['name']} stop",
            [
                "sql",
                "instances",
                "patch",
                inst["name"],
                "--activation-policy",
                "NEVER",
                "--update-labels",
                f"{LABEL_STOPPED}=true",
            ],
        )


def do_start(gc: Gcloud, region: str, env: str, sql_timeout_s: int) -> None:
    print("1/3 Cloud SQL: activation policy ALWAYS, wait until RUNNABLE")
    started: set[str] = set()
    for inst in sql_instances(gc, env):
        if inst["policy"] == "ALWAYS" and inst["state"] == "RUNNABLE":
            print(f"  skip {inst['name']}: already running")
            continue
        if not inst["stopped_by_us"] and inst["policy"] == "NEVER":
            print(
                f"  skip {inst['name']}: stopped by someone else (no {LABEL_STOPPED} label); start it explicitly if intended"
            )
            continue
        gc.mutate(
            f"{inst['name']} start",
            [
                "sql",
                "instances",
                "patch",
                inst["name"],
                "--activation-policy",
                "ALWAYS",
                "--remove-labels",
                LABEL_STOPPED,
            ],
        )
        started.add(inst["name"])
    wait_sql_runnable(gc, env, started, sql_timeout_s)
    print("2/3 Compute VMs: start the ones this tool stopped")
    for vm in vms(gc, env):
        if not vm["stopped_by_us"]:
            print(f"  skip {vm['name']}: not stopped by this tool ({vm['status']})")
            continue
        gc.mutate(
            f"{vm['name']} start",
            ["compute", "instances", "start", vm["name"], "--zone", vm["zone"]],
        )
        gc.mutate(
            f"{vm['name']} unlabel",
            [
                "compute",
                "instances",
                "remove-labels",
                vm["name"],
                "--zone",
                vm["zone"],
                "--labels",
                LABEL_STOPPED,
            ],
        )
    print("3/3 Cloud Run: restore the recorded minimum instances")
    for svc in run_services(gc, region, env):
        if svc["label"] is None:
            print(f"  skip {svc['name']}: no recorded minimum (min {svc['min']})")
            continue
        gc.mutate(
            f"{svc['name']} min -> {svc['label']}",
            [
                "run",
                "services",
                "update",
                svc["name"],
                "--region",
                region,
                "--scaling",
                svc["savedManual"] if svc["savedManual"] is not None else "auto",
                "--min",
                svc["savedServiceMin"] or "0",
                "--min-instances",
                svc["label"],
                "--remove-labels",
                ",".join((LABEL_MIN, LABEL_MODE, LABEL_SERVICE_MIN)),
            ],
        )


def do_status(gc: Gcloud, region: str, env: str, expect_stopped: bool = False) -> int:
    services = run_services(gc, region, env)
    sqls = sql_instances(gc, env)
    machines = vms(gc, env)
    print(f"Environment {env} in project {gc.project}, region {region}\n")
    print("Cloud Run")
    if not services:
        print("  none matched in this project/region")
    for s in services:
        note = f" (saved minimum {s['label']})" if s["label"] is not None else ""
        print(
            f"  {s['name']}: {s['mode']}, manual count {s['manual']}, revision min {s['min']}, service min {s['serviceMin']}{note}"
        )
    print("Cloud SQL")
    if not sqls:
        print("  none matched in this project/region")
    for i in sqls:
        print(
            f"  {i['name']}: {i['state'] or 'unknown'}, policy {i['policy'] or 'unknown'}, tier {i['tier']}, disk {i['diskGb']} GB"
        )
    print("Compute VMs")
    if not machines:
        print("  none matched in this project/region")
    for v in machines:
        print(f"  {v['name']}: {v['status']}")
    billable_run = [
        s for s in services if not (s["mode"] == "manual" and s["manual"] == 0)
    ]
    sql_up = [i for i in sqls if i["policy"] != "NEVER"]
    vm_up = [v for v in machines if v["status"] not in ("TERMINATED", "SUSPENDED")]
    stopped_any = (
        any(s["label"] is not None for s in services)
        or any(i["policy"] == "NEVER" for i in sqls)
        or any(v["stopped_by_us"] for v in machines)
    )
    if not (services or sqls or machines):
        verdict = (
            "EMPTY (no Cloud Run, Cloud SQL or VM objects matched; nothing was stopped)"
        )
    elif not (billable_run or sql_up or vm_up):
        verdict = "SOFT-STOPPED"
    elif not stopped_any:
        verdict = "RUNNING"
    else:
        verdict = "PARTIAL"
    print(f"\nState: {verdict}")
    print("Cost that continues while soft-stopped:")
    for line in RESIDUAL_COST:
        print(f"  - {line}")
    print(
        "These are potential residual charges, not a billing inventory. Secrets are retained."
    )
    print(
        "Deleting SQL disk storage requires deleting that instance; stop and --smallest-sql retain its data."
    )
    print(
        "Explicit preprod cleanup: axiom-ops.sh cleanup --env preprod --dry-run -- <category flags>"
    )
    accepted = ("SOFT-STOPPED",) if expect_stopped else ("SOFT-STOPPED", "RUNNING")
    return 0 if verdict in accepted or not (services or sqls or machines) else 2


def record(state_dir: Path, env: str, command: str, gc: Gcloud) -> None:
    state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    if state_dir.is_symlink() or state_dir.stat().st_uid != os.getuid():
        raise OpsError("Owned state directory required")
    state_dir.chmod(0o700)
    path = state_dir / f"{env}.json"
    if path.is_symlink():
        raise OpsError("State symlink refused")
    history = json.loads(path.read_text()) if path.exists() else []
    history.append(
        {
            "at": datetime.now(timezone.utc).isoformat(),
            "command": command,
            "project": gc.project,
            "actions": gc.actions,
        }
    )
    path.write_text(json.dumps(history[-50:], indent=2) + "\n")
    path.chmod(0o600)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("command", choices=["stop", "start", "status"])
    p.add_argument("--env", required=True)
    p.add_argument("--project", required=True)
    p.add_argument("--region", required=True)
    p.add_argument("--dry-run", action="store_true")
    p.add_argument(
        "--smallest-sql",
        action="store_true",
        help="stop only: rightsize compatible testing SQL to db-f1-micro; retain its disk",
    )
    p.add_argument("--sql-timeout", type=int, default=900)
    p.add_argument("--state-dir", default=".axiom-runtime/softstop")
    args = p.parse_args(argv)

    try:
        if args.env.lower() in PROTECTED_ENVS:
            raise OpsError(
                f"Refusing to soft-stop '{args.env}': production is never stopped by tooling."
            )
        if (
            args.env not in ("preprod", "staging", "local", "onprem")
            or not re.fullmatch(r"[a-z][a-z0-9-]*", args.project)
            or not re.fullmatch(r"[a-z]+-[a-z]+[0-9]", args.region)
        ):
            raise OpsError(
                "Explicit supported environment, project and region required."
            )
        if args.smallest_sql and (args.command != "stop" or args.env != "preprod"):
            raise OpsError("--smallest-sql is restricted to stop --env preprod")
        os.environ["GCP_REGION"] = args.region
        gc = Gcloud(args.project, args.dry_run)
        gc.require_login()
        if args.command == "status":
            return do_status(gc, args.region, args.env)
        if args.command == "stop":
            do_stop(gc, args.region, args.env, args.smallest_sql)
        else:
            do_start(gc, args.region, args.env, args.sql_timeout)
        if not args.dry_run:
            record(Path(args.state_dir), args.env, args.command, gc)
            code = do_status(
                gc, args.region, args.env, expect_stopped=args.command == "stop"
            )
            if args.command == "stop" and code == 2:
                raise OpsError(
                    "The environment is not fully soft-stopped (or no objects matched this project, region and env); see status above."
                )
        return 0
    except (OpsError, ValueError, OSError, subprocess.TimeoutExpired) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
