# W8 combined local provider acceptance — 1 October 2026

The ordered local W8 integration includes board and auditor source-bound reports, board Pramaan, approval proof archive, DPB and technical source-bound reports, evidence ingestion, and retained evidence packs. This is engineering acceptance against a source-built, loopback-only S3-compatible fixture and local Auth/PostgREST. It is not AWS Compliance Object Lock, ap-south-1 residency, preproduction, or production acceptance.

The complete `scripts/test-evidence-storage.py --browser` gate passed **15/15 Playwright journeys with zero unexpected outcomes, retries, flakes, or skips** in 9.1 minutes. The persisted machine result is `.axiom-runtime/evidence-storage/browser-results.json`; that file is local and ignored because it contains fixture state. The journeys cover exact retained source/PDF versions, independent hash and provider readback, founder MFA review/release, tenant/role denial, pending and interrupted provider recovery, and technical/DPB source workflows.

Three integration fixes followed failures in earlier full runs:

- `69d882f` (cherry-picked here as `0aa4309`) requests explicit retention one second beyond a microsecond-precision database deadline, avoiding a false below-deadline S3 readback after JavaScript millisecond parsing.
- `96b7bf8` (cherry-picked here as `a13a0de`) sends the strict receipt schema expected by the DPB/technical settlement RPCs and verifies the exact retained source version before serving a PDF. Focused unit tests cover changed or unavailable source bytes.
- `fdff620` (cherry-picked here as `709733a`) creates a distinct internal founder with its own TOTP factor for each provider journey. This keeps the full suite inside the production MFA rate limit without disabling or bypassing that limit.

The full workspace tests, typecheck, lint, build, and local security checks passed after the first two fixes; the final E2E-only change was compiled and exercised by the complete Playwright run. This checkpoint does **not** clear staging or production. The shared `service_role` credential could still directly call founder/receipt mutation RPCs on this validation branch, and separate restricted-writer fixes for board/statutory/Pramaan and approval archives are being tested. Full ordered migration, direct-call denial, real-provider rerun on the integrated security head, exact staging merge SHA, and remote production target acceptance remain required.
