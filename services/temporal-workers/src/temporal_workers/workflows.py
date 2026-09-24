"""Versioned engagement computation frontier.

This workflow stops at a truthful plan-persistence/review handoff. It does not
claim approval, execution, verification, persisted assessment or compliance
closure from legacy runtime output. Private workload orchestration remains the
next integration; proofs/SVIDs must never be placed in Temporal arguments.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from pydantic import ValidationError
from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError, ApplicationError, CancelledError

with workflow.unsafe.imports_passed_through():
    from .activities import call_agent_runtime
    from .contracts import (
        EngagementInput,
        ProtocolRefused,
        validate_result,
        validated_output,
    )

WORKFLOW_TYPE = "axiom.compliance.engagement.v2"
TASK_QUEUE = "axiom-compliance-v2"


@workflow.defn(name=WORKFLOW_TYPE)
class ComplianceEngagementWorkflow:
    def __init__(self) -> None:
        self._state: dict[str, str] = {}
        self._stage = "validating"

    @workflow.query
    def status(self) -> dict[str, Any]:
        return {"stage": self._stage, "stages": dict(self._state)}

    @workflow.run
    async def run(self, input: dict[str, Any]) -> dict[str, Any]:
        assigned = None
        try:
            assigned = EngagementInput.model_validate(input)
        except ValidationError:
            assigned = None
        if assigned is None:
            raise ApplicationError(
                "invalid_engagement_input",
                type="invalid_engagement_input",
                non_retryable=True,
            )
        correlation = str(assigned.correlation_id or workflow.uuid4())
        context = {
            "tenant_id": str(assigned.tenant_id),
            "engagement_id": str(assigned.engagement_id),
        }
        outputs: dict[str, dict[str, Any]] = {}
        # Legacy runtime dispatch has no durable idempotency handshake. A lost
        # response must be reconciled before any repeat; never retry it blindly.
        retry = RetryPolicy(maximum_attempts=1)
        for agent in ("drishti", "vibhaag", "parikshan", "sudhaar"):
            self._stage = agent
            if agent == "drishti":
                payload = {
                    **context,
                    "interview": assigned.interview,
                    "systems": assigned.systems,
                }
            elif agent == "vibhaag":
                payload = {**context, "inventory": outputs["drishti"]["inventory"]}
            elif agent == "parikshan":
                payload = {
                    **context,
                    "library_version": assigned.library_version,
                    "answers": assigned.answers,
                }
            else:
                payload = {
                    **context,
                    "title": f"Plan for engagement {assigned.engagement_id}",
                    "findings": outputs["parikshan"]["findings"],
                }
            failure = None
            try:
                value = await workflow.execute_activity(
                    call_agent_runtime,
                    args=[agent, payload, correlation],
                    start_to_close_timeout=timedelta(minutes=10),
                    retry_policy=retry,
                )
                result = validate_result(value, agent, correlation)
                output = validated_output(result, assigned.library_version)
            except ActivityError as exc:
                if isinstance(exc.cause, CancelledError):
                    raise CancelledError()
                failure = (
                    "agent_reported_failure"
                    if isinstance(exc.cause, ApplicationError)
                    and exc.cause.type == "agent_reported_failure"
                    else "agent_invocation_unconfirmed"
                )
            except ProtocolRefused as exc:
                failure = exc.code
            if failure:
                self._state[agent] = (
                    "failed" if failure == "agent_reported_failure" else "unconfirmed"
                )
                return {
                    "status": self._state[agent],
                    "stage": agent,
                    "code": failure,
                    "correlation_id": correlation,
                    "stages": dict(self._state),
                }
            self._state[agent] = "computed"
            outputs[agent] = output
            if output.get("escalate") is True or (
                agent == "drishti" and output["needs_live_connector"]
            ):
                self._stage = "review_required"
                return {
                    "status": "review_required",
                    "stage": agent,
                    "code": "live_connector_required"
                    if agent == "drishti" and output["needs_live_connector"]
                    else "agent_escalated",
                    "correlation_id": correlation,
                    "stages": dict(self._state),
                }
        # Sudhaar returns a proposal, not a stored plan ID. Do not poll a missing
        # endpoint with None, invent an approval or label future phases complete.
        self._stage = "plan_persistence_required"
        return {
            "status": "plan_persistence_required",
            "correlation_id": correlation,
            "stages": dict(self._state),
            "assessment": outputs["parikshan"],
            "proposal": outputs["sudhaar"],
        }
