# Revision 118 — PyJWT security lock correction (2026-09-30)

## Trigger and change

Revision 117 / [PR #116](https://github.com/vikashkaruna/Proof/pull/116) merged at `0b1f57adff20a13e7f08245b9cd4505e210720ff`. Its PR gate was green, as were the exact-staging feature, provider, browser, container, migration, Bandit, Trivy and Semgrep checks. The exact-staging CI Security scan then reported a newly known CVE-2026-101918 in locked `PyJWT 2.14.0`, with `2.15.0` as the minimum fixed version. The earlier `urllib3` findings were gone. Revision 117 therefore did not complete the overall staging gate.

The agent-runtime and temporal-workers locks now select `PyJWT 2.15.1`, the current published patch release beyond the scanner's minimum fixed version. No other dependency moved. This is a lockfile-only correction; authentication behavior must still be validated by the service and full-stack suites.

## Verification

- Agent-runtime `uv run --locked pytest -q`: **339 passed**. Temporal-workers `uv sync --locked --extra dev` then `uv run --locked pytest -q`: **149 passed**. An initial temporal test attempt used the system pytest without the service's dev environment and failed collection; the corrected service environment passed the full suite.
- Fresh `pnpm security:scan` passed Bandit, ESLint, production pnpm audit and all Python locked-dependency `pip-audit` checks, with no known vulnerabilities. Its first attempt timed out reading PyPI, then the complete retry passed; the timeout was not counted as a scan result.
- Corrective PR and exact-staging CI/security are still required. W8, W9, W10 and deployed acceptance remain open.
