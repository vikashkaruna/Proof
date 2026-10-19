"""Preprod-only durable admission gate. No SQL credentials or arbitrary targets.

Cloud Run IAM must restrict invocation to the BFF and authenticated Scheduler.
Every SQL-bound request must use this gate and release only after DB work ends.
Expired/missing telemetry NEVER establishes that an in-flight request finished.
"""

from __future__ import annotations

import copy
import hashlib
import json
import re
import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol, TypedDict, cast
from uuid import UUID


class Unavailable(Exception):
    """Cannot prove safe admission/state transition."""


class Conflict(Exception):
    """Object generation changed; reread the durable state."""


def unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate_json_key")
        result[key] = value
    return result


@dataclass(frozen=True)
class Target:
    project: str
    instance: str
    bucket: str
    object_name: str
    digest: str
    request_seconds: int = 25
    lease_seconds: int = 120
    idle_seconds: int = 900

    @classmethod
    def from_environment(cls, env: dict[str, str]) -> Target:
        try:
            manifest = Path(env["AXIOM_IDLE_TARGET_MANIFEST"]).read_bytes()
            digest = hashlib.sha256(manifest).hexdigest()
            if len(manifest) > 4096:
                raise ValueError
            approved = json.loads(manifest, object_pairs_hook=unique_object)
            selected = {
                "environment": env["ENVIRONMENT"],
                "project": env["GCP_PROJECT_ID"],
                "instance": env["CLOUD_SQL_INSTANCE_NAME"],
                "bucket": env["AXIOM_IDLE_STATE_BUCKET"],
                "object": env["AXIOM_IDLE_STATE_OBJECT"],
            }
            if (
                digest != env["AXIOM_IDLE_TARGET_MANIFEST_SHA256"]
                or approved != selected
            ):
                raise ValueError
            if selected["environment"] != "preprod":
                raise ValueError
            project = selected["project"]
            if not re.fullmatch(r"[a-z][a-z0-9-]{4,28}[a-z0-9]", project):
                raise ValueError
            if not selected["instance"].startswith(
                project + "-preprod-"
            ) or not re.fullmatch(r"[a-z][a-z0-9-]{0,97}", selected["instance"]):
                raise ValueError
            if not selected["bucket"].startswith(
                project + "-preprod-state-"
            ) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{2,62}", selected["bucket"]):
                raise ValueError
            if selected["object"] != "marketing-preprod/lifecycle/state.json":
                raise ValueError
            request = int(env.get("AXIOM_IDLE_REQUEST_MAX_SECONDS", "25"))
            lease = int(env.get("AXIOM_IDLE_LEASE_SECONDS", "120"))
            idle = int(env.get("AXIOM_IDLE_INTERVAL_SECONDS", "900"))
            if (
                not 1 <= request <= 25
                or not request + 30 <= lease <= 300
                or not lease <= idle <= 86400
            ):
                raise ValueError
            return cls(
                project,
                selected["instance"],
                selected["bucket"],
                selected["object"],
                digest,
                request,
                lease,
                idle,
            )
        except (KeyError, OSError, ValueError, TypeError, RecursionError):
            raise Unavailable("approved_preprod_target_required") from None


def bootstrap_state(target: Target, *, now: int, phase: str) -> State:
    """Deployment-only bootstrap AFTER exclusive-gate adoption, never an HTTP action."""
    if phase not in ("running", "stopped"):
        raise ValueError("invalid_bootstrap_phase")
    return {
        "version": 1,
        "targetHash": target.digest,
        "phase": phase,
        "lastActivity": now,
        "leases": {},
        "transition": None,
        "operation": None,
    }


class Lease(TypedDict):
    tokenHash: str
    expiresAt: int


class State(TypedDict):
    version: int
    targetHash: str
    phase: str
    lastActivity: int
    leases: dict[str, Lease]
    transition: str | None
    operation: str | None


def valid_uuid(value: object) -> bool:
    if not isinstance(value, str):
        return False
    try:
        return str(UUID(value)) == value
    except ValueError:
        return False


class Store(Protocol):
    def read(self) -> tuple[str, object]: ...
    def write(self, generation: str, state: State) -> None: ...


