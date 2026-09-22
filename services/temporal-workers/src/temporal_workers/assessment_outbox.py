"""Bounded durable outbox producer. No database or task credentials live here."""

import asyncio
from datetime import UTC, datetime, timedelta
from uuid import UUID

from pydantic import AwareDatetime, Field
from temporalio.client import Client

from .assessment_activity import PrivateAssessmentController
from .assessment_contracts import JobReference
from .assessment_jobs import (
    TASK_QUEUE,
    WORKFLOW_TYPE,
    find_assessment_job,
    start_assessment_job,
)


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


class AssessmentOutboxPump:
    def __init__(self, client: Client, controller: PrivateAssessmentController):
        self.client = client
        self.controller = controller

    async def tick(self) -> dict[str, int]:
        """Uncertainty keeps its lease; SQL caps retries and records review.

        Stable workflow IDs + REJECT_DUPLICATE close the commit/submission
        crash window. A lease is scheduling metadata, never execution authority.
        """
        counts = {"reserved": 0, "acknowledged": 0, "unconfirmed": 0}
        try:
            polled = await self.controller.request("scheduling/poll", {})
            if (
                not isinstance(polled, dict)
                or set(polled) != {"jobs"}
                or not isinstance(polled["jobs"], list)
                or len(polled["jobs"]) > 1
            ):
                raise ValueError("Invalid poll receipt")
            for raw in polled["jobs"]:
                ticket = ScheduleTicket.model_validate(raw)
                if (
                    ticket.namespace != self.client.namespace
                    or ticket.workflowId
                    != f"assessment-{ticket.tenantId}-{ticket.jobId}"
                    or ticket.leaseUntil <= datetime.now(UTC)
                ):
                    raise ValueError("Scheduling binding refused")
                counts["reserved"] += 1
                # Re-evaluate the deadline at submission, not just at poll time.
                action = (
                    start_assessment_job
                    if ticket.startBefore and ticket.startBefore > datetime.now(UTC)
                    else find_assessment_job
                )
                handle = await action(
                    self.client, str(ticket.tenantId), str(ticket.jobId)
                )
                description = await handle.describe(rpc_timeout=timedelta(seconds=15))
                if (
                    handle.id != ticket.workflowId
                    or description.workflow_type != WORKFLOW_TYPE
                    or description.task_queue != TASK_QUEUE
                ):
                    raise ValueError("Workflow receipt refused")
                expected = ScheduleExecution(
                    **ticket.model_dump(
                        exclude={"leaseId", "leaseUntil", "startBefore"}
                    ),
                    workflowRunId=description.run_id,
                ).model_dump(mode="json")
                receipt = ScheduleReceipt.model_validate(
                    await self.controller.request(
                        "scheduling/ack", {**expected, "leaseId": str(ticket.leaseId)}
                    )
                )
                if receipt.model_dump(mode="json", exclude={"receipt"}) != expected:
                    raise ValueError("Acknowledgement binding refused")
                counts["acknowledged"] += 1
        except Exception:  # noqa: BLE001 — no transport, private response or SDK cause is logged.
            counts["unconfirmed"] += 1
        return counts

    async def run(self) -> None:
        while True:
            await self.tick()
            await asyncio.sleep(5)
