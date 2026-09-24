# Continuing implementation — Revision 83

**Revision 83 — W4.5 internal tool registry (Claude cloud session):** migration 0057 adds `register_connector_tool`, which is audited and append-only, makes read/write classification mandatory, and allows no write tools on sandbox bindings. It also adds `verify_connector_tool`, which rejects a tool unless its description matches the SHA-256 pinned at registration. `ToolRegistry` in the BFF refuses unregistered, reclassified or changed tools, and any tool whose class does not match the lease scope. `GET` and `POST /v1/connectors/:id/tools` expose it. See [audit 72](audits/72-internal-tool-registry-review-2026-09-24.md). Schema is **0057 / 58 migrations / 60 public tables**; the next migration is **0058**. Next in plan order: W4.6, the first real SQL binding.

**Revision 82 — W4.4 grant issuance and enforcement (Claude cloud session):**

- Migration 0056 adds `issue_connector_grant` for owners and admins. It enforces Drishti read, Karya write, write only on production bindings, and a 90-day cap; duplicates are refused and every issue is audited. It also adds `resolve_broker_grant`, which re-reads the grant, workload, lifecycle, credential, descriptor and kill switch in one snapshot.
- `GrantBrokerAuthority` composes JWT-SVID verification with that resolution. It re-resolves in `stillCurrent`, and writes fail closed until a W5 approval verifier exists.
- `POST /v1/connector-grants` and an "Issue agent access" form on `/estate/setup` are added.
- The broker is still not exposed on a route. See [audit 71](audits/71-connector-grant-issuance-review-2026-09-24.md).
- Schema is **0056 / 57 migrations / 60 public tables**; the next migration is **0057**.
- Next in plan order: W4.5 internal tool registry, W4.6 first SQL binding, then W4.7 REST/GraphQL.

**Revision 81 — W3.5 estate graph (Claude cloud session):** `/estate/graph` draws agents, connector registrations, systems, estates and data categories, with access edges derived only from active grants. Read edges are teal and write edges are indigo with a 🔒 WRITE label; there is no gold. It has filters, an "Everything Karya can write to" view, a node detail panel and SVG export. Derivation edges (finding/evidence), live agent animation and PNG/branded export remain open W3.5 scope. See [audit 70](audits/70-estate-graph-review-2026-09-24.md). No schema change. Next in plan order: W4.4 grant issuance and enforcement.

**Revision 80 — C-W3-6 estate sustenance (Claude cloud session):**

- Migration 0055 adds an immutable onboarding attestation snapshot, `onboarding_estate_drift` (systems added, removed or changed, and lost connection paths) and a 90-day agent-grant re-attestation queue. Owners and admins record keep or revoke decisions, audited in the ledger.
- The BFF adds `/v1/estates/:id/drift`, `/v1/connector-grants/review` and `/v1/connector-grants/:id/attestations`.
- `/estate/setup` gains a drift card and an access-review list.
- Nothing issues grants. See [audit 69](audits/69-estate-sustenance-review-2026-09-24.md); operator input was not received, and the assumptions are recorded there.
- Schema is now **0055 / 56 migrations / 60 public tables**; the next migration is **0056**.
- Next in plan order: W3.5 `/estate/graph`, then W4.4 grants.