class Cloud(Protocol):
    def instance(self) -> dict[str, object]: ...
    def activate(self, policy: str) -> str: ...
    def operation_done(self, operation: str) -> bool: ...


@dataclass(frozen=True)
class Reply:
    status: int
    body: dict[str, object]


def unavailable(code: str) -> Reply:
    return Reply(503, {"status": code, "saved": False})


class Controller:
    def __init__(
        self,
        target: Target,
        store: Store,
        cloud: Cloud,
        clock: Callable[[], float] = time.time,
    ):
        self.target, self.store, self.cloud, self.clock = target, store, cloud, clock

    def _read(self) -> tuple[str, State]:
        generation, state = self.store.read()
        now = int(self.clock())
        if (
            not isinstance(state, dict)
            or set(state)
            != {
                "version",
                "targetHash",
                "phase",
                "lastActivity",
                "leases",
                "transition",
                "operation",
            }
            or state["version"] != 1
            or type(state["version"]) is not int
            or state["targetHash"] != self.target.digest
        ):
            raise Unavailable("state_invalid")
        if state["phase"] not in (
            "running",
            "draining",
            "stopping",
            "stopped",
            "starting",
        ):
            raise Unavailable("state_invalid")
        last = state["lastActivity"]
        if type(last) is not int or not 0 <= last <= now + 5:
            raise Unavailable("telemetry_missing")
        leases = state["leases"]
        if not isinstance(leases, dict) or len(leases) > 128:
            raise Unavailable("telemetry_missing")
        for request, lease in leases.items():
            if (
                not valid_uuid(request)
                or not isinstance(lease, dict)
                or set(lease) != {"tokenHash", "expiresAt"}
                or not isinstance(lease["tokenHash"], str)
                or not re.fullmatch(r"[a-f0-9]{64}", lease["tokenHash"])
                or type(lease["expiresAt"]) is not int
                or not 0 <= lease["expiresAt"] <= now + self.target.lease_seconds + 5
            ):
                raise Unavailable("telemetry_missing")
        if state["phase"] != "running" and leases:
            raise Unavailable("state_invalid")
        if state["phase"] in ("running", "stopped"):
            if state["transition"] is not None or state["operation"] is not None:
                raise Unavailable("state_invalid")
        elif not valid_uuid(state["transition"]):
            raise Unavailable("state_invalid")
        operation = state["operation"]
        if operation is not None and (
            not isinstance(operation, str)
            or not re.fullmatch(r"[a-zA-Z0-9_-]{1,128}", operation)
        ):
            raise Unavailable("state_invalid")
        if not isinstance(generation, str) or not re.fullmatch(
            r"[1-9][0-9]{0,29}", generation
        ):
            raise Unavailable("state_invalid")
        return generation, cast(State, state)

    def _runnable(self) -> bool:
        current = self.cloud.instance()
        return (
            current.get("state") == "RUNNABLE"
            and current.get("activationPolicy") == "ALWAYS"
        )

    def _reconcile(self, generation: str, state: State) -> bool:
        phase, operation = state["phase"], state["operation"]
        if phase not in ("starting", "stopping") or not isinstance(operation, str):
            return False
        if not self.cloud.operation_done(operation):
            return False
        current = self.cloud.instance()
        policy = "ALWAYS" if phase == "starting" else "NEVER"
        if (
            current.get("state") != "RUNNABLE"
            or current.get("activationPolicy") != policy
        ):
            return False
        next_state = copy.deepcopy(state)
        next_state.update(
            {
                "phase": "running" if phase == "starting" else "stopped",
                "transition": None,
                "operation": None,
                "lastActivity": int(self.clock()),
            }
        )
        self.store.write(generation, next_state)
        return True

    def _transition(
        self, generation: str, state: State, phase: str, policy: str
    ) -> Reply:
        transition = str(UUID(bytes=secrets.token_bytes(16), version=4))
        next_state = copy.deepcopy(state)
        next_state.update({"phase": phase, "transition": transition, "operation": None})
        self.store.write(generation, next_state)
        # Once intent is durable, never repeat an uncertain PATCH. Missing
        # operation proof keeps admissions/stops closed for explicit reconciliation.
        operation = self.cloud.activate(policy)
        for _ in range(8):
            revision, current = self._read()
            if current["transition"] != transition or current["phase"] != phase:
                raise Unavailable("operation_record_uncertain")
            current["operation"] = operation
            current["phase"] = "stopping" if phase == "draining" else phase
            try:
                self.store.write(revision, current)
                return unavailable("stopping" if phase == "draining" else "starting")
            except Conflict:
                continue
        raise Unavailable("operation_record_uncertain")

    @staticmethod
    def _lease_body(body: dict[str, object]) -> tuple[str, str]:
        if set(body) != {"requestId", "leaseToken"}:
            raise ValueError("invalid_request")
        request, token = body["requestId"], body["leaseToken"]
        if (
            not valid_uuid(request)
            or not isinstance(token, str)
            or not re.fullmatch(r"[a-f0-9]{64}", token)
        ):
            raise ValueError("invalid_request")
        return cast(str, request), hashlib.sha256(token.encode()).hexdigest()

    def _admitted(self, request: str, expires: int) -> Reply:
        if expires - int(self.clock()) < self.target.request_seconds:
            return unavailable("lease_expired")
        return Reply(
            200,
            {
                "status": "admitted",
                "requestId": request,
                "expiresAt": expires,
                "requestMaxSeconds": self.target.request_seconds,
            },
        )

    def handle(self, path: str, body: dict[str, object]) -> Reply:
        try:
            if path in ("/gate/acquire", "/gate/release"):
                request, token_hash = self._lease_body(body)
            elif path == "/idle/check" and body == {}:
                request, token_hash = "", ""
            else:
                return Reply(400, {"status": "invalid_request", "saved": False})
            for _ in range(8):
                generation, state = self._read()
                now = int(self.clock())
                phase = state["phase"]
                leases = state["leases"]
                if not isinstance(leases, dict):
                    return unavailable("gate_unavailable")
                try:
                    if path == "/gate/release":
                        lease = leases.get(request)
                        if not isinstance(lease, dict):
                            return Reply(
                                404, {"status": "lease_not_found", "saved": False}
                            )
                        if lease["tokenHash"] != token_hash:
                            return Reply(
                                409, {"status": "lease_mismatch", "saved": False}
                            )
                        del leases[request]
                        state["lastActivity"] = now
                        self.store.write(generation, state)
                        return Reply(200, {"status": "released"})
                    if self._reconcile(generation, state):
                        continue
                    if path == "/gate/acquire":
                        if phase == "stopped":
                            return self._transition(
                                generation, state, "starting", "ALWAYS"
                            )
                        if phase != "running":
                            return unavailable(str(phase))
                        if not self._runnable():
                            return unavailable("database_unavailable")
                        existing = leases.get(request)
                        if isinstance(existing, dict):
                            if existing["tokenHash"] != token_hash:
                                return Reply(
                                    409, {"status": "lease_mismatch", "saved": False}
                                )
                            if existing["expiresAt"] <= now:
                                return unavailable("lease_expired")
                            return self._admitted(request, existing["expiresAt"])
                        if len(leases) >= 128:
                            return unavailable("gate_capacity")
                        leases[request] = {
                            "tokenHash": token_hash,
                            "expiresAt": now + self.target.lease_seconds,
                        }
                        state["lastActivity"] = now
                        self.store.write(generation, state)
                        return self._admitted(request, now + self.target.lease_seconds)
                    if phase != "running":
                        return unavailable(str(phase))
                    if leases:
                        # Expired leases are missing completion telemetry, NOT
                        # proof that the request/SQL work stopped. Never prune.
                        return unavailable("in_flight_or_completion_unknown")
                    if now - state["lastActivity"] < self.target.idle_seconds:
                        return Reply(200, {"status": "active"})
                    if not self._runnable():
                        return unavailable("database_unavailable")
                    return self._transition(generation, state, "draining", "NEVER")
                except Conflict:
                    continue
            return unavailable("cas_contention")
        except ValueError:
            return Reply(400, {"status": "invalid_request", "saved": False})
        except (Unavailable, OSError, TimeoutError):
            return unavailable("gate_unavailable")
