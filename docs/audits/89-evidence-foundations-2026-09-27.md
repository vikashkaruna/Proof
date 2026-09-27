# Revision 100 — Evidence foundations

Status: local implementation and validation green; source/staging CI pending. Baseline staging is Revision99, `2ecbcc005fe24dd692b09550fe443c2002509055`. This milestone does not complete W8 or the overall goal.

## Delivered behavior

Migration0073 records an authenticated manager’s durable intent before an upload, fixes its absolute retention deadline once, and settles only against a matching exact-version provider receipt. The seven-year retention is a product policy, not a claim that every uploaded document has a statutory seven-year requirement. Tenant, content hash, size, engagement, source, bucket/key, operation/correlation, encryption and COMPLIANCE readback remain bound. Live membership locks serialize manager demotion with writes; a retry cannot change the recorded intent. Settled evidence metadata and receipts are immutable; parent deletion cannot cascade away retained records. Legacy evidence remains explicitly unverified rather than receiving invented versions or retention proof.

The BFF derives tenant/actor from the authenticated session, computes the digest from actual uploaded bytes and limits uploads to8MiB. The browser bridge and BFF enforce12MiB streamed JSON limits before reading/copying an unbounded upload for idempotency. Reads/downloads use only the stored bucket/key/exact version, with byte/deadline limits. No browser-supplied URI selects storage. Evidence record authority is founder/owner/admin; export and read use their existing separate capabilities.

The evidence page uses real paginated lists and exact UUIDs, recorded dates, sources and control links. Description or exact evidence UUID, control, exact source and UTC date filters execute in the BFF. Human submissions are labelled human. Download returns original stored bytes. Local-file verification computes SHA-256 without uploading the selected file and distinguishes byte integrity from provider retention. Legacy receipt absence, pending storage and provider failures remain visible; no fabricated artifacts, hashes, counts, sealed pack export or regulator-form claim remains.

The Saakshi producer must receive a trusted pending-intent and settlement capability from runtime composition. A service credential, caller-selected actor or internal HTTP transport token is not that authority. When composition is absent it refuses before upload. Wiring production trusted composition remains pending engineering, not a successful delivery claim.

## Recovery boundary

A durable pending operation can reconcile an uploaded object whose PUT response or database settlement was lost by discovering bounded exact-key versions, validating bytes and storage readback, then settling the immutable receipt. Reconciliation never blindly uploads again. An intent committed before any object was written cannot yet settle; it remains pending with an explicit outcome. Conditional create-once recovery with identical-byte replay needs a separately validated provider contract before it can safely close that case. A conflicting legacy content registration also cannot be silently promoted into verified evidence.

## Storage fixture and production acceptance

The isolated Docker S3-compatible fixture uses synthetic data only, loopback/private networking and pinned source/build provenance. MinIO community upstream is archived and its old binaries are not maintained: this fixture is not a production/on-prem distribution recommendation. Keep encryption enabled and preserve local fixture keys for restart checks. [Upstream repository](https://github.com/minio/minio), [release source](https://github.com/minio/minio/releases) and [upstream SSE advisory](https://github.com/minio/minio/security/advisories/GHSA-3rh2-v3gr-35p9) document these limits.

Production acceptance still requires approved provider/distribution/licensing, Mumbai storage placement, exact-version IAM, retained encryption keys, Object Lock COMPLIANCE proof and denial of explicit-version deletion/retention shortening. Recovery requires bucket version listing constrained to the tenant ingestion prefix plus exact-version content, retention and legal-hold reads; do not grant arbitrary bucket/object access. The Terraform evidence policy now grants ListBucketVersions only for `tenants/*/evidence-ingestions/*`. No apply was performed; deployment must bind the approved BFF principal, and agent runtime composition remains a separate authority gate. Local host administrators can modify their Docker volumes, so a local provider fixture does not establish cloud root-level WORM protection. No cloud provisioning is authorized.

## Validation register

- Workspace unit/typecheck/build green: web160, BFF1357 (10 external SQL binding tests run in their dedicated CI jobs), vault38, types52; Python agent-runtime307. Local lint/security pass; two existing invite-navigation warnings remain.
- Complete exclusive database suite passed, including lifecycle/security, concurrent begin/settle/demotion and populated0072→0073 upgrade. Migration0073 applied to the isolated existing Docker parity stack; it is immutable now. Verified schema74 migrations /81 public tables.
- Real isolated encrypted S3 provider:14 outcomes passed, including exact-version bytes after overwrite, loss-response discovery/ambiguity refusal, deletion and shortening refusal, metadata/hash/size failures, legal-hold readback, unlocked-bucket refusal, persistent restart, and unavailable-provider deadline. MinIO returns a specific HTTP400 ObjectLocked refusal for one protected deletion; the harness requires that exact outcome (or403), and independently rereads the receipt after shortening refusal.
- Four real-auth evidence browser journeys passed with zero retries, including actual encrypted upload/settlement, fresh provider verification, byte-for-byte binary download, durable operation replay, legacy hash comparison with no upload, filters and tenant/viewer refusals. Source CI and exact staging CI pending. A dedicated CI job repeats the real-provider and browser checks with sanitized revision-bound summaries.

## Next plan work

Finish the foundation’s acceptance, then evidence_packs with actual archive bytes and offline verification; digest-bound founder review/release; shared branded report formats/PDF/approval exports; RoPA/policy/playbook/classification lifecycles. W6 actual executors and notifications, W7 Healthcare→Tech/library correctness, W9 and W10 remain in the accepted scope. Main promotion is operator-owned.

The first local security scan traversed downloaded third-party Go build dependencies in the ignored private runtime cache. The local scanner now excludes that cache alongside other ignored tool state; shipped application and fixture sources remain scanned. The repeat security gate passed.

Browser integration corrected an implicit select label and two test assertions (pagination buttons and Next’s empty route-announcement alert). The final four-test run passed without retries. The test-only provider was removed through its ownership-checked cleanup; the existing parity Supabase stack remains running. Terraform formatting passed for the scoped version-list permission; nothing was applied to cloud infrastructure.

Source CI36279114106 caught the fixture-only storage journey being discovered and skipped in general container acceptance, whose no-skip guard correctly refused it. The dedicated storage job passed14 provider checks and4 browser tests. The general Playwright configuration now excludes that spec unless the explicit storage fixture flag is enabled; the strict skip guard is unchanged. Discovery verifies83 general tests and4 dedicated evidence tests. The follow-up also restores assessment links using `/evidence?q=<UUID>`, with tenant-scoped exact-ID matching;3 real-auth evidence journeys pass again without retries. Full source/staging acceptance remains pending on the follow-up commit.
