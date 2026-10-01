# BFF human and provider proof writer boundary

The shared `service_role` credential is held by the BFF and by producer
services. It is not evidence that a person approved a change or that the BFF
read back a retained object from S3. Migration 0098 creates two separate
PostgREST roles so those facts cannot be asserted with the generic credential.

| Authority                   | Permitted entry points                                                                                                                                                                                                                                    | Credential owner                                 |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `human_action_writer`       | 26 exact-name human decision RPCs (consent, policy, onboarding, invitations, connector administration, workload registration, estate management, and W2 authored artifacts), `reject_remediation_plan`; restricted invitation delivery settlement columns | BFF only                                         |
| `evidence_ingestion_writer` | `begin_evidence_ingest`, `settle_evidence_ingest`, `note_evidence_ingest_failure`                                                                                                                                                                         | BFF evidence ingestion service only              |
| `agent_ledger_writer`       | `append_agent_ledger` only (actor type `agent` or `system`; refuses human-authority action types such as `report.released`, `plan.rejected`, `approval.archive.released`); never the raw `append_ledger` or `append_human_ledger`                         | BFF (agent/system events) and agent-runtime only |
| `approval_archive_writer`   | `release_approval_proof_archive` only. Migration 0099 revokes its 0090 grants on `begin_`, `review_` and `settle_approval_proof_archive` and `record_approval_export`, which now belong to `human_action_writer`                                          | BFF only                                         |
| `service_role`              | Existing read and producer entry points; no execution of the RPCs above, and no direct alert or wizard mutation or invitation delivery settlement                                                                                                         | BFF and producer services                        |

The two new roles are `NOLOGIN`, `NOINHERIT`, and `NOBYPASSRLS`; only the
PostgREST `authenticator` can assume them. Migration 0098 fails if any moved
RPC name is missing or overloaded. The BFF checks for distinct, unexpired role
credentials at startup, while PostgREST verifies their JWT signatures. Local
tests mint short-lived tokens against their own Supabase signing secret. Each
deployment mode supplies the keys to the BFF alone through its secret store or
private environment.

Plan rejection now calls one SQL transaction. The RPC locks the plan, verifies
current human membership and that dispatch/execution has not begun, skips its
actions, revokes outstanding approval tokens, cancels the plan, and appends one
`plan.rejected` event. A failed ledger append rolls back every earlier write.
The HTTP route reports success only for a committed RPC receipt. This closes
the prior path that could log a successful human rejection after a zero-row
plan update or a failed action update.

The database boundary suite
[`human-provider-writer-boundary.test.sql`](../tests/database/human-provider-writer-boundary.test.sql)
checks all 29 moved RPC grants, mutual role isolation, generic-role DML denial,
a real founder policy approval through the human role, and digest mismatch
refusal. [`plan-rejection-atomic.test.sql`](../tests/database/plan-rejection-atomic.test.sql)
checks generic-role denial, ledger-outage rollback, successful rejection, and
replay refusal. The BFF route test checks the writer call and refusal statuses
without a second database or ledger mutation. The isolated real PostgREST probe
[`probe-human-provider-postgrest.ts`](../scripts/probe-human-provider-postgrest.ts)
confirms HTTP 403 for the generic and wrong writer roles, HTTP 401 for a forged
writer signature, and committed human policy and pending evidence receipts for
the correctly scoped roles.

This boundary does not turn a service credential into proof of a real human
session. The BFF still authenticates the request and checks its capability;
each SQL RPC rechecks the relevant tenant/actor state. Likewise, a scoped
evidence token alone does not prove S3 retention: the BFF must verify the
provider response and readback before calling the settlement RPC. No raw
personal data is sent to a third-party model provider by this path.

**Production release blocker:** the historical `service_role` grant on
`append_ledger()` remains a separate proof-source gap: a holder can append a
human-labeled event, although it cannot invoke the 0098 human decision RPCs.
Other pre-0098 proof RPCs also retain
their original grants. The same generic role still has direct
`INSERT`/`UPDATE`/`DELETE` on remediation plans and actions, outside the atomic
reject RPC. Removing direct ledger and table authority or splitting all
producer/proof RPCs requires a further inventory and migration of existing BFF,
worker, and seed call sites; 0098 makes no claim to close those paths.
In particular, the older `start_execution_batch` RPC validates nonce, scope,
and content digest but does not itself check that its approval token remains
consumed, that an outbox claim exists, or that the plan is still active. The
normal claim path checks those conditions, but a generic-service direct RPC
caller can bypass that path. This is another 0099 release gate, including a
post-rejection replay test.