**Secret-scan history audit (#50 promotion):** a full-history gitleaks run found 37 historical findings. 34 were verified as the public Supabase local demo JWTs (`iss=supabase-demo`), named unit-test keys, or placeholder bearer tokens in a quick-reference doc; they are ignored by exact fingerprint in `.gitleaksignore`. **3 are held for the operator and not ignored:** two 64-hex `GOTRUE_JWT_SECRET`/`PGRST_JWT_SECRET` values in `infra/docker/docker-compose.supabase.yml` (commit `7719f0c`, since removed from the file) and one `APPROVAL_SIGNING_KEY` in `.env.preprod.example` (commit `7631b1f`). If any of them was used by a deployed stack, rotate it; then fingerprint-ignore it. `scripts/security-scan.sh` now also runs gitleaks over unpushed commits when gitleaks is installed.

**Revision 79 — C-W3-5 resumable onboarding wizard (Claude cloud session):** migration 0054 (`tenant_onboarding_wizards`, DPO contact on `tenants`, three ledger actions), `start_/advance_onboarding_wizard` and a live readiness checklist, BFF `/v1/onboarding/wizard` routes, and the `/estate/setup` page. The wizard records confirmations only: it issues no grants and does not treat a registered connector as a live connection. See [audit 68](audits/68-onboarding-wizard-review-2026-09-24.md). Operator input on design was not received; the assumptions are recorded in audit 68. Schema is now **0054 / 55 migrations / 58 public tables**. The next migration is **0055**. Next in plan order: C-W3-6 sustenance and re-attestation, then the W3.5 `/estate/graph` page, then W4.4 grants. **History note:** `main` received direct pushes before the staging flow began. All of them are contained in staging, and the only main-only commit was the #45 promotion merge commit, which this revision carries back into staging. The operator should protect `main` so that it accepts only staging promotions.

**Code-scanning remediation (operator request, #47):** the open CodeQL/Bandit alerts on main are fixed at source rather than dismissed:

- `generateUUID` no longer falls back to `Math.random`.
- Evidence GCS detection (TS and Python) and the Temporal Cloud check compare parsed hostnames, not substrings.
- The TOTP base32 padding trim is linear.
- The S3 `Content-MD5` digest is marked `usedforsecurity=False`.
- The acceptance-target file is checked and read through one descriptor.
- `ci.yml` defaults to `contents: read`.
- Lekha raises instead of asserting.
- The swallowed exceptions now log an event name.
- Container `0.0.0.0` binds and the SafeLoader-derived YAML load carry justified `nosec` markers.

Test code is excluded through a shared `.bandit` configuration, which removes about 150 test-only assert and fixture-credential notes. **Early detection:** `scripts/security-scan.sh` (`pnpm security:scan`, run by the husky pre-push hook) applies the same Bandit config as CI. It fails on medium+ in shipped services and on high anywhere, then runs ESLint. `@axiom/eslint-config` now rejects `Math.random` and host-substring checks while editing. With `AXIOM_CODEQL` set, the script also runs CodeQL security-extended locally.

**Follow-ups, not yet fixed:**

- Five web screens still fabricate IDs, hashes and scores with `Math.random`. They are listed as tracked lint debt.
- CodeQL flags world-readable SPIRE health files (deliberate cross-UID reads) and a URL built in `verify-controller-issuance.py`.
- Bandit reports medium findings in test-harness SQL strings.

The user's instruction still stands: continue in plan order after every green milestone. At each milestone, report it and keep the implementation, testing, documentation and no-fast-forward staging integration up to date. Use isolated Docker services for testing. The overall goal is active and incomplete. No cloud provisioning/apply is authorized.

When operator input is unavailable, continue with the recommended option and record in Docs 11–16 that no input was received, together with the assumptions made.

## Revision 76 — C-W0-6 durable contact inquiries (Claude cloud session)

**Baseline:** Revision 75 is complete at staging `6617e32` (PR 42; source CI 35906474455 and staging CI 35908407498 succeeded).

**Delivered:** migration 0052 `contact_inquiries` (BFF-only writes, immutable content, one-time delivery settlement). BFF `POST /public/contact` and `GET /public/contact/config`. The marketing route only forwards; the SSR mail path and in-memory store are removed. Marketing's mail credential/allowlist is removed from Cloud Run, Helm and Compose. `AXIOM_CONTACT_EMAIL_MODE` is a new BFF opt-in (default `disabled`). See [audit 65](audits/65-contact-inquiry-persistence-review-2026-09-24.md).

**Status:** W0/W1/W2/W3/W4 remain partial. W2 is **19/40**. Schema is **0052 / 53 migrations / 56 public tables**, plus three private credential tables.

## Revision 77 — C-W0-7 scoring semantics and display provenance

Delivered on the same branch/PR as Revision 76. There is a shared versioned gap-scan question set, and benchmarks are labelled as editorial estimates. The portal and Workbench no longer invent figures; the Workbench's broken queries are fixed. Playwright passes 68/68. See [audit 66](audits/66-scoring-and-display-provenance-review-2026-09-24.md).

## Revision 78 — C-W1-3 tenant invitations

Migration 0053, the invitation RPCs, the BFF routes, `/settings/members`, the `/invite` accept page, and the login open-redirect fix. See [audit 67](audits/67-tenant-invitations-review-2026-09-24.md). Staging (through Revision 77) is promoted to main through vikashkaruna/Proof#45 after a full branch audit, as a merge commit once its checks are green; Trivy was fixed (filesystem scan) so that check can pass. **Always unshallow before comparing branches** (`git fetch --unshallow`): the cloud clone is shallow and otherwise reports false "unrelated histories".

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
- Never edit an applied migration. The next migration is **0054**. C-W0 code findings (C-W0-4/6/7) and C-W1-1…4 are all delivered. Re-raise the Dependabot bumps (closed vikashkaruna/Proof#32–#36) against staging.

## Next in plan order

1. **W3**: C-W3-5 resumable company → estate → inventory → connector/grant → readiness wizard; C-W3-6 sustenance/re-attestation; the W3.5 `/estate/graph` page.
2. **W4.4**: grant model enforcement per invocation, portal grant/revoke UI and ledger events. Then W4.5–W4.7.
3. **Cloud-gated, when authorized:** secret publication/replication, effective IAM allow/deny evidence, private TLS/DNS, opaque scheduler, and real GCP IIT/caller/KMS/Mumbai recovery. Also W0 remote parity, C-W0-5 deployed IAM, and the EKS CIDR decision.
4. **Follow-up hardening:** Helm `web` and `marketing` deployments still inject `SUPABASE_SERVICE_KEY`, which neither app reads.

## Invariants

Preserve all of the following:

- Tenant-bound approval requires a completed dry-run and a validated rollback.
- Sudhaar has no write credentials.
- The ledger is append-only.
- Evidence uses WORM (Object Lock Compliance mode).
- Personal data stays in Mumbai.

Public APIs remain on Cloud Run. Each tenant gets a dedicated private Mumbai runner, and the issuer is separate. Local success and a completed engineering milestone do not imply whole-roadmap completion or deployed cloud acceptance.
