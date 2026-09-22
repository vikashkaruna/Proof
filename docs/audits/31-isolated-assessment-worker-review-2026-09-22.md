# W4.3 isolated assessment worker and transactional tools

Reviewed upstream `39f973f` and exact green CI [35684322559](https://github.com/vikashkaruna/Proof/actions/runs/35684322559). No intervening other-model staging commits were present. Revision 41 is complete; the overall W0–W4 goal remains partial.

## Findings and implementation

The legacy Parikshan agent ignored the requested library version, used its installed library and returned computed findings without persistence. It also inherited the shared runtime's credential-bearing settings and adapters. Constructor injection alone would not isolate those credentials.

The new single-task worker uses a separate minimal Python image containing only the worker protocol, pure scoring function and control parser. It has no BaseAgent, runtime settings, backend SDKs or embedded secrets. The existing deterministic scoring formulas are shared with the legacy agent; library mismatch now fails closed there too. The existing penalty-point exposure heuristic is preserved, not represented as a newly validated statutory calculation.

A trusted controller privately assigns the exact UTF-8 JSON input and its SHA-256 digest, task proof, run and tenant. The worker checks the exact wire digest before any tool request, obtains its own JWT-SVID from the SPIRE Workload API for each operation, and requests only `assessment.start` and `assessment.complete`. Private stdio frames carry proofs and SVIDs; they must never enter logs, browser responses or workflow histories. Fixed safe errors replace exception details. The worker returns `persisted` only after a validated database receipt.

The BFF tool adapter verifies SVID, current registration, task proof and server-selected scope on every request. It derives database context from that authority. Fixed-purpose Hono routes bound request size, reject query-string authority, suppress private request logging and return private/no-store responses. Ordinary BFF startup leaves these routes unavailable; a human JWT or legacy runtime token cannot activate them.

Migration **0042** adds `workload_assessment_packets` and service-only start/complete RPCs. Start pins the complete owned engagement's published/deprecated library, checks its declared count, stores an opaque SQL digest and appends a start receipt. Completion validates version, exact unique control coverage, numeric bounds and rationale before any insert. Findings, engagement scores/status `review`, result digest and audit receipt commit together. Identical retries produce one receipt; conflicting retries cannot overwrite results. Existing findings require a new assessment rather than silent replacement. SQL validates live task authority under locks and checks task/SVID deadlines after tentative writes; expiry or audit failure rolls back the transaction. Raw answers are not written to the audit ledger.

The short transaction holds a SHARE lock on `kill_switch_state`, including first-time tenant halt insertion, followed by the established membership/user/estate/engagement/workload/task/run order. Concurrent assessment operations share that table lock; halt writes wait only for the database transaction, never for worker computation. This initial correctness choice needs load acceptance before broad rollout.

## Evidence

- **610 BFF tests**, including 12 new tool/route regressions; **187 Python runtime tests**, including exact input, version/context, malformed packet and failed-persistence checks. Workspace tests, lint, typecheck and the separate acceptance TypeScript project pass.
- Real local **SPIRE → UID 20003 worker → BFF tool router → Supabase/PostgREST** acceptance: **11 outcomes**. It proves credential/SDK absence, blocked network and Docker socket access, unreadable issuer material, exact versioned computation, durable zero/full scores, retry idempotency, bound/redacted audit, changed-input refusal and mid-task revocation/registration/demotion/trust retirement refusal.
- The issuer and worker share an isolated test container but run as different Unix users; root issuer files are unreadable by the worker. Backend credentials stay in the host controller. The worker acquires its SVID inside its own UID. This is real local Unix workload attestation, not a Cloud Run deployment or production trust bootstrap.
- Disposable PostgreSQL: **43 migrations**, **12 concurrency suites** and **8 populated upgrade suites**. The assessment races cover demotion, registration disablement, task revocation, first tenant halt, estate archival, identity expiry while waiting, duplicate completion and reverse halt ordering. A separate expiry-during-audit test proves rollback after tentative writes. The 0041→0042 upgrade preserves historical findings, scores and status.
- The first new race fixture omitted the required halt `scope` and used an invalid key format; fixed to the actual schema. An existing MFA test timed out under concurrent local load; the subsequent full suite and workspace run passed without changing security behavior or test thresholds.

The new sanitized worker artifact is `.axiom-runtime/workload-assessment/results.json`. Exact staging merge CI must verify it alongside the previous six artifacts; the saved session records the final revision/run. Local dirty-tree results are not exact-commit closure evidence.

## What remains

This completes the representative Parikshan worker/tool path, **not all W4.3 or user-facing assessment dispatch**. The normal UI still uses the legacy runtime route. Engineering must supply a trusted production controller with idempotent issuance, bounded launch/private transport, independently confirmed receipts, terminal agent-run persistence and restart reconciliation. The current tool commit leaves the delegated run `running`; a lost response must be reconciled from the stored packet before finalization, never inferred from a worker exit code. The result is durable but is not WORM-sealed evidence.

Production trust/registration renewal, approved deployment attestation, the other nine isolated agent paths and tools, verified token-exchange actor chains, and W4.4 live connector grants/approval remain open. Karya's generic gate, broker deny-all default, Sudhaar separation, ledger append-only boundary and WORM policies are unchanged. No cloud resource, real mailbox or client estate was touched.

Next: finish W4.3 orchestration and remaining scoped workers, then W4.4, full W3 resumable onboarding/readiness and live graph, then W4.5/6/7. Retain W0 deployed acceptance/contact/scoring/portal work, W1 invitations and the W2 remainder; 53 public tables do not mean all 40 named target tables are delivered (still 19/40).
