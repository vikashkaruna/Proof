---
classification: shared
---

# Local development quickstart

All values below are placeholders; never commit real credentials.

```bash
pnpm install --frozen-lockfile     # JS workspace (pnpm + Turborepo)
pnpm build                         # build everything
pnpm test                          # TypeScript unit tests (Vitest)
pnpm lint && pnpm format:check
cd services/agent-runtime && uv sync --extra dev && uv run pytest
```

Python services (`agent-runtime`, `model-gateway`, `temporal-workers`) are
managed with `uv`; each has its own lockfile and `uv run pytest`.

## Git workflow

1. Work on a feature branch; keep commits focused.
2. Push the feature branch; CI must be green on the exact commit.
3. Merge the green feature branch to `staging`; promote `staging` to `main`
   only on explicit owner instruction.
4. Git hooks (Husky) run a security scan on push and a confidentiality guard on
   commit. Do not bypass them with `--no-verify`.

## Before committing documentation

- Shared documents start with `classification: shared` and use placeholders.
- Anything operational or confidential belongs in the git-ignored
  `docs/private-docs/` or `docs/private-plans/` folders.
- Run `bash scripts/guard-private-docs.sh --staged` and
  `python3 scripts/check-doc-names.py`.
