# Revision 95 — The continuous-compliance scheduler (W6 slice 2)

## Scope and assumptions

This slice delivers the scheduler that fires due monitoring schedules and the drift write path it uses. Operator input was not received. The assumptions are:

1. **The scheduler is off until an environment turns it on.** `feature_continuous_scheduler` defaults to false: a deployment never fires schedules its operator did not review. The loop is a poll over `monitoring_schedules` (active, due) with fail-closed database access — an unreachable database skips the pass and is logged, never guessed through.
2. **A schedule only advances through validated bookkeeping.** `record_schedule_run` refuses anything but an active schedule and a next fire strictly in the future, and writes `last_run_at`/`next_run_at` together with the `monitoring.schedule.fired` ledger entry.
3. **The next fire is computed, never guessed.** A minimal, deterministic 5-field cron engine (`cron_next.py`, the standard DOM/DOW OR rule, month-length aware) computes the next fire from the registered cadence. A cadence the engine cannot compute records a FAILED run with a one-day grace next fire — into the ledger for an operator — instead of spinning or improvising.
4. **Drift detections are bounded facts.** `record_drift_event` is the only write path into `drift_events`: closed kind/severity sets, identifier-shaped summary and source reference, against a real estate, ledgered as `monitoring.drift.detected` (added to `LedgerActionType` in the same commit, as `monitoring.schedule.fired`).
5. **Only executable kinds fire.** `drift_check` schedules run against the estate's sealed baseline (`onboarding_estate_drift`, 0055): each detected system becomes an event with severity by kind (connection loss high, removal high, addition/change medium). `rediscovery` and `reassessment` schedules are registered and stored but not yet executable — the scheduler leaves them due for the slice that wires their executors, and fires nothing on a guess. An estate with no completed baseline is recorded as `no_baseline`, stated honestly rather than failed.

## Change

- **Migration 0066** — `record_drift_event` and `record_schedule_run` (both SECURITY DEFINER, service_role only), plus the two ledger values.
- **`axiom/cron_next.py`** — the pure cron next-fire engine and its `CronSyntaxError`.
- **`axiom/scheduler.py`** — `poll_once` (due schedules → drift checks → recorded events → advanced bookkeeping), `scheduler_loop` (a poll that absorbs single-pass failures), and the fail-closed `SchedulerDb`.
- **`axiom/app.py` / `axiom/config.py`** — the loop starts in the application lifespan only when the feature flag is set, and is cancelled on shutdown; `scheduler_poll_seconds` is bounded 30–3600.

## Evidence

- **`tests/database/scheduler-write-paths.test.sql`:** a detection records and ledger against a real estate; refused: an unknown estate, an invented kind, an unbounded summary; an active schedule advances with bookkeeping and ledger; refused: a past next fire, a paused schedule; `authenticated` cannot execute either function or write the tables; the (nobypassrls) `service_role` cannot update or delete.
- **`test_scheduler.py`:** the cron engine (every-N-minutes, daily, lists and ranges, the DOM/DOW OR rule, short-month day skipping, garbage refused); the pass (drift becomes recorded events with kind-mapped severity and a fired run; a clean estate records no_drift; no_baseline stated honestly; non-drift kinds stay due untouched; an uncountable cadence records a failed run; database unavailability skips the pass).
- **Results:** agent-runtime 249 tests pass, types 45, the database suite passes on fresh migrations, ruff clean.

## Not delivered

- Executors for `rediscovery` and `reassessment` schedules (re-discovery reuses `/internal/discovery/run`; reassessment re-runs the estate assessment).
- Drift acknowledgement routes and the monitoring-health surface ("monitoring the monitoring").
- The standing-policy engine (`policy_evaluations`' writer) — the next W6 slice.
- Deployed acceptance on an environment with the scheduler enabled (operator).
