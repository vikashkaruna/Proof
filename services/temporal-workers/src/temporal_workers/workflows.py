"""Axiom Proof — Compliance engagement workflow.

The single end-to-end workflow that drives an engagement from
discovery to closure. Per Doc 04 §5.1, this is the Workflow/State
Engine: a durable state machine that survives restarts and
human-approval waits.

The workflow is intentionally simple. It is a sequence of activity
calls; each activity is an HTTP call into the agent runtime. The
activities themselves are NOT long-running — the agent runtime
returns a job ID and we poll (or use Temporal signals) for
completion. The novelty of Temporal here is the durable state, not
the per-activity parallelism.
"""

from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Any

from temporalio import activity, workflow
from temporalio.common import RetryPolicy

from .config import get_settings


# ─── Activities — thin wrappers around agent-runtime HTTP calls ──────


@activity.defn
async def call_agent_runtime(
    agent: str,
    input: dict[str, Any],
    correlation_id: str,
) -> dict[str, Any]:
    """Call an agent via the agent runtime's HTTP API.

    SEC-11: the auth header here was the literal string
    "{{AGENT_RUNTIME_INTERNAL_TOKEN}}" — a template that nothing ever
    substituted — and the cluster URL was hardcoded. Both now come from
    settings, which refuses to start a deployed worker without a real token.
    """
    import httpx

    settings = get_settings()

    async with httpx.AsyncClient(timeout=60.0) as client:
        r = await client.post(
            f"{settings.agent_runtime_url}/agents/{agent}/invoke",
            json={"correlation_id": correlation_id, "input": input},
            headers=settings.internal_headers,
        )
        r.raise_for_status()
        return r.json()


@activity.defn
async def persist_finding(
    tenant_id: str,
    engagement_id: str,
    finding: dict[str, Any],
) -> str:
    """Persist a finding to Supabase. Returns the finding ID."""
    import httpx

    settings = get_settings()

    async with httpx.AsyncClient(timeout=30.0) as client:
        # This call carried no credential at all. /internal endpoints are not
        # public, and network position is not authentication.
        r = await client.post(
            f"{settings.agent_runtime_url}/internal/persist-finding",
            json={"tenant_id": tenant_id, "engagement_id": engagement_id, "finding": finding},
            headers=settings.internal_headers,
        )
        r.raise_for_status()
        return r.json()["id"]


@activity.defn
async def wait_for_human_approval(
    plan_id: str,
    correlation_id: str,
    timeout_hours: int = 24,
) -> dict[str, Any]:
    """Block until a human approves the plan. Implements the per-Doc
    04 §5.1 "survive a human taking days to approve" requirement.

    In production this uses Temporal signals. For Phase 0/1 we poll
    the DB at the configured cadence.
    """
    import asyncio

    import httpx

    settings = get_settings()

    deadline_seconds = timeout_hours * 3600
    poll_interval = 30
    elapsed = 0
    async with httpx.AsyncClient(timeout=15.0) as client:
        while elapsed < deadline_seconds:
            # Likewise unauthenticated before W0.0. Plan status discloses
            # whether an approval token exists for a plan.
            r = await client.get(
                f"{settings.agent_runtime_url}/internal/plan-status/{plan_id}",
                headers=settings.internal_headers,
            )
            if r.status_code == 200:
                status = r.json()
                if status.get("approval_token_id"):
                    return status
            await asyncio.sleep(poll_interval)
            elapsed += poll_interval
    raise TimeoutError(f"Approval timeout for plan {plan_id} after {timeout_hours}h")


# ─── The workflow itself ────────────────────────────────────────────


