# W8.4 DPB and technical Pramaan derivatives — 2026-10-01

The new dossiers derive only from already published, founder-released, source-bound DPB and technical review packs. They do not create a regulator filing, prove delivery or acceptance, or independently certify remediation execution, rollback, verification, or closure. `full_closure` and outbound dispatch remain closed.

## Boundaries

- `0096` creates the engagement-bound technical register dossier. It requires the recorded plan source, released report, exact settled source/PDF versions, release ledger hashes and provider version IDs. The plan ID and engagement in the frozen source must match the request and report.
- `0097` creates a **tenant-level** DPB dossier because the breach and notification source has no engagement. The additive constraint keeps all other dossier types engagement-bound. Historical DPB metadata is not rewritten or treated as verified. Frozen breach and notification IDs must match the released request.
- Both migrations use private pending-build and immutable archive-receipt tables, service-read-only grants, strict typed requests and Compliance receipts, idempotent settle/retry, and founder-only seal with a ledger event. A pending or forged receipt cannot be sealed.
- The BFF re-reads exact provider source/PDF versions before construction and founder seal, verifies the archive version after upload, and returns only exact archive bytes. An ambiguous upload remains pending; a second PUT requires an explicit founder retry after checking the fixed object key.
- The ZIP manifests identify the source report/request, exact source and PDF version IDs, hashes, and bounded limitations. The DPB route and UI show tenant scope explicitly; neither supplies a fictional engagement.

## Dedicated writer security gate

The combined branch now includes a BFF-only `statutory_proof_writer` identity. The 0091–0097 source, artifact, release and Pramaan mutation RPCs revoke `service_role` and grant only this role; the BFF keeps service-role reads and invokes mutations through the writer client. This prevents a generic agent-runtime service key from supplying a founder UUID or fabricated storage receipt directly. A 25-function SQL privilege matrix checks the grants, and focused DPB/technical SQL tests exercise direct service-role denial and a restricted-writer invocation. The shared generic review/board/auditor boundary is supplied by amended 0089. Full ordered database, provider, and deployment credential gates must pass before this is a deployable closure.

## Evidence and remaining gates

- Ordered `0000–0097` migration application: passed in a disposable Supabase PostgreSQL container after the writer-role checkpoint. Focused DPB, technical, and 25-function writer SQL suites passed (3/3).
- Focused DPB and technical SQL authority tests: passed after final migration edits, including source/PDF and exact-version mismatch, wrong role, premature seal, false engagement, non-Compliance receipt, immutable settled version, founder seal, service/client write grants, and founder-only dossier metadata RLS.
- BFF focused tests: 13/13 passed. Report-kit archive tests: 5/5 passed. Workspace typecheck, lint, and test: 16 tasks passed.
- An earlier full disposable DB run passed migration and SQL suites, then the assessment concurrency barrier timed out under concurrent host load. The current writer-role branch has not completed the full DB suite: legacy board fixtures still call newly restricted RPCs under `service_role`, and the writer-role fixture needs its schema fix. These are being repaired in the upstream security checkpoint; rerun the exact full suite after integration.
- Real-provider Playwright acceptance has been extended to cover both dossier kinds, exact archive version/readback, founder seal, refusal and UI selection. It has **not** run in this isolated checkout because the owned provider/persona fixture and prior combined fixes are in the ordered integration branch. It must run there before release.
- Workspace typecheck (16/16), lint (16/16), full TS test suite, and static security scan completed cleanly after the writer-role checkpoint. This does not substitute for full DB, provider, or production credential evidence. No production deployment or statutory filing is claimed by this work.
