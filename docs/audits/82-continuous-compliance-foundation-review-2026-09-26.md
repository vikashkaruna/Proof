# Revision 94 — Continuous compliance foundation (W6 slice 1)

## Scope and assumptions

This slice opens W6 with its foundation: the four monitoring/policy tables Doc 11 (W2) lists as missing, plus the estate manager's schedule-registration write path. Operator input was not received. The assumptions are:

1. **One active schedule per estate and kind.** A duplicate is a configuration error, not a second opinion; a re-registration retires the previous schedule (history is kept, not deleted) in the same audited transaction. The rule is a partial unique index on `status = 'active'`, so retired rows may repeat freely.
2. **A schedule is a promise the scheduler can keep.** The first fire must be in the future, the cadence must be a shaped 5-field cron expression, and the estate must exist. The scheduler that fires them (the next W6 slice) reads the same rows — registration is never a side-effect-free promise.
3. **Standing policies never bypass the gate (M4.1).** A policy is human-authored AND human-approved (both columns mandatory — an orphan policy is an unaccountable one), scope-bounded with a mandatory `action_types` array, and expiring. Its evaluations record what matched and what was decided; the policy engine (next slice) issues scoped tokens through the existing approval engine or escalates — it never executes.
4. **Drift events are append-only facts.** Kind and severity are closed sets, the summary is bounded and identifier-shaped (details live in the records the drift was detected against), and acknowledgement is all-or-nothing (`acknowledged_by`/`acknowledged_at` together).

## Change

- **Migration 0065:**
  - `monitoring_schedules` — per-estate cron schedules (`rediscovery` / `reassessment` / `drift_check`), one-active-per-kind index, due-schedule index for the scheduler;
  - `drift_events` — append-only detections with severity and acknowledgement shape;
  - `standing_approval_policies` — versioned, expiring, dual-attributed, mandatory scope;
  - `policy_evaluations` — append-only record of what a policy did, tenant-bound to its policy;
  - `register_monitoring_schedule` (SECURITY DEFINER, service_role only) — validates shape, tenancy, estate and creator, retires the replaced schedule, and appends `monitoring.schedule.registered` (new ledger value, added to `LedgerActionType` in the same commit) with the schedule id as the target.
- **BFF** — `POST /v1/monitoring/schedules` (ESTATE_MANAGE; validates the future first fire and rejects an RPC refusal as 409, never as success) and `GET /v1/monitoring/schedules?estateId=` (POSTURE_READ, tenant-scoped).

## Evidence

- **`tests/database/monitoring-schedules.test.sql`:** registration, retirement of the replaced schedule, exactly one active per kind, both registrations in the ledger, coexisting kinds; refused: a past first fire, an unshaped cadence, an unknown estate; a policy without `action_types` cannot exist; an evaluation names a real policy; `authenticated` reads its own schedules but cannot execute the function or write any of the four tables; the (nobypassrls) `service_role` cannot update or delete.
- **Route tests:** registration as an estate manager, 403 without ESTATE_MANAGE, four invalid-request refusals, an RPC refusal rendered as 409, and tenant-scoped listing.
- **Results:** BFF 1122 tests pass, the database suite passes on fresh migrations, typecheck/lint/security-scan clean.

## Not delivered

- The scheduler itself (Temporal workflow or interval worker firing due schedules into drift checks and re-discovery), `record_drift_event`'s write path, and the policy engine that evaluates standing policies and issues scoped tokens — next W6 slices.
- Schedule pause/resume and delete routes, and the monitoring-health surface ("monitoring the monitoring").
- Deployed acceptance (operator).