@workflow.defn(name="axiom.compliance.engagement")
class ComplianceEngagementWorkflow:
    """The end-to-end engagement workflow.

    Inputs (start):
      tenant_id, engagement_id, library_version, findings (list)

    State machine: discovery → classification → assessment →
    evidence → planning → dry-run → approval → execution →
    verification → closure.

    Survives: workflow restarts, multi-day approval waits, partial
    failures. Each phase emits to the audit ledger via the agent
    runtime.
    """

    def __init__(self) -> None:
        self._state: dict[str, Any] = {}
        self._approver_id: str | None = None
        self._approval_token_id: str | None = None

    @workflow.run
    async def run(self, input: dict[str, Any]) -> dict[str, Any]:
        correlation_id = input.get("correlation_id") or str(uuid.uuid4())
        tenant_id = input["tenant_id"]
        engagement_id = input["engagement_id"]

        retry = RetryPolicy(
            initial_interval=timedelta(seconds=2),
            maximum_interval=timedelta(minutes=1),
            maximum_attempts=3,
        )

        # 1) Discovery
        discovery = await workflow.execute_activity(
            call_agent_runtime,
            args={
                "agent": "drishti",
                "input": {
                    "tenant_id": tenant_id,
                    "engagement_id": engagement_id,
                    "interview": input.get("interview", {}),
                    "systems": input.get("systems", []),
                },
                "correlation_id": correlation_id,
            },
            start_to_close_timeout=timedelta(minutes=5),
            retry_policy=retry,
        )
        self._state["discovery"] = discovery

        # 2) Classification
        classification = await workflow.execute_activity(
            call_agent_runtime,
            args={
                "agent": "vibhaag",
                "input": {
                    "tenant_id": tenant_id,
                    "engagement_id": engagement_id,
                    "inventory": discovery.get("output", {}).get("inventory", []),
                },
                "correlation_id": correlation_id,
            },
            start_to_close_timeout=timedelta(minutes=5),
            retry_policy=retry,
        )
        self._state["classification"] = classification

        # 3) Assessment
        assessment = await workflow.execute_activity(
            call_agent_runtime,
            args={
                "agent": "parikshan",
                "input": {
                    "tenant_id": tenant_id,
                    "engagement_id": engagement_id,
                    "library_version": input.get("library_version", "0.1.0"),
                    "answers": input.get("answers", {}),
                },
                "correlation_id": correlation_id,
            },
            start_to_close_timeout=timedelta(minutes=10),
            retry_policy=retry,
        )
        self._state["assessment"] = assessment

        # 4) Plan generation (Sudhaar)
        plan = await workflow.execute_activity(
            call_agent_runtime,
            args={
                "agent": "sudhaar",
                "input": {
                    "tenant_id": tenant_id,
                    "engagement_id": engagement_id,
                    "title": f"Plan for engagement {engagement_id}",
                    "findings": assessment.get("output", {}).get("findings", []),
                },
                "correlation_id": correlation_id,
            },
            start_to_close_timeout=timedelta(minutes=5),
            retry_policy=retry,
        )
        self._state["plan"] = plan

        # 5) Wait for human approval
        # In production: the workflow sends a signal; the approver
        # hits the BFF; the BFF issues the token; the BFF signals
        # the workflow. For Phase 0/1, we poll.
        try:
            approved = await workflow.execute_activity(
                wait_for_human_approval,
                args={
                    "plan_id": plan.get("output", {}).get("plan_id"),
                    "correlation_id": correlation_id,
                    "timeout_hours": 24,
                },
                start_to_close_timeout=timedelta(hours=24),
                retry_policy=retry,
            )
            self._state["approval"] = approved
        except TimeoutError as e:
            workflow.logger.error("approval timeout", error=str(e))
            return {"status": "approval_timeout", "correlation_id": correlation_id, "state": self._state}

        # 6) Execution (Karya) — Phase 3+
        # In Phase 0/1 this is the BFF's internal/execute endpoint
        # which currently just records the intent.
        # 7) Verification — Phase 3+

        return {
            "status": "completed",
            "correlation_id": correlation_id,
            "posture_score": (assessment.get("output") or {}).get("posture_score"),
            "estimated_exposure_inr": (assessment.get("output") or {}).get("estimated_exposure_inr"),
            "state": {
                "discovery": "completed",
                "classification": "completed",
                "assessment": "completed",
                "plan": "completed",
                "approval": "received",
            },
        }
