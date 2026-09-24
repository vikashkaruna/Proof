"""Private Unix-socket controller activity; no task payload enters history."""

import asyncio
import json
import stat
from pathlib import Path
from typing import Protocol

import httpx
from temporalio import activity
from temporalio.exceptions import ApplicationError

from .assessment_contracts import JobReference, transport_payload, validated_result


class AssessmentTransport(Protocol):
    async def request(self, operation: str, payload: dict): ...


class PrivateAssessmentController:
    """Socket path is local worker configuration, never a workflow argument.

    Only the provisioned controller/scheduler OS group can traverse/connect to
    this Unix socket. No TCP/proxy/redirect fallback or shared bearer secret.
    """

    def __init__(self, socket_path: str, controller_uid: int):
        if (
            not socket_path
            or not Path(socket_path).is_absolute()
            or len(socket_path.encode()) > 100
        ):
            raise ValueError("Private assessment controller unavailable")
        if type(controller_uid) is not int or not 0 <= controller_uid <= 2147483647:
            raise ValueError("Private assessment controller unavailable")
        self.socket_path = socket_path
        self.controller_uid = controller_uid

    def validate_socket(self):
        path = Path(self.socket_path)
        if str(path.resolve(strict=True)) != self.socket_path:
            raise ValueError("Private controller path refused")
        info, parent = path.lstat(), path.parent.lstat()
        if (
            not stat.S_ISSOCK(info.st_mode)
            or info.st_uid != self.controller_uid
            or stat.S_IMODE(info.st_mode) != 0o660
            or parent.st_uid != self.controller_uid
            or stat.S_IMODE(parent.st_mode) != 0o710
        ):
            raise ValueError("Private controller ownership refused")
        for ancestor in path.parent.parents:
            directory = ancestor.lstat()
            if (
                not stat.S_ISDIR(directory.st_mode)
                or directory.st_uid not in (0, self.controller_uid)
                or (
                    directory.st_mode & 0o022
                    and not (directory.st_uid == 0 and directory.st_mode & stat.S_ISVTX)
                )
            ):
                raise ValueError("Private controller ancestor refused")

    async def request(self, operation: str, payload: dict):
        result = None
        try:
            payload = transport_payload(operation, payload)
            if len(json.dumps(payload).encode()) > 1024:
                raise ValueError("Private operation refused")
            self.validate_socket()
            transport = httpx.AsyncHTTPTransport(uds=self.socket_path, retries=0)
            async with (
                asyncio.timeout(85),
                httpx.AsyncClient(
                    transport=transport,
                    timeout=84,
                    follow_redirects=False,
                    trust_env=False,
                ) as client,
                client.stream(
                    "POST", f"http://controller/assessment/{operation}", json=payload
                ) as response,
            ):
                if response.status_code != 200:
                    raise ValueError("Controller unavailable")
                body = bytearray()
                limit = 16384 if operation.startswith("scheduling/") else 4096
                async for chunk in response.aiter_bytes(chunk_size=4096):
                    if len(body) + len(chunk) > limit:
                        raise ValueError("Controller response oversized")
                    body.extend(chunk)
                result = json.loads(body)
        except Exception:  # noqa: BLE001 — no transport/validation detail crosses this boundary.
            result = None
        if result is None:
            raise ValueError("Private controller unavailable")
        return result


async def invoke_controller(
    transport: AssessmentTransport, reference: dict, operation: str
) -> dict:
    result = None
    try:
        job = JobReference.model_validate(reference)
        if operation not in {"run", "reconcile"}:
            raise ValueError("Controller operation refused")
        result = validated_result(
            await transport.request(operation, job.model_dump(mode="json")), job
        )
    except Exception:  # noqa: BLE001 — sanitize every failure before Temporal history.
        result = None
    if result is None:
        raise ApplicationError(
            "assessment_unconfirmed",
            type="assessment_unconfirmed",
            non_retryable=True,
        )
    return result


class AssessmentControllerActivity(PrivateAssessmentController):
    @activity.defn(name="assessment_controller_v1")
    async def invoke(self, reference: dict, operation: str) -> dict:
        return await invoke_controller(self, reference, operation)
