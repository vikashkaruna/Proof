"""Real Temporal -> private socket -> BFF/isolated-worker acceptance subprobe.

Only opaque IDs and a local socket path enter this process. stdout contains
allowlisted boolean outcomes; never print raw exceptions, results or histories.
"""

import asyncio
import json
import sys

from temporal_workers.assessment_activity import AssessmentControllerActivity
from temporal_workers.assessment_contracts import JobReference
from temporal_workers.assessment_jobs import (
    TASK_QUEUE,
    AssessmentJobWorkflow,
    start_assessment_job,
)
from temporalio import activity
from temporalio.exceptions import ApplicationError
from temporalio.runtime import LoggingConfig, Runtime, TelemetryConfig
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Replayer, Worker

stage = "setup"


async def main():
    global stage
    # Native SDK logging otherwise writes warning text into this strict JSON pipe.
    Runtime.set_default(
        Runtime(telemetry=TelemetryConfig(logging=LoggingConfig(filter="off")))
    )
    assignment = json.load(sys.stdin)
    if (
        set(assignment) != {"socketPath", "controllerUid", "jobs"}
        or len(assignment["jobs"]) != 2
    ):
        raise ValueError("Invalid acceptance assignment")
    jobs = [JobReference.model_validate(job) for job in assignment["jobs"]]
    actual = AssessmentControllerActivity(
        assignment["socketPath"], assignment["controllerUid"]
    )
    calls = []
    lost_job = jobs[1].jobId

    @activity.defn(name="assessment_controller_v1")
    async def invoke(job: dict, operation: str) -> dict:
        calls.append((job["jobId"], operation))
        result = await actual.invoke(job, operation)
        if job["jobId"] == str(lost_job) and operation == "run":
            raise ApplicationError(
                "assessment_unconfirmed",
                type="assessment_unconfirmed",
                non_retryable=True,
            )
        return result

    async with (
        await WorkflowEnvironment.start_time_skipping() as env,
        Worker(
            env.client,
            task_queue=TASK_QUEUE,
            workflows=[AssessmentJobWorkflow],
            activities=[invoke],
        ),
    ):
        for job in jobs:
            stage = "schedule"
            handle = await start_assessment_job(
                env.client, str(job.tenantId), str(job.jobId)
            )
            stage = "result"
            result = await asyncio.wait_for(handle.result(), 120)
            stage = "confirmation"
            if result["status"] != "confirmed":
                raise ValueError("Assessment was not confirmed")
            stage = "duplicate"
            again = await start_assessment_job(
                env.client, str(job.tenantId), str(job.jobId)
            )
            if again.id != handle.id or await again.result() != result:
                raise ValueError("Workflow reuse changed execution")
            stage = "history"
            history = await handle.fetch_history()
            for event in history.events:
                # Inspect actual encoded payload bytes in protobuf as well as
                # typed scheduled inputs; never save the history itself.
                raw = event.SerializeToString()
                if any(
                    marker in raw
                    for marker in (
                        b"taskProof",
                        b"workloadProof",
                        b"answers",
                        b"key_ref",
                        b"controller.sock",
                    )
                ):
                    raise ValueError("Private workflow payload")
                if event.HasField("activity_task_scheduled_event_attributes"):
                    args = event.activity_task_scheduled_event_attributes.input.payloads
                    if (
                        len(args) != 2
                        or json.loads(args[0].data) != job.model_dump(mode="json")
                        or json.loads(args[1].data) not in ("run", "reconcile")
                    ):
                        raise ValueError("Unexpected activity input")
            await Replayer(workflows=[AssessmentJobWorkflow]).replay_workflow(history)
    stage = "calls"
    if calls != [
        (str(jobs[0].jobId), "run"),
        (str(jobs[1].jobId), "run"),
        (str(jobs[1].jobId), "reconcile"),
    ]:
        raise ValueError("Unexpected launch retry")
    return {
        "temporal-private-controller-real-worker-confirmed": True,
        "temporal-lost-reply-reconciles-without-relaunch": True,
        "temporal-history-contains-only-opaque-job-metadata": True,
    }


if __name__ == "__main__":
    try:
        result = asyncio.run(main())
        print(json.dumps(result))
    except Exception:  # noqa: BLE001 — private acceptance errors never leave the probe.
        print(json.dumps({"failedPhase": stage}))
        sys.exit(1)
