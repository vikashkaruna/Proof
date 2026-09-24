# Revision 76 — C-W0-6 durable contact inquiries behind the BFF

## Baseline and scope

Revision 75 is complete at staging `6617e3283092462f40a13168d1f016da69048f14`. [CI 35908407498](https://github.com/vikashkaruna/Proof/actions/runs/35908407498) (staging push) and source [CI 35906474455](https://github.com/vikashkaruna/Proof/actions/runs/35906474455) (source `4dedecf`) both concluded **success**. [PR 42](https://github.com/vikashkaruna/Proof/pull/42) was integrated by a no-fast-forward merge commit.

The remaining Revision 75 roadmap items (cloud secret publication/replication, effective inherited IAM, private TLS/DNS, opaque scheduler, real GCP IIT/caller/KMS/Mumbai recovery) all require cloud apply, which is not authorized. This revision therefore takes the next open **code** item in plan order: C-W0-6 from Doc 16.

**Operator input not received.** The operator was unavailable when this revision started. Per the standing instruction, work continued on the recommended option under these recorded assumptions:

1. Cloud-gated W4 work stays parked until cloud apply is authorized. The next W0 code findings (C-W0-6, then C-W0-7) come first, followed by C-W1-3 invitations, then W3 (C-W3-5/6, W3.5) and W4.4 grants.
2. Contact mail uses its own explicit opt-in (`AXIOM_CONTACT_EMAIL_MODE=delivery`). Enabling report mail therefore does not also enable founder-contact mail. Both default to `disabled`.
3. Inquiries are retained (no delete path). A retention/erasure policy for marketing personal data belongs with W8.1 rights handling and is not invented here.

## Finding (C-W0-6)

Before this change, `apps/marketing/src/app/api/contact/route.ts`:

- stored inquiries only in process memory (`globalThis` map), so a restart or a second instance lost them;
- sent mail from SSR with the marketing service's own `RESEND_API_KEY`;
- returned `success: true` with "sent directly to the founder" copy when no provider was configured, when the provider refused, and on network failure;
- exposed an unauthenticated `GET` that reported the in-memory inquiry count.

## Change

- **Migration 0052** adds `public.contact_inquiries`. RLS is enabled; all privileges are revoked from `public`, `anon`, `authenticated` and `service_role`, and only `select/insert/update` are re-granted to `service_role`. A `CHECK` constraint makes each delivery status (`not_configured`, `pending`, `sent`, `failed`) agree with its evidence: attempt/completion timestamps, provider receipt, error code. A trigger blocks deletion, keeps submitted content immutable, and settles an outcome exactly once (`pending → sent | failed`), including for privileged sessions. The service-role update policy only sees `pending` rows, so a `not_configured` row can never be upgraded to `sent`. Axiom-internal users may read inquiries through their own session; other authenticated users see none.
- **BFF `POST /public/contact`** validates with the shared `ContactSubmitSchema` and consumes two fail-closed rate budgets (200/hour globally; 5/hour per case-folded sender hash). It persists before any mail attempt and returns `503 persistence_failed` without sending when storage fails. It makes at most one provider attempt, then settles the row. The reply is `{ id, delivery }`, where `delivery` is exactly the stored status. If settlement cannot be recorded, the reply is `pending` (stored, delivery unknown), never `sent`.
- **BFF `GET /public/contact/config`** reports only `emailDeliveryEnabled`.
- **`services/bff/src/services/contact-email.ts`** is the provider adapter. It refuses redirects, has a 15-second timeout, HTML-escapes submitted content, and returns `sent` only when the provider supplies a receipt id.
- **Marketing** validates and forwards to the BFF through the existing credential-free `gapScanBackend` helper. `contact-store.ts` is deleted. Its `GET` now returns only the BFF delivery flag (the acceptance preflight contract `emailConfigured` is preserved). The form states only what the server recorded: "Message received … saved for review" unless the BFF reports `sent`.
- **Deployment configuration:** marketing no longer receives `RESEND_API_KEY` or any mail variables in Cloud Run, Helm or Compose. Its Secret Manager allowlist is now `supabase_anon_key` only; the IAM checker and `runtime_iam.tftest.hcl` enforce this. The BFF receives `AXIOM_CONTACT_EMAIL_MODE` (new Terraform variable `contact_email_mode`, validated `disabled|delivery`, default `disabled`) plus the recipient and sender variables it actually reads. `sync-env.sh` maps the new variable, and every environment example documents it.

## Verification

All local checks below ran in this cloud session's container. The Docker daemon was started locally, and an isolated Supabase CLI 2.116.0 parity stack ran on port 56321.

| Check                                                                                                                                            | Result                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `scripts/test-database.sh`: fresh apply of 53 migrations, re-apply, all SQL suites, concurrency and upgrade scripts, `service_role nobypassrls`  | **pass**, including new `contact-inquiries.test.sql`                                                                         |
| BFF vitest                                                                                                                                       | **1,016 / 1,016** (12 new contact route/adapter/config cases; 1,004 before)                                                  |
| Marketing vitest                                                                                                                                 | **6 / 6** (4 new route cases)                                                                                                |
| Workspace `typecheck`, `lint`, `test` (turbo)                                                                                                    | 15 / 15 / 14 tasks successful                                                                                                |
| `prettier --check` (repository)                                                                                                                  | clean                                                                                                                        |
| `terraform fmt -check -recursive`                                                                                                                | clean                                                                                                                        |
| `check-tfvars-coverage.sh`, `check-env-security-gate.sh`, `check-mfa-ring-coverage.sh`, `check-cloudrun-iam.py`, `check-cloudrun-auth-wiring.py` | **pass** (preprod: 30 variables covered)                                                                                     |
| `tests/deployment` unittest                                                                                                                      | **214** OK                                                                                                                   |
| `scripts/lib/*.test.ts`                                                                                                                          | 25 pass                                                                                                                      |
| Playwright browser journeys against the real isolated stack (strict auth, seeded personas)                                                       | **67 / 67 pass**. The contact journey now asserts a `201`, `delivery: not_configured`, the honest copy, and no "sent" claim. |
| Persisted row observed directly in the parity Postgres                                                                                           | `Aarav Mehta / not_configured / never attempted`                                                                             |

The first DB run caught a real defect before commit. Default privileges from 0001 give `service_role` `DELETE`, and with no delete policy, RLS turned a `DELETE` into a silent 0-row success. 0052 now revokes all from `service_role` before its explicit grants, so the delete is refused.

**Not verified locally.** `terraform init/validate/test` could not run because this container's proxy returns 403 for `registry.terraform.io`. Helm render/kubeconform also did not run (no Helm binary). Both run in CI; source CI and exact staging CI are the closure gates, and their results are recorded in Docs 11–15. Real provider delivery was not exercised; acceptance keeps contact mail disabled.

## Remaining

C-W0-7 (q7/q11/q12 scoring semantics and benchmark provenance) is the next W0 code item. W0 remote acceptance, C-W0-5 deployed IAM acceptance and the EKS CIDR decision stay operator-gated. The Helm `web` and `marketing` deployments still receive `SUPABASE_SERVICE_KEY`, although neither app reads it. That is recorded as a follow-up W0/W10 hardening item and is deliberately not widened into this change.
