# W8 combined local provider acceptance — 1 October 2026

The ordered local W8 integration includes board and auditor source-bound reports, board Pramaan, approval proof archive, DPB and technical source-bound reports, evidence ingestion, and retained evidence packs. This is engineering acceptance against a source-built, loopback-only S3-compatible fixture and local Auth/PostgREST. It is not AWS Compliance Object Lock, ap-south-1 residency, preproduction, or production acceptance.

The complete `scripts/test-evidence-storage.py --browser` gate passed **15/15 Playwright journeys with zero unexpected outcomes, retries, flakes, or skips** in 9.1 minutes. The persisted machine result is `.axiom-runtime/evidence-storage/browser-results.json`; that file is local and ignored because it contains fixture state. The journeys cover exact retained source/PDF versions, independent hash and provider readback, founder MFA review/release, tenant/role denial, pending and interrupted provider recovery, and technical/DPB source workflows.

Three integration fixes followed failures in earlier full runs:

- `69d882f` (cherry-picked here as `0aa4309`) requests explicit retention one second beyond a microsecond-precision database deadline, avoiding a false below-deadline S3 readback after JavaScript millisecond parsing.
- `96b7bf8` (cherry-picked here as `a13a0de`) sends the strict receipt schema expected by the DPB/technical settlement RPCs and verifies the exact retained source version before serving a PDF. Focused unit tests cover changed or unavailable source bytes.
- `fdff620` (cherry-picked here as `709733a`) creates a distinct internal founder with its own TOTP factor for each provider journey. This keeps the full suite inside the production MFA rate limit without disabling or bypassing that limit.

The full workspace tests, typecheck, lint, build, and local security checks passed after the first two fixes; the final E2E-only change was compiled and exercised by the complete Playwright run. This checkpoint does **not** clear staging or production. The shared `service_role` credential could still directly call founder/receipt mutation RPCs on this validation branch, and separate restricted-writer fixes for board/statutory/Pramaan and approval archives are being tested. Full ordered migration, direct-call denial, real-provider rerun on the integrated security head, exact staging merge SHA, and remote production target acceptance remain required.

## Integration note (W8.5 + statutory)

The 15/15 count above predates the board-authority-revocation journey and the approval-archive journey carried on the W8.5 base. On the integrated branch `scripts/test-evidence-storage.py` requires the sum of every test in its seven specs: ingestion 1, vault 3, packs 3, pack-access 1, board 5, approval archive 1, technical and DPB source-bound formats 2, which is 16. This integrated count is computed from the specs and has not been run against a real provider by this checkpoint.

### Result of the integrated 16-journey run (2026-10-01)

On exact commit `859dfaa` (clean tree) the integrated W8.5 + statutory branch passed all 16 real-provider browser journeys with `--workers=1 --retries=0`: 16 passed, 0 unexpected, 0 flaky, 0 skipped, 6.8 minutes. The harness summary recorded `status: passed`, `gitRevision: 859dfaa`, `dirty: false`. It ran against the isolated local parity stack after applying migrations `0091`-`0097` on top of `0000`-`0090` (the `0090` file is byte-identical to the W8.5 one). Local fixture only; it is not staging or production acceptance.

The first integrated run (`7a4ef6b`) passed 13 of 16. The three failures were real UI/BFF contract defects, now fixed in `859dfaa`, each with a mutation-checked unit test:

1. **Settled build answer rejected.** `POST /reports/{technical,dpb}/:id/artifacts` returns only `reportId`, `buildId`, `status`, `operationKey` on a settled build, but the web schema also required `reportStatus`, `lastErrorCode` and `pdf`. The parse threw, so the card never updated and the refresh was skipped.
2. **Source dropdown empty.** The closure-dossiers tab requested `limit=100`; the BFF refuses any list limit above 50 with `400 validation_failed`, so no released report was offered. The tab now requests 50, and a scan test fails if any literal `limit=` in the reports UI exceeds 50.
3. **DPB card stranded without a receipt.** After a stale list read the card showed `settled` with no PDF receipt and no release control, and nothing re-read. Settled cards without a receipt now re-read a bounded number of times.

Not proven by this run: staging or production behaviour, the real BFF-to-S3 path outside the local loopback provider, and anything in W9/W10.
