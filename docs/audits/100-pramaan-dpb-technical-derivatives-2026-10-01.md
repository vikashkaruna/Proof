# W8.4 DPB and technical Pramaan derivatives — 2026-10-01

The new dossiers derive only from already published, founder-released, source-bound DPB and technical review packs. They do not create a regulator filing, prove delivery or acceptance, or independently certify remediation execution, rollback, verification, or closure. `full_closure` and outbound dispatch remain closed.

## Boundaries

- `0096` creates the engagement-bound technical register dossier. It requires the recorded plan source, released report, exact settled source/PDF versions, release ledger hashes and provider version IDs. The plan ID and engagement in the frozen source must match the request and report.
- `0097` creates a **tenant-level** DPB dossier because the breach and notification source has no engagement. The additive constraint keeps all other dossier types engagement-bound. Historical DPB metadata is not rewritten or treated as verified. Frozen breach and notification IDs must match the released request.
- Both migrations use private pending-build and immutable archive-receipt tables, service-read-only grants, strict typed requests and Compliance receipts, idempotent settle/retry, and founder-only seal with a ledger event. A pending or forged receipt cannot be sealed.
- The BFF re-reads exact provider source/PDF versions before construction and founder seal, verifies the archive version after upload, and returns only exact archive bytes. An ambiguous upload remains pending; a second PUT requires an explicit founder retry after checking the fixed object key.
- The ZIP manifests identify the source report/request, exact source and PDF version IDs, hashes, and bounded limitations. The DPB route and UI show tenant scope explicitly; neither supplies a fictional engagement.

## Open security blocker

The shared `service_role` credential can call the new `begin_*`, `settle_*`, `note_*_failure`, and `seal_*_pramaan` SECURITY DEFINER RPCs directly while supplying another user's UUID. Database role checks then mistake that UUID for a real human caller. A forged Compliance receipt can settle a nonexistent provider archive, and a forged founder ID can mark it sealed with a misleading human ledger event. The BFF verifies the real provider in its normal path, but these direct SQL calls bypass the BFF. The same pattern affects the earlier board and auditor dossier functions. **Do not deploy or merge these migrations until a systemic BFF-only credential or DB-verified signed intent/receipt/seal boundary is integrated and its forgery tests pass.**

## Evidence and remaining gates

- Ordered `0000–0097` migration application: passed in a disposable Supabase PostgreSQL container.
- Focused DPB and technical SQL authority tests: passed after final migration edits, including source/PDF and exact-version mismatch, wrong role, premature seal, false engagement, non-Compliance receipt, immutable settled version, founder seal, service/client write grants, and founder-only dossier metadata RLS.
- BFF focused tests: 13/13 passed. Report-kit archive tests: 5/5 passed. Workspace typecheck, lint, and test: 16 tasks passed.
- A full disposable DB run passed migration and SQL suites, then the unrelated assessment concurrency barrier timed out under concurrent host load. A clean full DB concurrency pass remains required.
- Real-provider Playwright acceptance has been extended to cover both dossier kinds, exact archive version/readback, founder seal, refusal and UI selection. It has **not** run in this isolated checkout because the owned provider/persona fixture and prior combined fixes are in the ordered integration branch. It must run there before release.
- Repository static security scan completed cleanly; it does not clear the direct-RPC bypass above. Integration/provider gate results should be appended after completion. No production deployment or statutory filing is claimed by this work.