The smallest safe 0099 follow-up is a second additive migration and client
cutover, kept separate from 0098 so that its actor semantics can be reviewed.
Revoke generic `service_role` EXECUTE on `append_ledger()`, retain that
append-only function, and grant a BFF-only ledger identity a wrapper that
permits human events only after the authenticated actor and tenant membership
are checked. Give the agent runtime a separate producer identity whose wrapper
cannot claim a human actor. Preserve the existing hash chain and fail-closed
append behavior. The direct callers to cut over are the 15 human appends in
`services/bff/src/routes/v1.ts`, the BFF ledger service and broker repository,
and the Python agent-runtime ledger client. The 35 older ledger-appending RPCs
that remain generic-service callable need an exact-signature actor/owner review:
22 carry human or provider decisions (including breach, DSAR, standing-policy,
approval archive, and workload delegation), and 13 are producer operations.
Revoke generic direct `INSERT`/`UPDATE`/`DELETE` on remediation plans and
actions after replacing only the seed and strict-parity setup writes with a
fixture-only privileged setup path; production BFF and executor reads already
use `SELECT` or purpose-specific RPCs. The 0099 gate must prove generic-role
denial for direct append, direct plan/action mutation, and every migrated proof
RPC, plus positive BFF and producer writes, cross-role denial, and ledger-chain
continuity on a populated database.

The generic-service RPC inventory for that review is:

- Human or provider assertions (22): `acknowledge_drift_event`,
  `advance_breach`, `advance_dsar`, `begin_approval_proof_archive`,
  `create_standing_policy`, `delegate_workload_task`,
  `draft_breach_notification`, `onboard_organization`,
  `publish_assessment_dispatch_key_policy`,
  `reconcile_execution_dispatch`, `record_approval_export`,
  `record_breach`, `record_dsar`, `register_connector_tool`,
  `register_monitoring_schedule`, `review_approval_proof_archive`,
  `review_breach_notification`, `revoke_standing_policy`,
  `revoke_workload_task`, `send_breach_notification`,
  `settle_approval_proof_archive`, `verify_dsar_identity`.
- Producer assertions (13): `dispatch_monitoring_alerts`,
  `evaluate_standing_policy`, `finish_execution_batch`,
  `mark_execution_action_started`, `purge_next_assessment_dispatch_payload`,
  `record_connector_discovery`, `record_drift_event`, `record_dry_run`,
  `record_rollback_execution`, `record_schedule_run`,
  `record_verification_result`, `settle_execution_action`,
  `start_execution_batch`.

The direct BFF append sites in `routes/v1.ts` are seven MFA event types across
nine calls, plus `execution.started`, `execution.action.failed`,
`execution.rollback.started`, `execution.rollback.completed`, and the two
execution kill-switch events. All 15 currently label the actor `human`.
`services/bff/src/services/ledger.ts` constructs the generic-key ledger
client; `services/bff/src/connectors/broker/repository.ts` constructs another
for an `agent` event. `services/agent-runtime/src/axiom/ledger_client.py`
also constructs a generic-key client. `packages/ledger/src/append.ts` is the
shared RPC adapter used by the BFF clients. Seed and strict-parity scripts
insert or update remediation plans/actions directly; the production BFF and
executor paths found in this inventory only read those tables directly.

## Status after migration 0099

Migration 0099 adds `agent_ledger_writer` (`append_agent_ledger`), makes
`human_action_writer` the only caller of `append_human_ledger` and of the 22
human or provider RPCs inventoried above, revokes generic `service_role`
`EXECUTE` on `append_ledger` and on the legacy `start_execution_batch`, and
adds `start_claimed_execution_batch`, which also requires a consumed approval
token and a pending outbox claim under the plan lock.
`SUPABASE_AGENT_LEDGER_WRITER_KEY` (minted by `scripts/mint-supabase-keys.mjs`
with `role: agent_ledger_writer`) is injected into the BFF and the agent
runtime only; the human and evidence keys stay BFF-only. The 0090 archive
writer keeps `release_approval_proof_archive` and nothing else, because the BFF
now calls `begin`, `review`, `settle` and `record_approval_export` through the
human writer.

`tests/deployment/selfhosted-supabase.sh` proves this through real
PostgREST role switching: the generic service JWT is refused (HTTP 403) on
`append_ledger`, `append_agent_ledger`, `append_human_ledger` and
`start_execution_batch`; the agent writer appends a system event but is refused
`append_human_ledger`, a human-authority event, and `append_ledger`; the human
writer is refused `append_agent_ledger` and `start_claimed_execution_batch`;
the service JWT reaches the claimed gate's `plan_not_found` check.
