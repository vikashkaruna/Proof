# Revision 114 — frozen board source boundary (2026-09-30)

## Scope and result

The prior board request stored assessment digests while draft generation reread the live packet. The PDF endpoint rendered new bytes on every GET although no exact object version had been retained. Revision 114 closes these two misleading boundaries without reopening publication.

Migration 0086 captures the finalized packet's exact PostgreSQL `controls::text` and `result::text` in a write-once request source. It verifies the controller and ledger chain, stores the source and component SHA-256 digests, and denies direct client reads and service writes. New draft metadata binds to the frozen source hash and byte count; a mismatched source reference aborts the draft transaction. Historical requests have no invented snapshot and must be requested again. The BFF checks live internal-founder authority before reading the source and again before draft recording. It verifies the source and component byte hashes before rendering. The old PDF GET now returns `report_artifact_unverified` until a verified exact version is implemented.

## Verification

- Fresh disposable Postgres: 87 migrations, direct-client security assertions, concurrency and populated upgrade, and DSN runner passed. Board-specific SQL asserts exact frozen text, no direct read/write grant, idempotent replay, and refusal of a forged source digest without a draft.
- BFF board route tests: 10/10 passed, including non-founder pre-read denial, tampered snapshot refusal, and PDF refusal.
- Full monorepo tests, typecheck, lint, formatting and build passed; BFF ran 1,451 passing tests. The dependency/security scan was clean. The existing Docker parity stack was upgraded in place to migration 0086. The full strict-auth Playwright regression passed 89/89. Revision 114 PR and exact-staging validation remain to be recorded.

## Remaining W8 release gate

The frozen source currently resides in PostgreSQL. There is no verified Object Lock source/PDF version, no retained final PDF readback, no source-bound artifact build/reconciliation, no founder preview/release path, and no manager/founder product UI or deployed end-to-end journey. The SQL release guard from 0081 remains closed for generated board reports. The database snapshot is a provenance boundary, not a sealed evidence claim or complete W8 acceptance.
