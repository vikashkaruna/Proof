# W4.3 assessment confirmation and lost-response recovery

Revision 42 is complete at staging `66a9ec4`, CI [35687544717](https://github.com/vikashkaruna/Proof/actions/runs/35687544717): 17 applicable jobs passed. Seven exact-merge artifacts verify 67 browser/89 API outcomes per configuration, 61 SPIRE, five runtime-audit and 11 real isolated-worker outcomes. No intervening upstream implementation was found.

## Problem and behavior

The isolated worker could commit findings and an assessment receipt, then lose its response before the controller recorded completion. The run remained `running`. An exit code or a worker-supplied receipt string cannot safely settle this ambiguity.

Migration **0043** adds controller-only `confirm_workload_assessment`. It locks the task, run and packet in the existing order; independently validates their tenant, engagement, correlation and input binding; recomputes packet/result SQL digests; and resolves the actual immutable start/completion ledger rows. The rows must match the agent, action, result, context, input/output hashes, workload and pinned library digest. Only then can it atomically append `workload.task_completed`, mark the run `succeeded` and retain the finalization receipt. A retry returns the same persisted result and receipt. Audit failure rolls back finalization while leaving the earlier assessment result intact.

Confirmation records a past authorized commit. It may finish after task expiry, revocation, user demotion, estate archival or a later halt; it issues no new authority and cannot write findings. Worker tools remain refused once the run becomes terminal. A concurrent cancellation, failure, timeout or contradictory existing success is preserved and reported as a conflict. Missing/uncommitted results remain unconfirmed; recovery never manufactures success or silently reruns an agent.

The BFF adapter compares the confirmed row to the trusted controller's expected tenant/run/engagement/correlation/input. It returns only validated persisted result fields and fixed sanitized errors. It is deliberately absent from the worker tool router and browser API. No SVID or task proof is required to record historical truth, but only the trusted service role can call the SQL routine. Future user-facing result reads still require ordinary tenancy/MFA authorization.

Deterministic scoring records zero model tokens/cost; latency is elapsed time from recorded run start to result commit. The existing exposure formula is unchanged. A small legacy-agent adapter correction supplies the pure scorer's declared dataclass input explicitly.

## Validation

- **624 BFF tests**, including 14 new confirmation regressions, plus shared ledger enum/SQL parity. Workspace tests, lint, typecheck, acceptance TypeScript and formatting/security gates pass. Python runtime remains **187 tests**.
- **14 real isolated-worker outcomes**, including a deliberately discarded terminal worker response, independent exactly-once finalization and refusal to use terminal task authority again. Missing results after rejected tools are refused by the confirmer too.
- **44 migrations**, **13 concurrency suites**, **9 populated upgrade suites**. SQL regressions cover foreign/unknown runs, conflicting input/result/receipt bindings, cancellation, audit rollback and historical confirmation after authority has ended. Held-open sessions test both cancellation/completion orderings and competing confirmations. The 0042→0043 upgrade preserves a completed assessment packet and recovers its run without worker redispatch.
- Test fixture corrections: confirmation races now use their own globally unique synthetic proof hash, and the reverse cancellation race starts with a fresh running task. An already succeeded row correctly does not wait on a `status='running'` cancellation predicate; waiting for that impossible lock was a test defect.

The new exact-merge CI and seven sanitized artifacts are recorded in the saved session after execution. Prior green CI proves Revision 42, not this follow-up. Schema tip is **0043**, public table count stays **53**, and the W2 named target set remains **19/40**.

## Operational boundary and next work

This closes the database/adapter confirmation and recovery component. **Production orchestration is still open:** trusted idempotent issuance/dispatch, bounded isolated worker launch, private payload delivery, automated recovery scheduling, production trust/registration lifecycle and the other nine scoped agent paths. The normal UI still uses the legacy route and ordinary BFF startup does not activate the new worker tools. No new operator action, cloud deployment or client estate mutation occurred.

When an invocation response is lost, use the expected controller context to confirm the owned packet. `result_unconfirmed` is uncertainty, not proof of failure or rollback; `terminal_conflict` needs review of the existing terminal record. Do not overwrite it, downgrade a confirmed success, invent receipts or redispatch blindly. The result remains ordinary durable application/audit data, not WORM-sealed proof.

Next order remains W4.3 orchestration/scoped workers/verified actor chains, W4.4 live grants and approval, full W3 resumable onboarding/readiness and graph, then W4.5/6/7. W0 deployed/contact/provenance work, W1 invitations and W2 remainder stay open. The overall goal is not complete.
