# Revision 96 — Drift acknowledgement and the monitoring-health surface (W6)

## Scope and assumptions

This slice completes the drift story: a human judgement on each detection, and the health surface that makes "continuous" defensible rather than assumed. Operator input was not received. The assumptions are:

1. **One judgement, on the record.** `acknowledge_drift_event` binds `acknowledged_by` and `acknowledged_at` together (the table constraint), refuses a second judgement (`already_acknowledged`), and ledgeres `monitoring.drift.acknowledged` as a human action.
2. **Health is computed, not asserted.** `GET /v1/monitoring/health` reports each schedule's freshness with an `overdue` flag (active + next_run_at passed) and the last-7-days drift counts by severity with an unacknowledged count — the monitoring-of-the-monitoring surface, tenant-scoped, POSTURE_READ.
3. No new status, table or state machine: the acknowledgement lands on the existing append-only `drift_events` rows.

## Change

- **Migration 0067** — `acknowledge_drift_event` (SECURITY DEFINER, service_role only) and ledger value `monitoring.drift.acknowledged` (added to `LedgerActionType` in the same commit).
- **BFF** — `POST /v1/monitoring/drift-events/:id/acknowledge` (ESTATE_MANAGE; RPC refusals rendered as 409), `GET /v1/monitoring/drift-events` (POSTURE_READ, newest first), `GET /v1/monitoring/health` (POSTURE_READ).
- **`fake-postgrest.ts`** — the test double gained `.gte()`, which real PostgREST has and the health route uses.

## Evidence

- **`tests/database/drift-acknowledgement.test.sql`:** an acknowledgement lands once with who/when and is ledgered; refused: a second acknowledgement, an unknown event, an anonymous judgement; `authenticated` cannot execute the function or update/delete `drift_events`; the (nobypassrls) `service_role` cannot update or delete.
- **Route tests:** the acknowledgement and its 409 rendering; ESTATE_MANAGE enforced; the health surface's overdue flag, counts and severity aggregation.
- **Results:** BFF 1132 tests pass, types 46, the database suite passes on fresh migrations, typecheck/ruff/prettier/security-scan clean.

## Not delivered

- The standing-policy engine (`policy_evaluations`' writer) — the next W6 slice.
- Alerts/notifications on drift severities; a dedicated monitoring UI page.
- Deployed acceptance with the scheduler enabled (operator).
