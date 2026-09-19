# AGENTS.md

This file is the project-level agent instructions (consumed by
[OpenCode](https://opencode.ai), [Codex](https://openai.com/codex/),
[Cursor](https://cursor.sh/), etc.). It supplements the more
comprehensive [`README.md`](./README.md).

## Project identity

- **Product:** Axiom Proof — agentic DPDPA compliance platform
- **Product Domain:** https://axiomproof.ai (Workbench: https://app.axiomproof.ai)
- **Company:** Axiom Minds Private Limited
- **Company Domain:** https://axiomminds.ai
- **Tagline:** "Agents do the work. You approve. The proof is automatic."

## Hard rules (read these first)

1. **No mutating agent action without a recorded human approval.**
   Architecturally enforced via signed, scope-bound tokens validated
   per action (`@axiom/approval-engine` in TS, `axiom.approval_engine`
   in Python). The BFF refuses to issue a token for an action
   without a completed dry-run + validated rollback.

2. **The planning agent (Sudhaar) holds no write credentials.**
   `SudhaarAgent.can_mutate = False`. This is separation of duties
   (ADR-3). Do not change this.

3. **The audit ledger is append-only.** The only sanctioned write
   path is the `append_ledger()` Postgres function, which is
   SECURITY DEFINER. The `ledger_writer` role has INSERT only.
   Do not change this.

4. **The evidence vault uses S3 Object Lock Compliance mode.**
   Compliance mode means nobody — including root — can shorten
   the retention or delete the object before the lock expires.
   Do not change this.

5. **All client personal data stays in `ap-south-1`.** No
   third-party model provider sees raw values. The Model Gateway
   redacts PII before egress (Doc 05 §6).

6. **Approval cannot be issued for an action without a completed
   dry-run AND a validated rollback.** This is BR-2 and is enforced
   in `services/bff/src/routes/v1.ts`.

## Architecture

- **Monorepo:** pnpm workspaces + Turborepo. TS packages share
  `tsconfig.base.json`. Python services are sibling directories,
  managed with `uv` rather than the JS monorepo tool.
- **Apps:** `apps/web` (product), `apps/marketing` (public site).
- **Services:** `services/bff` (Hono, the API + execution gate),
  `services/agent-runtime` (FastAPI, 10 named agents),
  `services/model-gateway` (FastAPI, self-hosted LLM gateway),
  `services/temporal-workers` (durable orchestration).
- **Shared:** `packages/{design-tokens, ui, types, control-library,
ledger, evidence, approval-engine, supabase, config}`.

## Brand

- **Indigo** (`#1E2A4A`) = institutional trust
- **Teal** (`#0FB5A5`) = active machine intelligence / approvals
- **Gold** (`#C9A227`) = sealed proof — RESERVED exclusively for
  sealed evidence and attestations. Never used decoratively.
- **Ember** (`#D9534F`) = gaps, risks, overdue
- **Slate / Mist** = neutrals

See `packages/design-tokens/src/colors.ts` for the full system.

## Conventions

- **TypeScript:** strict mode, no `any`, branded ID types, Zod
  for runtime validation. Shared types live in
  `packages/types/src/`.
- **Python:** Python 3.11+, Pydantic v2, structlog, pydantic-settings
  for env. The control library mirror lives at
  `services/agent-runtime/src/axiom/control_library_loader.py`.
- **SQL:** Migrations are append-only. Once a row is in the
  `controls` table, it's immutable. Publishing a new library
  version creates new rows; it does not UPDATE.
- **Tests:** Vitest for TS (`pnpm test`), pytest for Python
  (`uv run pytest`), Playwright for E2E (`pnpm test:e2e`).
- **No secrets in code.** Use AWS Secrets Manager (or `.env` in
  dev — but never committed).

## Common commands

```bash
# Install
pnpm install

# Build everything
pnpm build

# Run a single app
pnpm --filter @axiom/web dev
pnpm --filter @axiom/marketing dev
pnpm --filter @axiom/bff dev

# Tests
pnpm test
cd services/agent-runtime && uv run pytest
cd tests/e2e && pnpm test:e2e

# Migrations
pnpm db:migrate
pnpm db:reset            # dev only

# Seed the control library & users
pnpm seed:controls
pnpm seed:users

# Build the controls.json for the Python runtime
pnpm tsx scripts/build-controls-json.mjs

# Format + lint
pnpm format
pnpm lint

# Infra
cd infra/terraform/envs/prod
terraform init && terraform plan && terraform apply
```

## Where to look for X

| Question                                 | Where                                                                                           |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------- |
| What is the brand voice / naming?        | `docs/01_Product_Naming_Branding_and_GTM.md`                                                    |
| What are the 14 modules and their phase? | `docs/02_Phase_Wise_Implementation_Plan.md`                                                     |
| What's the FR / NFR / business rule?     | `docs/03_BRD_PRD.md`                                                                            |
| What's the architecture?                 | `docs/04_Solution_Architecture.md`                                                              |
| What stack?                              | `docs/05_Technology_Stack_Analysis.md`                                                          |
| Why this stack over alternatives?        | `docs/06_Infrastructure_and_Lockin_Strategy.md`                                                 |
| Security review?                         | `docs/07_SECURITY_REVIEW.md`                                                                    |
| How do I deploy?                         | `docs/08_DEPLOYMENT_GUIDE.md`                                                                   |
| How do I run this in production?         | `docs/09_RUNBOOK.md`                                                                            |
| What are the agents?                     | `docs/01_...md` (Section 1.4) and `apps/marketing/src/app/agents/page.tsx`                      |
| What does the control library look like? | `packages/control-library/src/controls.ts`                                                      |
| How does the approval engine work?       | `packages/approval-engine/src/index.ts` + `services/agent-runtime/src/axiom/approval_engine.py` |
| How does the audit ledger work?          | `infra/supabase/migrations/0005_approvals_ledger.sql` + `packages/ledger/src/append.ts`         |
| How does evidence sealing work?          | `packages/evidence/src/index.ts` + `infra/terraform/envs/prod/s3.tf`                            |
| How does the model gateway decide?       | `services/model-gateway/src/model_gateway/router.py`                                            |
| How do the E2E tests work?               | `tests/e2e/tests/*.spec.ts`                                                                     |
| What is the architectural segregation?   | `.agents/skills/proof-architecture-segregation/SKILL.md`                                        |
