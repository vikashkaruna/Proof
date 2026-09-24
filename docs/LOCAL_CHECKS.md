# Axiom Proof — Local Checks & Status Reference

> Day-to-day reference for verifying the repository locally. **Not** a
> production runbook (see [`09_RUNBOOK.md`](./09_RUNBOOK.md) for that).
> **Not** a deployment guide (see [`08_DEPLOYMENT_GUIDE.md`](./08_DEPLOYMENT_GUIDE.md)).

Last verified: 2026-08-18 against `main` @ `16bd83b`.

---

## 0. Current state (snapshot)

### GitHub

| Item                                            | State                                                                                                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `main` HEAD                                     | `16bd83b`                                                                                                                                                    |
| Total commits on main                           | 15 (4 original + 11 audit/remediation)                                                                                                                       |
| Branch protection                               | Not enforceable — repo is on GitHub Free plan (private). See [A.3 in `REPO_AUDIT_PLAN.md`](./REPO_AUDIT_PLAN.md#a3-limitations-of-a-merge-into-one-approach) |
| Required CI checks (per `branch-protection.md`) | `Lint + typecheck`, `TS unit tests`, `Python (agent runtime) tests`, `Python (model gateway) tests`, `Security scan`                                         |
| Latest PR CI result                             | ✅ all 5 green on PR #14                                                                                                                                     |
| Latest push-to-main CI                          | All required checks green; only `Build container images` failed (typo: `actions/setup-buildx-action` should be `docker/setup-buildx-action`)                 |
| Dependabot config                               | Tightened (PR #7) — `rebase-strategy: auto`, `delete-branch-after-merge: true`                                                                               |
| Open PRs                                        | 0                                                                                                                                                            |
| Stale branches                                  | 0 (all dependabot branches auto-deleted when their PRs were closed)                                                                                          |

### Local (verified 2026-08-18)

| Check               | Result            |
| ------------------- | ----------------- |
| `pnpm format:check` | ✅ pass           |
| `pnpm typecheck`    | ✅ 11/11 packages |
| `pnpm lint`         | ✅ 11/11 packages |
| `pnpm test`         | ✅ 9/9 packages   |
| `pnpm build`        | ✅ 2/2 apps       |
| Working tree        | ✅ clean on main  |

### Audit reports (`docs/audits/`)

| Report                       | Status                                                               |
| ---------------------------- | -------------------------------------------------------------------- |
| `00-baseline.md`             | Repository-local findings remediated                                 |
| `01-security.md`             | Repository-local findings fixed; external TODOs remain               |
| `02-module-coverage.md`      | Repository-local findings fixed; product/infrastructure TODOs remain |
| `03-quality-and-coverage.md` | Repository-local findings fixed; tooling/configuration TODOs remain  |
| `README.md`                  | Index of all four reports                                            |

---

## 1. Quick start — run everything

```bash
cd "/Users/vikash/Axiom Proof"

# 1. Confirm you're on main and it's clean
git status
git log origin/main --oneline | head -10

# 2. Install deps (idempotent)
pnpm install --frozen-lockfile

# 3. Run all 5 Part B Phase 0 checks
pnpm format:check
pnpm typecheck
pnpm lint
pnpm test
pnpm build

# 4. Browser persona journeys (W1). Real GoTrue accounts, real login form,
#    AXIOM_AUTH_MODE=strict. Needs Docker for the isolated parity stack.
./scripts/start-parity-supabase.sh
pnpm exec tsx scripts/seed-personas.ts
pnpm --filter @axiom/e2e exec playwright install chromium   # first run only
pnpm --filter @axiom/e2e exec playwright test
```

**Expected**: each step exits 0. The build step takes ~15s; the rest are <2s.

---

## 2. Part A — branch + repo state

```bash
cd "/Users/vikash/Axiom Proof"

# Branch inventory (local + remote)
git branch -a -vv

# PR inventory
gh pr list --state all --limit 20

# Last 5 CI runs
gh run list --limit 5

# Latest main commit
git log -1 origin/main

# Confirm Free plan (branch protection NOT enforceable)
gh api repos/vikashkaruna/AxiomProof/branches/main/protection 2>&1 | head -3
# Expected: 403 — "Upgrade to GitHub Pro or make this repository public"
```

---

## 3. Part B Phase 0 — build, lint, test, CI

These are the five local checks that mirror the GitHub Actions CI workflow.

```bash
cd "/Users/vikash/Axiom Proof"

# 0. Lockfile exists; install deps exactly as CI does
ls pnpm-lock.yaml            # must exist
pnpm install --frozen-lockfile

# 1. Prettier
pnpm format:check
# Alternative: auto-fix
# pnpm format

# 2. TypeScript strict across all 11 packages + apps
pnpm typecheck

# 3. ESLint (Next.js core-web-vitals) on web + marketing; "no lint config" elsewhere
pnpm lint

# 4. Vitest across packages (uses --passWithNoTests in package.json)
pnpm test
# Notable test suites:
#   packages/ledger    : 8 tests in canonicalise.test.ts
#   packages/config    : 5 tests in index.test.ts
#   packages/evidence  : tests for S3 Object Lock client
#   packages/approval-engine : 7 tests in index.test.ts (HMAC sign/verify)

# 5. Next.js production build for web + marketing
pnpm build
```

**Common failure modes**:

- `prettier: 4 YAML files have parse errors` → fixed by ignoring `infra/helm/` in `.prettierignore` (already committed)
- `pnpm install --frozen-lockfile` fails with `Lockfile is incompatible` → run `pnpm install` once (no flag) to refresh, then commit the lockfile
- `No lint config` on web/marketing → run from a TTY (the Next.js interactive prompt needs a real terminal). If already configured, this won't fire.

---

## 4. Part B Phase 1 — security

The audit covers the 6 non-negotiables from `AGENTS.md` plus the 9 security-sensitive paths in `branch-protection.md`. See `docs/audits/01-security.md` for the full report.

```bash
cd "/Users/vikash/Axiom Proof"

# Read the report
cat docs/audits/01-security.md

# Spot-check the 6 non-negotiables
grep -rn "can_mutate" services/agent-runtime/src/ 2>/dev/null | head -3
grep -rn "SECURITY DEFINER" infra/supabase/migrations/ 2>/dev/null | head -3
grep -rn "ObjectLockMode\|compliance" infra/terraform/envs/prod/ 2>/dev/null | head -3
```

**External TODOs** (cannot be done locally):

- Apply Supabase migrations against a real Supabase project; verify `append_ledger()` works
- `terraform plan` in `infra/terraform/envs/prod/` against a real AWS account; verify the S3 Object Lock **Compliance** bucket and IAM
- Run the Playwright E2E suite against a staging env

---

## 5. Part B Phase 2 — module coverage

Covers the 14 modules from `docs/02_Phase_Wise_Implementation_Plan.md` (M0.1–M0.6, M1.1–M1.8). See `docs/audits/02-module-coverage.md`.

```bash
cd "/Users/vikash/Axiom Proof"

# Read the matrix
cat docs/audits/02-module-coverage.md

# Confirm agent roster
ls services/agent-runtime/src/axiom/agents/ 2>/dev/null
# Expected: drishti.py, vibhaag.py, parikshan.py, saakshi.py,
#           sudhaar.py, karya.py, lekha.py, nazar.py,
#           prativedan.py, sanket.py

# Confirm the control count matches CONTROL_LIBRARY_COUNT (derived, currently 46)
grep -c "^    id: '" packages/control-library/src/controls.ts
# Expected: 43
```

---

## 6. Part B Phase 3 — quality + cross-doc

Covers type safety, dead code, Zod schema reuse, mutation testing, and cross-doc consistency. See `docs/audits/03-quality-and-coverage.md`.

```bash
cd "/Users/vikash/Axiom Proof"

# Read the report
cat docs/audits/03-quality-and-coverage.md

# Cross-doc consistency: agent count should match
grep -l "10 named agents\|10 agents" \
  docs/04_Solution_Architecture.md \
  AGENTS.md \
  README.md

# Control count cross-check
echo "Doc claim: 46 controls"
echo "Code: $(grep -c "^    id: '" packages/control-library/src/controls.ts)"

# Stray `any` (should be near zero after Phase 3 fixes)
grep -rn ": any" apps/web/src apps/marketing/src services/bff/src 2>/dev/null | head -10
```

---

## 7. Python services (need `uv`)

```bash
cd "/Users/vikash/Axiom Proof"

# Install uv if not present
brew install uv
# or: curl -LsSf https://astral.sh/uv/install.sh | sh

# Agent runtime (10 named agents, FastAPI)
cd services/agent-runtime
uv sync
uv run pytest          # ~24 tests
cd ../..

# Model gateway (self-hosted LLM, PII redaction)
cd services/model-gateway
uv sync
uv run pytest          # ~13 tests
cd ../..
```

**Note**: model-gateway's pinned spaCy wheel may not build on Python 3.14. Use Python 3.11:

```bash
uv python install 3.11
cd services/model-gateway
uv venv --python 3.11
uv sync --python 3.11
PYTHONPATH=src uv run pytest
```

---

## 8. GitHub-side checks (CI + branches)

```bash
cd "/Users/vikash/Axiom Proof"

# Watch the latest CI run live
gh run watch

# List all 5 required CI checks for a PR
gh pr checks <PR_NUMBER>

# View a specific run's jobs + status
gh run view <RUN_ID>

# List dependabot PRs
gh pr list --label dependencies --state all

# Audit the last 10 workflow runs
gh run list --limit 10
```

---

## 9. One-shot smoke test

```bash
cd "/Users/vikash/Axiom Proof" && \
  echo "=== format ===" && pnpm format:check 2>&1 | tail -1 && \
  echo "=== typecheck ===" && pnpm typecheck 2>&1 | tail -3 && \
  echo "=== lint ===" && pnpm lint 2>&1 | tail -3 && \
  echo "=== test ===" && pnpm test 2>&1 | tail -3 && \
  echo "=== build ===" && pnpm build 2>&1 | tail -3 && \
  echo "=== git ===" && git status -s && \
  echo "DONE"
```

**Expected output ends with**:

```
DONE
```

and an empty `git status -s` (working tree clean).

---

## 10. External TODOs (cannot run from a local machine)

These are the things the audit reports flag as "fixed locally, needs external verification":

| #   | TODO                                                                 | Where                                                         | What's needed                               |
| --- | -------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------- |
| 1   | Supabase migrations applied                                          | `infra/supabase/migrations/*.sql`                             | A real Supabase project; `supabase db push` |
| 2   | `append_ledger()` RPC verified                                       | `infra/supabase/migrations/0005_approvals_ledger.sql`         | psql against the Supabase DB                |
| 3   | S3 bucket in Compliance mode                                         | `infra/terraform/envs/prod/s3.tf`                             | `terraform plan/apply` against AWS          |
| 4   | IAM roles + service accounts                                         | `infra/terraform/envs/prod/iam.tf`                            | Same as #3                                  |
| 5   | Temporal worker registered                                           | `services/temporal-workers/src/temporal_workers/workflows.py` | A running Temporal cluster                  |
| 6   | Playwright E2E in staging                                            | `tests/e2e/tests/*.spec.ts`                                   | Deployed staging env + `playwright test`    |
| 7   | CI: fix `actions/setup-buildx-action` → `docker/setup-buildx-action` | `.github/workflows/ci.yml`                                    | Local edit + PR (5-second fix)              |
| 8   | Branch protection (if desired)                                       | GitHub repo settings                                          | Upgrade to Pro OR make repo public          |

---

## 11. When something breaks

| Symptom                                                   | First check                                                | Likely fix                                                                       |
| --------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `pnpm install` fails with lockfile mismatch               | `git status` — any uncommitted package.json changes?       | Commit the lockfile change or run `pnpm install` (no flag) once                  |
| `pnpm typecheck` says `Cannot find module '@axiom/X'`     | Check the consumer's `package.json` for `@axiom/X` in deps | Add `"@axiom/X": "workspace:*"` and re-run `pnpm install`                        |
| `pnpm test` says `No test files found`                    | `package.json` test script                                 | Add `--passWithNoTests` to the vitest command                                    |
| `next lint` is interactive                                | Running from a non-TTY or no `.eslintrc.json`              | Create `apps/<name>/.eslintrc.json` with `{ "extends": "next/core-web-vitals" }` |
| Prettier errors on `infra/helm/**`                        | `.prettierignore`                                          | Add `infra/helm/` (already there)                                                |
| CI fails on push to main but green on PR                  | Branch protection not enforced + a push-only job failed    | Check the `build-images` job for the `setup-buildx-action` typo                  |
| `tsc` says `'X' is specified more than once` in tokens.ts | A `...spread` followed by an explicit key                  | Remove the duplicate explicit declaration                                        |
| `canonicalJson` fails on `ApprovalTokenSpec`              | Type signature too strict                                  | Pass `unknown` instead of `JsonValue` in `packages/ledger/src/canonicalise.ts`   |

For deeper diagnosis, read the relevant audit report under `docs/audits/`.

---

## 12. Pointers

- `README.md` — top-level product description, 6 non-negotiables, repo layout
- `AGENTS.md` — agent-specific instructions, hard rules, common commands
- `docs/REPO_AUDIT_PLAN.md` — the original Part A / Part B plan that drove the audit
- `docs/00_README_Document_Index.md` — index of all 11 strategy docs
- `docs/07_SECURITY_REVIEW.md` — security posture + 9 sensitive paths
- `docs/08_DEPLOYMENT_GUIDE.md` — production deployment
- `docs/09_RUNBOOK.md` — production operations (different from this file)
- `docs/audits/README.md` — index of audit reports
