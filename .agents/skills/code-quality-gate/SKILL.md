---
name: code-quality-gate
description: Proactive code quality, type-safety, control parity, and test coverage standards for Axiom Proof to ensure zero regressions across CI pipelines.
---

# Code Quality Gate & Verification Skill

This skill outlines the quality requirements, automated checks, and proactive validation practices required for all code written for the Axiom Proof platform.

---

## 1. Quality Standards & Engineering Invariants

1. **TypeScript Strictness**:
   - Strict mode is enabled monorepo-wide.
   - `any` is strictly prohibited. Use explicit types, branded ID types (`TenantId`, `ReportId`, `ApprovalId`), or Zod schemas.
   - All runtime inputs from HTTP, queues, or databases must be validated with Zod before being consumed.

2. **Python Strictness**:
   - Python 3.11+, Pydantic v2 for data structures and settings.
   - Use `structlog` for structured logging; never log raw customer PII.
   - The planning agent (Sudhaar) holds `can_mutate = False` (ADR-3, separation of duties).

3. **DPDPA Control Library Invariant**:
   - Once a control exists, it is immutable in the database.
   - All control counts across TypeScript, Python, and documentation must match exactly (verified by `check-control-count.sh`).
   - The agent runtime's JSON mirror (`services/agent-runtime/src/axiom/control_library_loader.py`) must be byte-for-byte in sync with `packages/control-library/src/controls.ts` (verified by `check-controls-drift.sh`).

4. **Append-Only Audit Ledger**:
   - All state mutations must be recorded through `append_ledger()`.
   - Never update or delete ledger rows.

---

## 2. Proactive Quality Checklist Before Commit

Run the following checks locally before submitting changes:

```bash
# 1. Format check
pnpm format:check

# 2. Lint monorepo
pnpm lint

# 3. Type check all TypeScript packages and services
pnpm typecheck

# 4. Control library integrity and drift checks
pnpm gate:controls
pnpm gate:controls:drift

# 5. TypeScript unit and integration tests
pnpm test

# 6. Python agent runtime tests
cd services/agent-runtime && uv run pytest

# 7. Model gateway and temporal workers tests
cd ../model-gateway && uv run pytest
cd ../temporal-workers && uv run pytest
```

If controls were modified or updated in TypeScript, always re-generate the JSON mirror for the Python runtime:

```bash
pnpm build:controls-json
```

---

## 3. Browser & Container Acceptance Best Practices

1. **E2E Assertions & Async Headroom**:
   - In Playwright journeys, avoid rigid tight timeouts (e.g. 5000ms) on dynamic server-rendered pages where Next.js compiles routes on demand.
   - Playwright config sets `expect: { timeout: 15_000 }` to give asynchronous database queries and API state transitions adequate headroom under CI conditions.

2. **Docker Multi-Stage Efficiency**:
   - Do NOT run redundant filesystem modification commands (such as `RUN chown -R node:node /app`) in runtime stages if `COPY --chown=node:node` is already in place. Redundant recursive chown commands create massive Docker layers, duplicate disk usage, and exhaust GitHub runner storage.
   - Always run Alpine with `tini` as init process to handle signal forwarding and orphan reaping.

3. **Strict Parity Testing**:
   - Browser persona journeys test against real GoTrue accounts with real TOTP MFA encryption rings (`AXIOM_MFA_ENCRYPTION_KEY`). Never re-introduce bypass flags or bypass cookies (`AXIOM_E2E_BYPASS_AUTH`).

---

## 4. Linter & Toolchain Version Isolation Invariants

1. **ESLint 9 vs 10 (`eslint-config-next` compatibility)**:
   - Next.js 16 and `eslint-config-next` depend on ESLint 9 API semantics.
   - Upgrading `eslint` to v10 causes `TypeError: scopeManager.addGlobals is not a function`.
   - `eslint` must be pinned to v9 (`9.39.0`) in `@axiom/eslint-config` until Next.js updates `eslint-config-next` for ESLint 10.
   - Dependabot is configured to ignore `eslint` semver-major updates in `.github/dependabot.yml`.

2. **TypeScript 6 vs 7 (`typescript-eslint` compatibility)**:
   - Monorepo builds on TypeScript 7.
   - `typescript-eslint` (v8.70) hard-throws on TypeScript 7 compiler APIs (`Error: typescript-eslint does not support TS 7.0`).
   - The `@axiom/eslint-config` package implements Microsoft's side-by-side arrangement: it isolates `typescript: 6.0.3` in its own dependency tree so `axiom-lint` executes cleanly while `tsc` and every workspace package build on TS 7.
   - Never bump `typescript` to 7 inside `packages/eslint-config/package.json`. Dependabot is configured to ignore `typescript` semver-major updates in `.github/dependabot.yml`.

3. **Tailwind CSS 3 vs 4 (`postcss` compatibility)**:
   - Tailwind CSS v4 dropped direct PostCSS plugin support (requiring `@tailwindcss/postcss`).
   - Upgrading `tailwindcss` to v4 without migrating `globals.css` and `postcss.config.cjs` causes Turbopack Next.js build failure.
   - Dependabot is configured to ignore `tailwindcss` semver-major updates in `.github/dependabot.yml`.
