"""Only opaque job and receipt metadata may cross the scheduling boundary."""

from typing import Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field


class JobReference(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)
    tenantId: UUID
    jobId: UUID


class ControllerResult(JobReference):
    status: Literal["confirmed", "unconfirmed"]
    runId: UUID | None = None
    receipt: str | None = Field(default=None, pattern=r"^[1-9][0-9]*$", max_length=30)
    resultDigest: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    cleanupConfirmed: bool | None = Field(strict=True)


def validated_result(value: object, reference: JobReference) -> dict:
    result = ControllerResult.model_validate(value)
    if result.tenantId != reference.tenantId or result.jobId != reference.jobId:
        raise ValueError("Controller binding refused")
    if result.status == "confirmed":
        if not result.runId or not result.receipt or not result.resultDigest:
            raise ValueError("Controller confirmation incomplete")
    elif result.receipt is not None or result.resultDigest is not None:
        raise ValueError("Controller confirmation contradictory")
    return result.model_dump(mode="json", exclude_none=True) | {
        "cleanupConfirmed": result.cleanupConfirmed
    }


class ScheduleBinding(JobReference):
    namespace: str = Field(pattern=r"^[a-zA-Z0-9][a-zA-Z0-9_.-]*$", max_length=255)
    workflowId: str = Field(pattern=r"^assessment-[a-f0-9-]{36}-[a-f0-9-]{36}$")


class ScheduleTicket(ScheduleBinding):
    leaseId: UUID
    leaseUntil: AwareDatetime
    startBefore: AwareDatetime | None


class ScheduleExecution(ScheduleBinding):
    workflowRunId: UUID


class ScheduleReceipt(ScheduleExecution):
    receipt: str = Field(pattern=r"^[1-9][0-9]*$", max_length=30)


class ScheduleAcknowledgement(ScheduleExecution):
    leaseId: UUID


def transport_payload(operation: str, payload: dict) -> dict:
    """Reject private/unknown fields before any socket or HTTPS transmission."""
    if operation in {"run", "reconcile"}:
        return JobReference.model_validate(payload).model_dump(mode="json")
    if operation == "scheduling/poll" and type(payload) is dict and not payload:
        return {}
    if operation == "scheduling/ack":
        value = ScheduleAcknowledgement.model_validate(payload)
        if value.workflowId != f"assessment-{value.tenantId}-{value.jobId}":
            raise ValueError("Scheduling binding refused")
        return value.model_dump(mode="json")
    raise ValueError("Private operation refused")
