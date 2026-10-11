#!/usr/bin/env python3
"""Authorized actual preprod idle/stop/wake proof; no direct SQL or state edits.

The cycle is deliberately incomplete until a distinct source-bound read-only
postwake Job proves retained synthetic rows. Scheduler resume is a separate
reviewed action after completion. Uncertain mutations are never retried.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import re
import secrets
import stat
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import quote
from uuid import uuid4

ROOT = Path(__file__).resolve().parent.parent


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


legacy = module(
    "deployed_lifecycle_observer", "scripts/marketing-lifecycle-acceptance.py"
)
config = legacy.config
readback = module("deployed_lifecycle_readback", "scripts/marketing-acceptance-job.py")


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def digest(value):
    return hashlib.sha256(
        (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()
    ).hexdigest()


def timestamp(value):
    parsed = datetime.fromisoformat(value)
    require(
        parsed.tzinfo is not None, "Timezone-aware actual provider timestamp required"
    )
    return parsed.timestamp()


def prepare_scope(env, release, services, seed, browser, baseline, hashes):
    project = env.get("GCP_PROJECT_ID", "")
    sha = release.get("release_sha", "")
    require(
        re.fullmatch(r"[a-z][a-z0-9-]{4,28}[a-z0-9]", project)
        and re.fullmatch("[a-f0-9]{40}", sha),
        "Explicit selected project/release required",
    )
    require(
        env.get("ENVIRONMENT") == "preprod"
        and env.get("GCP_REGION") == "asia-south1"
        and env.get("AXIOM_DEPLOYMENT_PROFILE") == "marketing",
        "Mumbai marketing preprod only",
    )
    instance = env.get("CLOUD_SQL_INSTANCE_NAME", "")
    bucket = env.get("AXIOM_IDLE_STATE_BUCKET", "")
    require(
        instance.startswith("axiom-proof-preprod-")
        and re.fullmatch("[a-z][a-z0-9-]{4,62}", instance)
        and bucket.startswith("axiom-proof-preprod-")
        and re.fullmatch("[a-z0-9-]{3,63}", bucket)
        and env.get("AXIOM_IDLE_STATE_OBJECT")
        == "marketing-preprod/lifecycle/state.json",
        "Exact preprod state/SQL scope required",
    )
    target = {
        "environment": "preprod",
        "project": project,
        "instance": instance,
        "bucket": bucket,
        "object": env["AXIOM_IDLE_STATE_OBJECT"],
    }
    target_hash = digest(target)
    require(
        release.get("lifecycle_target_manifest_sha256") == target_hash,
        "Current release target hash mismatch",
    )
    for record in (services, seed, baseline):
        require(
            record.get("project") == project and record.get("release_sha") == sha,
            "Deployment source mismatch",
        )
    require(
        seed.get("seed_target_sha256") == target_hash
        and seed.get("state_initialized") is True
        and seed.get("admission_reopened") is True
        and seed.get("bucket") == bucket
        and seed.get("object") == target["object"]
        and isinstance(seed.get("seed_generation"), str)
        and seed["seed_generation"].isdigit()
        and int(seed["seed_generation"]) > 0,
        "Verified admission/immutable seed receipt required",
    )
    require(
        services.get("idle_automation_enabled") is False,
        "Services receipt must retain paused scheduler",
    )
    require(
        set(hashes) == {"env", "release", "services", "seed", "browser", "baseline"}
        and all(re.fullmatch("[a-f0-9]{64}", v) for v in hashes.values()),
        "Exact protected input byte hashes required",
    )
    require(
        baseline.get("phase") == "acceptance-readback"
        and baseline.get("schema_version") == 1
        and baseline.get("sql_proof", {}).get("project") == project
        and baseline["sql_proof"].get("releaseSha") == sha
        and baseline["sql_proof"].get("run") == browser.get("run")
        and baseline["sql_proof"].get("observations", {}).get("database")
        == env.get("CLOUD_SQL_DATABASE_NAME"),
        "Actual original synthetic readback required",
    )
    require(
        browser.get("status") == "browser-and-api-green-storage-and-lifecycle-pending"
        and browser.get("config", {}).get("environment") == "preprod"
        and browser["config"].get("project") == project
        and browser["config"].get("releaseSha") == sha
        and browser["config"].get("servicesReceiptSha256") == hashes["services"]
        and browser.get("health", {}).get("releaseSha") == sha
        and browser["health"].get("status") == "healthy",
        "Actual source-bound deployed browser proof required",
    )
    controller = config.origin(services["lifecycle_controller_uri"], True)
    idle = int(env.get("AXIOM_IDLE_TIMEOUT_SECONDS", "0"))
    lease = int(env.get("AXIOM_IDLE_LEASE_SECONDS", "0"))
    require(
        60 <= lease <= 300 and lease <= idle <= 86400,
        "Actual configured idle/lease interval required",
    )
    name = env.get("MARKETING_LIFECYCLE_SERVICE_NAME", "")
    scheduler = env.get("MARKETING_LIFECYCLE_SCHEDULER_NAME", "")
    require(
        all(
            re.fullmatch("axiom-proof-preprod-[a-z0-9-]+", value)
            for value in (name, scheduler)
        ),
        "Exact lifecycle/scheduler names required",
    )
    image = release.get("auxiliary_images", {}).get("lifecycle", "")
    require(
        re.fullmatch(
            r"asia-south1-docker\.pkg\.dev/"
            + re.escape(project)
            + r"/[^/]+/[^@]+@sha256:[a-f0-9]{64}",
            image,
        ),
        "Immutable same-project lifecycle image required",
    )
    components = ("marketing", "bff", "auth", "rest", "gateway")
    require(
        set(release.get("images", {})) == set(components)
        and set(services.get("cloud_run_uris", {})) == set(components),
        "Exact five released services required",
    )
    service_bindings = {}
    for component in components:
        service_name = env.get("MARKETING_" + component.upper() + "_SERVICE_NAME", "")
        component_image = release["images"][component]
        require(
            re.fullmatch("axiom-proof-preprod-[a-z0-9-]+", service_name)
            and re.fullmatch(
                r"asia-south1-docker\.pkg\.dev/"
                + re.escape(project)
                + r"/[^/]+/[^@]+@sha256:[a-f0-9]{64}",
                component_image,
            ),
            "Exact immutable same-project component required",
        )
        service_bindings[component] = {
            "name": service_name,
            "image": component_image,
            "uri": config.origin(services["cloud_run_uris"][component], True),
        }
    observations = baseline["sql_proof"]["observations"]
    require(
        {row["id"] for row in observations.get("contacts", [])}
        == {row["response"]["id"] for row in browser.get("contacts", [])}
        and len(observations.get("gap", [])) == 1
        and len(browser.get("gapScans", [])) == 1
        and observations["gap"][0]["id"] == browser["gapScans"][0]["id"],
        "Retained readback identities differ from actual browser source",
    )
    migration_image = release.get("auxiliary_images", {}).get("migrations", "")
    require(
        re.fullmatch(
            r"asia-south1-docker\.pkg\.dev/"
            + re.escape(project)
            + r"/[^/]+/[^@]+@sha256:[a-f0-9]{64}",
            migration_image,
        ),
        "Immutable current read-only Job image required",
    )
    return {
        "schema_version": 1,
        "kind": "marketing-lifecycle-deployment-acceptance-plan",
        **target,
        "region": "asia-south1",
        "release_sha": sha,
        "migration_image": migration_image,
        "browser_semantic_sha256": readback.digest(browser),
        "database_connection_name": f"{project}:asia-south1:{instance}",
        "targetHash": target_hash,
        "controllerUrl": controller,
        "lifecycle_service": name,
        "scheduler_job": scheduler,
        "lifecycle_image": image,
        "scheduler_account": env["MARKETING_SCHEDULER_ACCOUNT_ID"]
        + "@"
        + project
        + ".iam.gserviceaccount.com",
        "idle_seconds": idle,
        "lease_seconds": lease,
        "hashes": hashes,
        "baseline_sql_proof": baseline["sql_proof"],
        "service_bindings": service_bindings,
        "readback_job": baseline["job"],
        "seed_generation": seed["seed_generation"],
    }


ACTIONS = {
    "cycle": [
        "observe",
        "gate/acquire",
        "idle/check",
        "gate/release",
        "wait-real-idle",
        "stop",
        "wake",
    ],
    "complete": ["observe", "verify-postwake-readonly-job"],
    "resume": ["observe", "scheduler/resume"],
}


def validate_plan(plan):
    require(
        plan.get("kind") == "marketing-lifecycle-deployment-acceptance-plan"
        and plan.get("schema_version") == 1
        and plan.get("environment") == "preprod"
        and plan.get("region") == "asia-south1"
        and re.fullmatch(r"[a-z][a-z0-9-]{4,28}[a-z0-9]", str(plan.get("project", "")))
        and re.fullmatch("[a-f0-9]{40}", str(plan.get("release_sha", ""))),
        "Runtime plan must preserve Mumbai preprod source scope",
    )
    target = {
        key: plan[key]
        for key in ("environment", "project", "instance", "bucket", "object")
    }
    require(
        re.fullmatch("axiom-proof-preprod-[a-z0-9-]+", str(target["instance"]))
        and re.fullmatch("axiom-proof-preprod-[a-z0-9-]+", str(target["bucket"]))
        and target["object"] == "marketing-preprod/lifecycle/state.json"
        and plan.get("targetHash") == digest(target),
        "Runtime target/hash differs",
    )
    require(
        config.origin(plan["controllerUrl"], True) == plan["controllerUrl"]
        and type(plan.get("idle_seconds")) is int
        and type(plan.get("lease_seconds")) is int
        and 60 <= plan["lease_seconds"] <= 300
        and plan["lease_seconds"] <= plan["idle_seconds"] <= 86400,
        "Runtime approved URL and real idle bounds required",
    )
    require(
        set(plan.get("service_bindings", {}))
        == {"marketing", "bff", "auth", "rest", "gateway"}
        and set(plan.get("hashes", {}))
        == {"env", "release", "services", "seed", "browser", "baseline"}
        and all(
            re.fullmatch("[a-f0-9]{64}", str(value))
            for value in plan["hashes"].values()
        ),
        "Runtime exact component and source hashes required",
    )
    for field in ("lifecycle_image", "migration_image"):
        require(
            re.fullmatch(
                r"asia-south1-docker\.pkg\.dev/"
                + re.escape(plan["project"])
                + r"/[^/]+/[^@]+@sha256:[a-f0-9]{64}",
                plan[field],
            ),
            "Runtime immutable same-project images required",
        )
    for binding in plan["service_bindings"].values():
        require(
            re.fullmatch("axiom-proof-preprod-[a-z0-9-]+", binding["name"])
            and config.origin(binding["uri"], True) == binding["uri"],
            "Runtime component scope differs",
        )


def authorization(plan, approval, phase, now):
    validate_plan(plan)
    require(
        approval.get("kind") == "marketing-preprod-lifecycle-deployment-acceptance"
        and approval.get("phase") == phase
        and approval.get("project") == plan["project"]
        and approval.get("release_sha") == plan["release_sha"]
        and approval.get("plan_sha256") == digest(plan)
        and approval.get("actions") == ACTIONS[phase]
        and isinstance(approval.get("approved_by"), str)
        and approval["approved_by"].strip()
        and type(approval.get("expires_unix")) is int
        and now < approval["expires_unix"] <= now + 10800,
        "Recorded exact bounded lifecycle authorization required",
    )


class Coordinator:
    def __init__(
        self,
        plan,
        approval,
        tokens,
        save,
        *,
        transport=legacy.http,
        wall=time.time,
        clock=time.monotonic,
        sleep=time.sleep,
    ):
        self.plan = plan
        self.approval = approval
        self.tokens = tokens
        self.save = save
        self.transport = transport
        self.wall = wall
        self.clock = clock
        self.sleep = sleep
        self.proof = {
            "schema_version": 1,
            "plan_sha256": digest(plan),
            "project": plan["project"],
            "release_sha": plan["release_sha"],
            "actions": [],
            "observations": [],
            "operations": [],
            "status": "in-progress",
            "source_hashes": plan["hashes"],
        }

    def active(self):
        require(
            self.wall() < self.approval["expires_unix"],
            "Lifecycle authorization expired; preserve outcome",
        )

    def get(self, url):
        self.active()
        status, value = self.transport(url, self.tokens["accessToken"])
        require(
            status == 200 and isinstance(value, dict), "Exact provider read unavailable"
        )
        return value

    def action(self, url, body, *, controller=True):
        self.active()
        entry = {"url": url, "intent_unix": self.wall(), "outcome": "unknown"}
        self.proof["actions"].append(entry)
        self.save(self.proof)
        token = (
            self.tokens["controllerIdToken"]
            if controller
            else self.tokens["accessToken"]
        )
        status, value = self.transport(url, token, body)
        entry.update(
            status=status, response=value, outcome="observed", observed_unix=self.wall()
        )
        self.save(self.proof)
        return status, value

    @staticmethod
    def exact_traffic(service):
        traffic = service.get("trafficStatuses", [])
        return (
            len(traffic) == 1
            and traffic[0].get("percent") == 100
            and traffic[0].get("revision") == service.get("latestReadyRevision")
        )

    def source(self):
        p = self.plan
        name = f"projects/{p['project']}/locations/asia-south1/services/{p['lifecycle_service']}"
        service = self.get("https://run.googleapis.com/v2/" + name)
        require(
            service.get("name") == name
            and service.get("uri") == p["controllerUrl"]
            and service.get("latestCreatedRevision")
            == service.get("latestReadyRevision")
            and isinstance(service.get("latestReadyRevision"), str)
            and service.get("terminalCondition", {}).get("state")
            == "CONDITION_SUCCEEDED"
            and service.get("reconciling") is False
            and service.get("generation") == service.get("observedGeneration"),
            "Exact ready deployed controller required",
        )
        for binding in p["service_bindings"].values():
            resource = f"projects/{p['project']}/locations/asia-south1/services/{binding['name']}"
            actual = self.get("https://run.googleapis.com/v2/" + resource)
            require(
                actual.get("name") == resource
                and actual.get("uri") == binding["uri"]
                and actual.get("latestCreatedRevision")
                == actual.get("latestReadyRevision")
                and actual.get("terminalCondition", {}).get("state")
                == "CONDITION_SUCCEEDED"
                and actual.get("reconciling") is False
                and actual.get("generation") == actual.get("observedGeneration")
                and len(actual.get("template", {}).get("containers", [])) == 1
                and actual["template"]["containers"][0].get("image")
                == binding["image"],
                "Published component source/ready identity differs",
            )
            require(
                self.exact_traffic(actual), "Published component traffic source differs"
            )
        require(
            self.exact_traffic(service),
            "Controller traffic is not wholly on reviewed ready revision",
        )
        containers = service.get("template", {}).get("containers", [])
        require(
            len(containers) == 1 and containers[0].get("image") == p["lifecycle_image"],
            "Controller immutable image differs",
        )
        values = {
            item["name"]: item.get("value")
            for item in containers[0].get("env", [])
            if isinstance(item, dict) and "name" in item
        }
        require(
            values.get("AXIOM_IDLE_INTERVAL_SECONDS") == str(p["idle_seconds"])
            and values.get("AXIOM_IDLE_LEASE_SECONDS") == str(p["lease_seconds"])
            and values.get("AXIOM_IDLE_TARGET_MANIFEST_SHA256") == p["targetHash"]
            and values.get("GCP_PROJECT_ID") == p["project"]
            and values.get("CLOUD_SQL_INSTANCE_NAME") == p["instance"],
            "Deployed idle policy/target differs",
        )
        scheduler = self.get(
            f"https://cloudscheduler.googleapis.com/v1/projects/{p['project']}/locations/asia-south1/jobs/{p['scheduler_job']}"
        )
        require(
            scheduler.get("name")
            == f"projects/{p['project']}/locations/asia-south1/jobs/{p['scheduler_job']}"
            and scheduler.get("state") == "PAUSED",
            "Exact actual Scheduler must remain paused",
        )
        target = scheduler.get("httpTarget", {})
        require(
            target.get("uri") == p["controllerUrl"] + "/idle/check"
            and target.get("httpMethod") == "POST"
            and target.get("oidcToken", {}).get("audience") == p["controllerUrl"]
            and target["oidcToken"].get("serviceAccountEmail")
            == p["scheduler_account"],
            "Scheduler target/audience differs",
        )
        return {
            "controller_revision": service["latestReadyRevision"],
            "scheduler_state": "PAUSED",
        }

    def observe(self):
        observed = legacy.observe(self.plan, self.tokens["accessToken"], self.transport)
        state = observed["state"]
        require(
            state.get("version") == 1
            and type(state.get("version")) is int
            and int(observed["generation"]) >= int(self.plan["seed_generation"])
            and int(observed["generation"]) > 0
            and type(state.get("lastActivity")) is int
            and isinstance(state.get("leases"), dict)
            and state["lastActivity"] <= self.wall() + 5,
            "Malformed actual lifecycle telemetry",
        )
        observed["observed_unix"] = self.wall()
        self.proof["observations"].append(observed)
        self.save(self.proof)
        return observed

    def running(self, observed):
        require(
            observed["state"]["phase"] == "running"
            and observed["sql"]["activationPolicy"] == "ALWAYS"
            and observed["sql"]["state"] == "RUNNABLE",
            "Exact running provider/lifecycle target required",
        )

    def lease(self, request, observed):
        lease = observed["state"]["leases"].get(request["requestId"])
        require(
            isinstance(lease, dict)
            and lease.get("tokenHash")
            == hashlib.sha256(request["leaseToken"].encode()).hexdigest(),
            "Exact durable owned lease required",
        )

    def release(self, request):
        self.lease(request, self.observe())
        status, reply = self.action(
            self.plan["controllerUrl"] + "/gate/release", request
        )
        require(
            status == 200 and reply.get("status") == "released",
            "Lease release uncertain; preserve token",
        )
        after = self.observe()
        require(
            request["requestId"] not in after["state"]["leases"],
            "Durable release missing",
        )
        return after

    def operation(self, observed, phase, deadline):
        p = self.plan
        state = observed["state"]
        operation = state.get("operation")
        transition = state.get("transition")
        require(
            state.get("phase") == phase
            and isinstance(operation, str)
            and re.fullmatch("[a-zA-Z0-9_-]{1,128}", operation)
            and isinstance(transition, str),
            "Actual operation/transition receipt required",
        )
        while True:
            op = self.get(
                f"https://sqladmin.googleapis.com/v1/projects/{p['project']}/operations/{quote(operation, safe='')}"
            )
            require(
                op.get("name") == operation
                and op.get("targetId") == p["instance"]
                and op.get("targetProject") == p["project"]
                and op.get("status") in ("PENDING", "RUNNING", "DONE")
                and op.get("operationType") == "UPDATE"
                and not op.get("error"),
                "Actual operation identity/status differs",
            )
            self.proof["operations"].append(op)
            self.save(self.proof)
            current = self.observe()
            require(
                current["state"].get("phase") == phase
                and current["state"].get("operation") == operation
                and current["state"].get("transition") == transition,
                "Operation changed or externally reconciled",
            )
            if op["status"] == "DONE":
                require(
                    timestamp(op["endTime"]) >= timestamp(op["startTime"])
                    and timestamp(op["startTime"])
                    >= self.proof["actions"][-1]["intent_unix"] - 5
                    and timestamp(op["endTime"]) <= self.wall() + 5,
                    "Actual completed operation times required",
                )
                require(
                    current["sql"]["activationPolicy"]
                    == ("NEVER" if phase == "stopping" else "ALWAYS")
                    and current["sql"]["state"] == "RUNNABLE",
                    "Completed operation/provider policy differ",
                )
                return op, current
            require(
                self.clock() < deadline,
                "Provider operation timeout; preserve transition",
            )
            self.sleep(min(10, max(0, deadline - self.clock())))

    def cycle(self):
        p = self.plan
        authorization(p, self.approval, "cycle", self.wall())
        require(
            self.approval["expires_unix"] - self.wall() > p["idle_seconds"] + 1800,
            "Authorization must cover real idle and both bounded operations",
        )
        self.source()
        before = self.observe()
        self.running(before)
        require(not before["state"]["leases"], "Existing lease blocks acceptance")
        request = {"requestId": str(uuid4()), "leaseToken": secrets.token_hex(32)}
        self.proof["hold_recovery"] = request
        self.save(self.proof)
        status, reply = self.action(p["controllerUrl"] + "/gate/acquire", request)
        require(
            status == 200 and reply.get("status") == "admitted",
            "Hold acquisition uncertain; preserve token",
        )
        held = self.observe()
        self.running(held)
        self.lease(request, held)
        status, reply = self.action(p["controllerUrl"] + "/idle/check", {})
        require(
            status == 503 and reply.get("status") == "in_flight_or_completion_unknown",
            "Actual in-flight stop refusal missing",
        )
        after = self.observe()
        self.running(after)
        self.lease(request, after)
        require(after["sql"] == held["sql"], "Provider changed while lease held")
        released = self.release(request)
        self.running(released)
        self.proof["inflight_refusal_verified"] = True
        self.save(self.proof)
        start = self.clock()
        deadline = start + p["idle_seconds"] + 900
        # Even an old lastActivity cannot shorten the real idle interval after our release.
        while True:
            self.active()
            current = self.observe()
            self.running(current)
            require(
                not current["state"]["leases"],
                "New or unknown in-flight lease blocks stop",
            )
            elapsed = self.clock() - start
            if (
                elapsed >= p["idle_seconds"]
                and self.wall() - current["state"]["lastActivity"]
                >= p["idle_seconds"] + 5
            ):
                break
            require(
                self.clock() < deadline,
                "Real idle deadline exceeded; no timestamp repair",
            )
            self.proof["idle_wait"] = {
                "elapsed_monotonic_seconds": elapsed,
                "last_activity_observed": current["state"]["lastActivity"],
            }
            self.save(self.proof)
            self.sleep(min(30, max(0, deadline - self.clock())))
        self.source()
        status, reply = self.action(p["controllerUrl"] + "/idle/check", {})
        require(
            status == 503 and reply.get("status") == "stopping",
            "Actual stop transition missing; no repeat",
        )
        stop, stopped_policy = self.operation(
            self.observe(), "stopping", self.clock() + 900
        )
        require(
            int(stopped_policy["sql"]["settingsVersion"])
            > int(after["sql"]["settingsVersion"]),
            "Actual stop settings version must advance",
        )
        status, reply = self.action(p["controllerUrl"] + "/idle/check", {})
        require(
            status == 503 and reply.get("status") == "stopped",
            "Completed stop reconciliation missing",
        )
        stopped = self.observe()
        require(
            stopped["state"]["phase"] == "stopped"
            and stopped["sql"]["activationPolicy"] == "NEVER"
            and not stopped["state"]["leases"],
            "Actual cold state missing",
        )
        wake = {"requestId": str(uuid4()), "leaseToken": secrets.token_hex(32)}
        self.proof["wake_recovery"] = wake
        self.save(self.proof)
        status, reply = self.action(p["controllerUrl"] + "/gate/acquire", wake)
        require(
            status == 503 and reply.get("status") == "starting",
            "Actual wake transition missing; no repeat",
        )
        started, running_policy = self.operation(
            self.observe(), "starting", self.clock() + 900
        )
        require(
            int(running_policy["sql"]["settingsVersion"])
            > int(stopped["sql"]["settingsVersion"]),
            "Actual wake settings version must advance",
        )
        require(
            started["name"] != stop["name"],
            "Distinct actual stop/wake operation required",
        )
        status, reply = self.action(p["controllerUrl"] + "/gate/acquire", wake)
        require(
            status == 200 and reply.get("status") == "admitted",
            "Completed wake admission missing",
        )
        admitted = self.observe()
        self.running(admitted)
        self.lease(wake, admitted)
        self.release(wake)
        self.source()
        self.proof.update(
            status="cold-cycle-green-postwake-readback-pending",
            stop_operation=stop["name"],
            wake_operation=started["name"],
            wake_completed_unix=timestamp(started["endTime"]),
            finished_unix=self.wall(),
        )
        self.save(self.proof)
        return self.proof


def complete(
    plan, cycle, approval, prepared, actual_job, execution, entries, *, now=None
):
    now = time.time() if now is None else now
    authorization(plan, approval, "complete", now)
    require(
        cycle.get("status") == "cold-cycle-green-postwake-readback-pending"
        and cycle.get("plan_sha256") == digest(plan)
        and cycle.get("project") == plan["project"]
        and cycle.get("release_sha") == plan["release_sha"]
        and cycle.get("inflight_refusal_verified") is True
        and approval.get("cycle_sha256") == digest(cycle),
        "Actual source-bound complete cold cycle required",
    )
    base = plan["readback_job"].removesuffix("-readback")
    require(
        prepared.get("job", {}).get("name") == base + "-readback-postwake",
        "Distinct exact postwake read-only Job required",
    )
    require(
        approval.get("postwake_plan_sha256") == digest(prepared)
        and prepared.get("project") == plan["project"]
        and prepared.get("release_sha") == plan["release_sha"]
        and prepared.get("database_connection_name") == plan["database_connection_name"]
        and prepared.get("browser_sha256") == plan["browser_semantic_sha256"],
        "Approved exact postwake descriptor/source binding required",
    )
    task = prepared["job"].get("template", {})
    runtime = task.get("template", {})
    containers = runtime.get("containers", [])
    require(
        task.get("taskCount") == 1
        and task.get("parallelism") == 1
        and runtime.get("maxRetries") == 0
        and runtime.get("timeout") == "60s"
        and len(containers) == 1
        and containers[0].get("image") == plan["migration_image"]
        and containers[0].get("command") == ["python3"]
        and containers[0].get("args")
        == ["/app/scripts/marketing-acceptance-job.py", "run"],
        "Fixed immutable read-only postwake runtime required",
    )
    proof = readback.verify_execution(prepared, actual_job, execution, entries)
    require(
        proof.get("project") == plan["project"]
        and proof.get("release_sha") == plan["release_sha"]
        and proof.get("sql_proof") == plan["baseline_sql_proof"]
        and timestamp(execution["startTime"]) >= cycle["wake_completed_unix"]
        and timestamp(proof["completion_time"]) >= timestamp(execution["startTime"]),
        "Actual postwake execution/source/retained rows differ",
    )
    return {
        "schema_version": 1,
        "status": "actual-lifecycle-and-postwake-readback-green-scheduler-paused",
        "project": plan["project"],
        "release_sha": plan["release_sha"],
        "plan_sha256": digest(plan),
        "cycle_sha256": digest(cycle),
        "postwake_proof": proof,
        "closed_gates": [
            "lifecycle-cold-stop-wake-and-inflight-refusal",
            "postwake-retained-row-readback",
        ],
        "remaining_gates": ["separately-approved-scheduler-resume"],
        "completed_unix": now,
    }


def resume(
    plan,
    completed,
    approval,
    tokens,
    save,
    *,
    transport=legacy.http,
    now=None,
    wall=time.time,
):
    now = time.time() if now is None else now
    authorization(plan, approval, "resume", now)
    require(
        completed.get("status")
        == "actual-lifecycle-and-postwake-readback-green-scheduler-paused"
        and completed.get("plan_sha256") == digest(plan)
        and approval.get("completed_sha256") == digest(completed),
        "Exact green completion and separate resume authorization required",
    )
    runner = Coordinator(plan, approval, tokens, save, transport=transport, wall=wall)
    runner.source()
    current = runner.observe()
    runner.running(current)
    require(
        not current["state"]["leases"], "Outstanding lease blocks scheduler activation"
    )
    url = f"https://cloudscheduler.googleapis.com/v1/projects/{plan['project']}/locations/asia-south1/jobs/{plan['scheduler_job']}"
    status, reply = runner.action(url + ":resume", {}, controller=False)
    require(
        status == 200
        and reply.get("name")
        == url.removeprefix("https://cloudscheduler.googleapis.com/v1/")
        and reply.get("state") == "ENABLED",
        "Scheduler resume outcome uncertain; no retry",
    )
    observed = runner.get(url)
    require(
        observed.get("name") == reply["name"] and observed.get("state") == "ENABLED",
        "Actual enabled scheduler observation required",
    )
    runner.proof.update(
        status="actual-lifecycle-acceptance-green-scheduler-enabled",
        completed_sha256=digest(completed),
    )
    save(runner.proof)
    return runner.proof


def save_private(path, value):
    """Atomic, fsynced recovery evidence before every authorized transmission."""
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    require(
        not path.parent.is_symlink()
        and stat.S_IMODE(path.parent.stat().st_mode) & 0o077 == 0,
        "Protected output directory required",
    )
    require(not path.is_symlink(), "Symlink output refused")
    temp = path.parent / (path.name + ".pending-" + secrets.token_hex(16))
    descriptor = os.open(
        temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600
    )
    with os.fdopen(descriptor, "wb") as fd:
        fd.write((json.dumps(value, sort_keys=True) + "\n").encode())
        fd.flush()
        os.fsync(fd.fileno())
    os.replace(temp, path)
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--phase", choices=("plan", "cycle", "complete", "resume"), required=True
    )
    for key in (
        "env-file",
        "release",
        "services",
        "seed",
        "browser",
        "baseline",
        "plan",
        "approval",
        "tokens",
        "cycle",
        "completed",
        "postwake-plan",
        "postwake-job",
        "postwake-execution",
        "postwake-logs",
        "output",
    ):
        parser.add_argument("--" + key, type=Path)
    args = parser.parse_args()
    try:
        require(
            args.output is not None
            and not args.output.exists()
            and not args.output.is_symlink(),
            "Fresh protected proof output required",
        )

        def load(name):
            path = getattr(args, name)
            require(path is not None, "Required protected input missing")
            return config.json_input(path)[0]

        save = lambda value: save_private(args.output, value)
        if args.phase == "plan":
            parser_module = module(
                "literal_lifecycle_env", "scripts/lib/ops-env-parse.py"
            )
            config.protected_read(args.env_file)
            env = parser_module.parse(args.env_file)
            values = {
                key: load(key)
                for key in ("release", "services", "seed", "browser", "baseline")
            }
            paths = {
                "env": args.env_file,
                **{key: getattr(args, key) for key in values},
            }
            hashes = {
                key: hashlib.sha256(config.protected_read(path)).hexdigest()
                for key, path in paths.items()
            }
            save(prepare_scope(env, **values, hashes=hashes))
        elif args.phase == "cycle":
            Coordinator(load("plan"), load("approval"), load("tokens"), save).cycle()
        elif args.phase == "complete":
            logs = load("postwake_logs")
            entries = logs.get("entries")
            require(
                isinstance(entries, list),
                "Bounded actual execution log entries required",
            )
            save(
                complete(
                    load("plan"),
                    load("cycle"),
                    load("approval"),
                    load("postwake_plan"),
                    load("postwake_job"),
                    load("postwake_execution"),
                    entries,
                )
            )
        else:
            resume(
                load("plan"), load("completed"), load("approval"), load("tokens"), save
            )
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        print(
            "Lifecycle acceptance refused or uncertain; protected evidence preserved, no automatic retry or repair."
        )
        return 1
    print(
        "Lifecycle acceptance phase recorded; inspect exact protected status before proceeding."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
