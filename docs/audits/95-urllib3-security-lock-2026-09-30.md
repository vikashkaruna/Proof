# Revision 117 — urllib3 security lock correction (2026-09-30)

## Trigger and change

Revision 116 / [PR #115](https://github.com/vikashkaruna/Proof/pull/115) merged to staging at `7ffaae9e6956d5c9267a522c72eef4fcb1a6255a`. Its feature, browser, provider, container and migration jobs passed, as did separate Bandit, Trivy and Semgrep workflows. The exact-merge CI **Security scan** job failed when the current `pip-audit` advisory database reported CVE-2026-97687, CVE-2026-97688 and CVE-2026-97689 for `urllib3 2.7.0` in the agent-runtime and model-gateway locks. This means Revision 116 is not an overall green staging milestone.

Both `uv.lock` files now resolve `urllib3 2.8.0` with the publisher's package hashes. No other dependency changed. The [upstream release notes](https://github.com/urllib3/urllib3/releases/tag/2.8.0) describe the proxy TLS, unbounded chunk-size line and chunked Deflate fixes, and call out the HTTPS proxy TLS configuration behavior change. The product's direct proxy use remains subject to the existing service tests and target-specific acceptance; the lock update does not claim broader compatibility by itself.

## Verification

- `uv run --locked pytest -q`: agent-runtime **339 passed**; model-gateway **27 passed**. Each emitted one existing Starlette/httpx deprecation warning.
- Fresh `pnpm security:scan` passed Bandit, ESLint, production pnpm audit and the Python locked-dependency `pip-audit` checks with no known vulnerabilities. The local lock diff changes only `urllib3 2.7.0` to `2.8.0` in the two affected services.
- [PR #116](https://github.com/vikashkaruna/Proof/pull/116) passed its full gate and merged to staging at `0b1f57adff20a13e7f08245b9cd4505e210720ff`. Its exact-staging feature/container/browser/provider jobs and separate Bandit, Trivy and Semgrep workflows passed, and the `urllib3` advisory finding was cleared. Exact-staging CI nevertheless failed on a newly reported `PyJWT 2.14.0` advisory; [audit 96](96-pyjwt-security-lock-2026-09-30.md) records the next correction. No preprod or production deployment is claimed.
