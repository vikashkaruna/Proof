# Continuing implementation — Revision 76

The user's instruction still stands: continue in plan order after every green milestone. At each milestone, report it and keep the implementation, testing, documentation and no-fast-forward staging integration up to date. Use isolated Docker services for testing. The overall goal is active and incomplete. No cloud provisioning/apply is authorized.

When operator input is unavailable, continue with the recommended option and record in Docs 11–16 that no input was received, together with the assumptions made.

## Revision 76 — C-W0-6 durable contact inquiries (Claude cloud session)

**Baseline:** Revision 75 is complete at staging `6617e32` (PR 42; source CI 35906474455 and staging CI 35908407498 succeeded).

**Delivered:** migration 0052 `contact_inquiries` (BFF-only writes, immutable content, one-time delivery settlement). BFF `POST /public/contact` and `GET /public/contact/config`. The marketing route only forwards; the SSR mail path and in-memory store are removed. Marketing's mail credential/allowlist is removed from Cloud Run, Helm and Compose. `AXIOM_CONTACT_EMAIL_MODE` is a new BFF opt-in (default `disabled`). See [audit 65](audits/65-contact-inquiry-persistence-review-2026-09-24.md).

**Status:** W0/W1/W2/W3/W4 remain partial. W2 is **19/40**. Schema is **0052 / 53 migrations / 56 public tables**, plus three private credential tables.

## Current work and continuation

- Branch `codex/revision75-controller-generation-transition` (the operator-designated branch), on top of `4dedecf` (already contained in staging). Integrate into `staging` through a PR and a no-fast-forward merge after source CI is green; then verify the staging push CI.
- This cloud container has no persistent `.axiom-runtime`, so checkpoints live in Docs 11–15. The Codex worktree's `.axiom-runtime` evidence remains on the operator's machine.
- **Local test recipe in a fresh cloud container:**
  1. Start `dockerd`.
  2. `pnpm install --frozen-lockfile`.
  3. `bash scripts/test-database.sh`.
  4. Install Supabase CLI 2.116.0 from GitHub releases, then run `SUPABASE_INTERNAL_IMAGE_REGISTRY='' ./scripts/start-parity-supabase.sh` and `pnpm exec tsx scripts/seed-personas.ts`.
  5. Symlink `/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell` to Playwright's expected `chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell`.
  6. `pnpm --filter @axiom/e2e exec playwright test` (67 journeys).
- `registry.terraform.io` is blocked by the session proxy, so Terraform validate/test and Helm render run only in CI.
- Never edit an applied migration. The next migration is **0053**.

## Next in plan order

1. **C-W0-7**: reconcile q7/q11/q12 question-to-control scoring semantics, and label the readiness benchmark/percentile as heuristic with provenance. Stored reports stay immutable snapshots.
2. **C-W1-3**: invitation workflow and provider adapter contract. Real delivery stays gated on provider/domain evidence.
3. **W3**: C-W3-5 resumable company → estate → inventory → connector/grant → readiness wizard; C-W3-6 sustenance/re-attestation; the W3.5 `/estate/graph` page.
4. **W4.4**: grant model enforcement per invocation, portal grant/revoke UI and ledger events. Then W4.5–W4.7.
5. **Cloud-gated, when authorized:** secret publication/replication, effective IAM allow/deny evidence, private TLS/DNS, opaque scheduler, and real GCP IIT/caller/KMS/Mumbai recovery. Also W0 remote parity, C-W0-5 deployed IAM, and the EKS CIDR decision.
6. **Follow-up hardening:** Helm `web` and `marketing` deployments still inject `SUPABASE_SERVICE_KEY`, which neither app reads.

## Invariants

Preserve all of the following:

- Tenant-bound approval requires a completed dry-run and a validated rollback.
- Sudhaar has no write credentials.
- The ledger is append-only.
- Evidence uses WORM (Object Lock Compliance mode).
- Personal data stays in Mumbai.

Public APIs remain on Cloud Run. Each tenant gets a dedicated private Mumbai runner, and the issuer is separate. Local success and a completed engineering milestone do not imply whole-roadmap completion or deployed cloud acceptance.
