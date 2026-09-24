# Review 40 — completed-dispatch retention

Reviewed upstream `7485880`, Revision 50; CI [35715172231](https://github.com/vikashkaruna/Proof/actions/runs/35715172231) passed 17 applicable jobs and eight exact-revision artifacts. No intervening other-model commits were present. Existing KMS adapters, retained-reader preparation and recovery guarantees were preserved.

## Findings and changes

- **Completed private inputs/proofs had no retention path.** The user's accepted environment-configurable policy now defaults to 90 days, measured from independent confirmation. Migration 0046 and the service-only cleanup RPC remove only the encrypted payload and wrapped data key.
- **Age alone is not completion evidence.** Selection requires delivered, confirmed successful work. Cleanup rechecks context, digests and immutable receipts using the existing confirmation verifier. Conflicting records survive and return a review state; unresolved jobs are never finalized merely to qualify for deletion.
- **Deleting a job would break recovery.** The row, original run, scheduling and single-use claim survive. Enqueue retries recover the original receipt after purge; no new run or delivery is created. Findings/results and evidence remain separate.
- **Audit and deletion must be atomic.** Mandatory append-only audit precedes nulling payload columns in the same transaction. Failure rolls back both. One candidate per transaction uses task/run/packet/job lock order and skips a busy task. Separate-session tests cover in-flight confirmation, held task locks and duplicate cleanup.
- **Maintenance must be explicit and bounded.** A separate strict-auth backend entrypoint accepts only once/watch; ordinary server startup is unchanged. Output schemas reject private or unknown fields. Errors and review stop the poller. A timed-out RPC may commit; inspect durable receipts before restart. Scoped config excludes unrelated signing, MFA, model and runtime keys.
- **Configuration must survive transport.** Docker, Cloud Run variables/env sync and Helm carry the default/override; environment examples name the separate dispatch policy. Offline Terraform tests prove custom values and invalid-policy refusal.

## Validation and limits

Workspace tests (820 BFF, 68 config), typecheck, lint/security and acceptance TypeScript; SQL age/policy, role, conflict, audit rollback and post-purge recovery checks; 47 migrations, 16 concurrency suites, 12 populated upgrades. Real Auth/PostgREST/SPIRE worker acceptance passes 61 identity and 39 worker outcomes, including live-row purge and unchanged findings/confirmation. The first concurrent fixture reused another suite's synthetic proof hash; namespacing the fixture fixed the collision without relaxing production constraints. Docker initially needed starting. Exact final merge CI is recorded in the saved session.

This is live-row removal, not WAL/backup erasure or KMS retirement. No production maintenance job, cloud deployment, email, client mutation or WORM change occurred. Follow Doc 16 for invocation/recovery. Next: persisted key-policy revisions and enqueue/claim fences; retained-artifact inventory; per-job isolation/trust and dedicated controller/scheduler deployment, other workers/actor chains, W4.4 grants and full W3 wizard/graph. W0/W1/W2 remainder stays open. No overall completion claim.
