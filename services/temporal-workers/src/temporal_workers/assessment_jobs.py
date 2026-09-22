"""Versioned opaque assessment scheduling with confirmation-only recovery."""

from datetime import timedelta

from temporalio import workflow
from temporalio.common import RetryPolicy, WorkflowIDReusePolicy
from temporalio.exceptions import (
    ActivityError,
    ApplicationError,
    CancelledError,
    WorkflowAlreadyStartedError,
)

with workflow.unsafe.imports_passed_through():
    from pydantic import ValidationError
    from temporalio.client import Client

    from .assessment_contracts import JobReference, validated_result

WORKFLOW_TYPE = "axiom.assessment.job.v1"
TASK_QUEUE = "axiom-assessment-v1"


@workflow.defn(name=WORKFLOW_TYPE)
class AssessmentJobWorkflow:
    def __init__(self):
        self._stage = "validating"

    @workflow.query
    def status(self) -> str:
        return self._stage

    @workflow.run
    async def run(self, reference: dict) -> dict:
        job = None
        try:
            job = JobReference.model_validate(reference)
        except ValidationError:
            pass
        if job is None:
            raise ApplicationError(
                "invalid_assessment_reference",
                type="invalid_assessment_reference",
                non_retryable=True,
            )
        safe = job.model_dump(mode="json")
        result = {**safe, "status": "unconfirmed", "cleanupConfirmed": None}
        # One launch attempt. A lost response or timeout never retries it.
        for operation, delay in (
            ("run", 0),
            ("reconcile", 5),
            ("reconcile", 15),
            ("reconcile", 30),
        ):
            self._stage = operation
            if delay:
                await workflow.sleep(delay)
            try:
                received = await workflow.execute_activity(
                    "assessment_controller_v1",
                    args=[safe, operation],
                    start_to_close_timeout=timedelta(seconds=90),
                    schedule_to_close_timeout=timedelta(seconds=100),
                    retry_policy=RetryPolicy(maximum_attempts=1),
                )
                current = validated_result(received, job)
                if (
                    result.get("runId")
                    and current.get("runId")
                    and result["runId"] != current["runId"]
                ):
                    raise ValueError("Controller run binding changed")
                if current["cleanupConfirmed"] is None:
                    current["cleanupConfirmed"] = result["cleanupConfirmed"]
                result = current
                if result["status"] == "confirmed":
                    self._stage = "confirmed"
                    return result
            except ActivityError as error:
                if isinstance(error.cause, CancelledError):
                    raise CancelledError()
            except (ValidationError, ValueError):
                pass
        self._stage = "unconfirmed"
        return result


async def start_assessment_job(client: Client, tenant_id: str, job_id: str):
    """Trusted producer validates before Temporal serializes any argument.

    Namespace write ACLs must permit this producer only; workflow validation
    cannot erase arbitrary input already submitted to its history. Stable IDs
    refuse execution reuse, including after completion or cancellation.
    """
    job = None
    try:
        job = JobReference(tenantId=tenant_id, jobId=job_id)
    except ValidationError:
        pass
    if job is None:
        raise ValueError("Invalid assessment reference")
    workflow_id = f"assessment-{job.tenantId}-{job.jobId}"
    try:
        return await client.start_workflow(
            AssessmentJobWorkflow.run,
            job.model_dump(mode="json"),
            id=workflow_id,
            task_queue=TASK_QUEUE,
            execution_timeout=timedelta(minutes=10),
            id_reuse_policy=WorkflowIDReusePolicy.REJECT_DUPLICATE,
            retry_policy=RetryPolicy(maximum_attempts=1),
            rpc_timeout=timedelta(seconds=15),
        )
    except WorkflowAlreadyStartedError:
        return await find_assessment_job(client, tenant_id, job_id)


async def find_assessment_job(client: Client, tenant_id: str, job_id: str):
    """Lookup only: expired authority must never start replacement work."""
    job = JobReference(tenantId=tenant_id, jobId=job_id)
    handle = client.get_workflow_handle(f"assessment-{job.tenantId}-{job.jobId}")
    description = await handle.describe(rpc_timeout=timedelta(seconds=15))
    if (
        description.workflow_type != WORKFLOW_TYPE
        or description.task_queue != TASK_QUEUE
    ):
        raise ValueError("Assessment workflow binding refused")
    # Pin later reads to the execution that was actually observed.
    return client.get_workflow_handle(handle.id, run_id=description.run_id)
