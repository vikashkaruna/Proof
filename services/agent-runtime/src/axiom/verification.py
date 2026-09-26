"""W5 · M3.7 + W5.6 — post-execution verification and the maker-checker
reconciler.

Verification (M3.7): after a batch settles, Parikshan re-runs the checks
the remediation targeted for every action that actually executed, and
records whether the gap closed. Verification calls are kill-switch
guarded like any estate call: an operator halting an incident stops
verification too, and the actions' verification status simply stays
unset until it is run again.

Reconciliation (W5.6): after the batch finishes, an independent statement
is recorded — the third role that proves Sudhaar (maker) and Karya
(doer) agreed. The database computes the comparison itself from the
token row and the settled actions: out-of-scope execution is refused
(`out_of_scope_executed`), unexecuted actions are listed, and a content
digest recomputed at reconcile time is compared against the batch's
approved digest (drift is stated, not hidden). The statement is signed
with the approval signing key — the same key that bound the approval —
and the signature is verified for shape at the gate.
"""

from __future__ import annotations

import hashlib
import hmac
from typing import Any

import structlog

from .executor import ActionOutcome, ExecutorDb, ExecutorRefused
from .kill_switch import KillSwitchEngaged, KillSwitchReader
from .write_adapters import WriteAdapter, WriteRefused


async def verify_batch(
    db: ExecutorDb,
    kill_switch: KillSwitchReader,
    adapter: WriteAdapter,
    payload: Any,
    batch_id: str,
    outcomes: list[ActionOutcome],
    action_rows: dict[str, dict[str, Any]],
) -> None:
    """Verify every action that executed. Verification outcomes are
    recorded per action; they do not change what executed."""
    for outcome in outcomes:
        if outcome.outcome not in ("succeeded", "rolled_back"):
            continue
        try:
            kill_switch.raise_if_engaged(payload.tenant_id)
        except KillSwitchEngaged:
            structlog.get_logger().warning("verification.halted", action_id=outcome.action_id)
            return
        row = action_rows.get(outcome.action_id)
        if row is None:
            raise ExecutorRefused("record_unavailable")
        try:
            checks = await adapter.verify(row["action_type"], row.get("parameters") or {})
        except WriteRefused as refused:
            checks = [{"check_id": "verification_unavailable", "outcome": "failed",
                       "detail": refused.reason}]
        passed = all(c.get("outcome") == "passed" for c in checks) and len(checks) > 0
        recorded = db.rpc(
            "record_verification_result",
            {
                "p_tenant_id": payload.tenant_id,
                "p_action_id": outcome.action_id,
                "p_batch_id": batch_id,
                "p_checks": checks,
                "p_outcome": "passed" if passed else "failed",
                "p_evidence_uri": None,
                "p_correlation_id": payload.correlation_id,
            },
        )
        if "error" in recorded:
            raise ExecutorRefused(recorded["error"])


async def reconcile_batch(
    db: ExecutorDb,
    payload: Any,
    batch_id: str,
    batch_status: str,
    outcomes: list[ActionOutcome],
    signing_key: str | bytes,
) -> dict[str, Any]:
    """Record the maker-checker statement for a finished batch.

    The comparison is computed at the database from the token row and the
    settled actions; the statement here is the human-readable account of
    the same facts, signed with the approval signing key.
    """
    counts: dict[str, int] = {}
    for outcome in outcomes:
        counts[outcome.outcome] = counts.get(outcome.outcome, 0) + 1
    parts = [
        f"Batch {batch_id} (request {payload.request_key}) finished {batch_status}.",
        f"Approved {len(payload.action_ids)} action(s): "
        + ", ".join(f"{k}={v}" for k, v in sorted(counts.items())),
    ]
    unexecuted = counts.get("skipped", 0)
    if unexecuted:
        parts.append(
            f"{unexecuted} approved action(s) did not execute and returned to `approved`; "
            "they remain retryable only under a fresh approval."
        )
    statement = " ".join(parts)
    signature = hmac.new(
        signing_key if isinstance(signing_key, bytes) else signing_key.encode("utf-8"),
        statement.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    recorded = db.rpc(
        "record_plan_reconciliation",
        {
            "p_tenant_id": payload.tenant_id,
            "p_plan_id": payload.plan_id,
            "p_batch_id": batch_id,
            "p_correlation_id": payload.correlation_id,
            "p_statement": statement,
            "p_statement_signature": signature,
        },
    )
    if "error" in recorded:
        raise ExecutorRefused(recorded["error"])
    return recorded
