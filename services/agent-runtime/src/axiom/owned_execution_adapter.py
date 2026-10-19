"""Singleton execution seam to a separate credentialless Karya controller.

The BFF owns target RPC authority and independently verifies Karya identity and
signed accepted-batch scope. No SQL, endpoint, target identity or credential is
accepted in action parameters. Existing executor settlement remains authoritative.
"""

from __future__ import annotations

import asyncio
import json
import re
import stat
from copy import deepcopy
from pathlib import Path
from typing import Any, Protocol
from uuid import UUID

import httpx

from .write_adapters import WriteRefused, WriteResult


class OwnedExecutionPort(Protocol):
    async def call(self, request: dict[str, Any]) -> object: ...


class OwnedSocketPort:
    def __init__(self, path: str):
        if not path.startswith("/") or str(Path(path)) != path or ".." in Path(path).parts:
            raise WriteRefused("owned_controller_configuration_refused")
        self.path = Path(path)

    def validate(self) -> None:
        if self.path.resolve() != self.path:
            raise WriteRefused("owned_controller_identity_refused")
        info = self.path.lstat()
        if (
            not stat.S_ISSOCK(info.st_mode)
            or info.st_uid != 20106
            or info.st_gid != 20113
            or stat.S_IMODE(info.st_mode) != 0o660
        ):
            raise WriteRefused("owned_controller_identity_refused")
        directory = self.path.parent.stat()
        if (
            directory.st_uid != 20106
            or directory.st_gid != 20113
            or stat.S_IMODE(directory.st_mode) != 0o750
        ):
            raise WriteRefused("owned_controller_identity_refused")
        for parent in self.path.parents:
            value = parent.lstat()
            if (
                not stat.S_ISDIR(value.st_mode)
                or value.st_uid not in (0, 20106)
                or (
                    value.st_mode & 0o022
                    and not (value.st_uid == 0 and value.st_mode & stat.S_ISVTX)
                )
            ):
                raise WriteRefused("owned_controller_identity_refused")

    async def call(self, request: dict[str, Any]) -> object:
        try:
            self.validate()
            async with asyncio.timeout(50):
                async with (
                    httpx.AsyncClient(
                        transport=httpx.AsyncHTTPTransport(uds=str(self.path)),
                        trust_env=False,
                        follow_redirects=False,
                        timeout=50,
                    ) as client,
                    client.stream(
                        "POST", "http://owned-controller/owned-execution/run", json=request
                    ) as response,
                ):
                    if (
                        response.status_code != 200
                        or response.headers.get("content-type") != "application/json"
                        or response.headers.get("content-encoding")
                    ):
                        raise ValueError()
                    body = bytearray()
                    async for chunk in response.aiter_raw():
                        body.extend(chunk)
                        if len(body) > 16384:
                            raise ValueError()
                    value = json.loads(body)
                    if not isinstance(value, dict) or set(value) != {"data"}:
                        raise ValueError()
                    return value["data"]
        except Exception:
            raise WriteRefused("owned_controller_unconfirmed") from None


class OwnedExecutionAdapter:
    def __init__(self, payload: Any, row: dict[str, Any], port: OwnedExecutionPort):
        ids = payload.action_ids
        token = payload.approval_token
        spec = token.get("spec", {}) if isinstance(token, dict) else {}
        if not isinstance(spec, dict):
            raise WriteRefused("owned_singleton_scope_refused")
        if (
            not isinstance(ids, list)
            or len(ids) != 1
            or spec.get("actionIds") != ids
            or spec.get("planId") != payload.plan_id
            or spec.get("contentDigest") != payload.content_digest
            or type(spec.get("concurrency")) is not int
            or spec.get("concurrency") != 1
            or payload.concurrency != 1
            or row.get("id") != ids[0]
            or row.get("plan_id") != payload.plan_id
            or row.get("action_type") != "config.audit_log_enable"
            or row.get("parameters") != {"enabled": True}
            or row.get("parameters", {}).get("enabled") is not True
        ):
            raise WriteRefused("owned_singleton_scope_refused")
        for value in (payload.tenant_id, payload.plan_id, ids[0]):
            if (
                not isinstance(value, str)
                or not re.fullmatch(
                    r"[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}",
                    value,
                )
                or str(UUID(value)) != value
            ):
                raise WriteRefused("owned_singleton_scope_refused")
        rollback = row.get("rollback_definition")
        if (
            not isinstance(rollback, dict)
            or set(rollback) != {"enabled", "snapshot_sha256"}
            or rollback["enabled"] is not False
            or not isinstance(rollback["snapshot_sha256"], str)
            or not re.fullmatch("[a-f0-9]{64}", rollback["snapshot_sha256"])
        ):
            raise WriteRefused("owned_rollback_definition_refused")
        self._request = {
            "tenantId": payload.tenant_id,
            "planId": payload.plan_id,
            "actionId": ids[0],
            "requestKey": payload.request_key,
            "token": deepcopy(token),
        }
        self._rollback = dict(rollback)
        self._port = port

    async def _call(self, operation: str) -> object:
        try:
            return await self._port.call({**self._request, "operation": operation})
        except Exception:
            raise WriteRefused("owned_execution_unconfirmed") from None

    def _check(self, action_type: str, values: dict[str, Any], *, rollback: bool = False) -> None:
        if (
            not isinstance(values, dict)
            or type(values.get("enabled")) is not bool
            or action_type != "config.audit_log_enable"
            or values != (self._rollback if rollback else {"enabled": True})
        ):
            raise WriteRefused("owned_action_content_refused")

    async def _result(self, operation: str) -> WriteResult:
        raw = await self._call(operation)
        if (
            not isinstance(raw, dict)
            or set(raw) != {"rows_affected", "pre_state_ref", "post_state_ref"}
            or type(raw["rows_affected"]) is not int
            or raw["rows_affected"] != 1
            or any(
                not isinstance(raw[k], str)
                or not re.fullmatch("owned-synthetic/snapshot/[a-f0-9]{64}", raw[k])
                for k in ("pre_state_ref", "post_state_ref")
            )
        ):
            raise WriteRefused("owned_execution_response_refused")
        return WriteResult(**raw)

    async def execute(self, action_type: str, parameters: dict[str, Any]) -> WriteResult:
        self._check(action_type, parameters)
        return await self._result("forward")

    async def simulate_rollback(self, action_type: str, definition: dict[str, Any]) -> WriteResult:
        self._check(action_type, definition, rollback=True)
        return await self._result("simulate_rollback")

    async def execute_rollback(self, action_type: str, definition: dict[str, Any]) -> WriteResult:
        self._check(action_type, definition, rollback=True)
        return await self._result("rollback")

    async def verify(self, action_type: str, parameters: dict[str, Any]) -> list[dict[str, Any]]:
        self._check(action_type, parameters)
        raw = await self._call("verify")
        if (
            not isinstance(raw, dict)
            or set(raw) != {"checks"}
            or not isinstance(raw["checks"], list)
            or len(raw["checks"]) != 1
        ):
            raise WriteRefused("owned_verification_refused")
        check = raw["checks"][0]
        if (
            not isinstance(check, dict)
            or set(check) != {"check_id", "outcome", "detail"}
            or check["check_id"] != "owned.synthetic.audit_log_boolean"
            or check["outcome"] not in ("passed", "failed")
            or not isinstance(check["detail"], str)
            or len(check["detail"]) > 200
        ):
            raise WriteRefused("owned_verification_refused")
        return [dict(check)]
