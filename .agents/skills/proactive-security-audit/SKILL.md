---
name: proactive-security-audit
description: Proactive code quality and multi-layer security auditing (Bandit, Semgrep, Trivy, pip-audit, pnpm audit, gitleaks, CodeQL parity) for Axiom Proof to eliminate CI scan failures before push.
---

# Proactive Security & Vulnerability Audit Skill

This skill guides agents and engineers in proactively inspecting, diagnosing, and remediating security vulnerabilities and code quality issues across all tiers of the Axiom Proof repository before pushing code to GitHub.

---

## 1. Security Architecture & Threat Matrix

Axiom Proof processes highly sensitive personal data and compliance evidence under India's Digital Personal Data Protection Act (DPDPA). Security scans in CI are hard quality gates that reject non-compliant code:

| Layer              | Scanner / Engine                  | Targets                                                                         | CI Gate & Threshold                                                  | Local Command                          |
| ------------------ | --------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------- |
| **Python SAST**    | **Bandit** (v1.9+)                | `services/agent-runtime`, `services/model-gateway`, `services/temporal-workers` | `MEDIUM+` severity for services; `HIGH` for repo                     | `pnpm security:scan` or `uvx bandit`   |
| **Node / TS Deps** | **pnpm audit**                    | `apps/*`, `packages/*`, `services/bff`                                          | Zero `HIGH` or `CRITICAL` production vulnerabilities                 | `pnpm audit --prod --audit-level=high` |
| **Python Deps**    | **pip-audit**                     | `services/*/pyproject.toml`                                                     | Zero vulnerabilities in locked dependencies                          | `uv export ... \| uvx pip-audit`       |
| **SAST / Rules**   | **Semgrep**                       | Monorepo JS/TS, Python, Dockerfiles                                             | Zero high-severity rule violations                                   | `semgrep scan`                         |
| **Container & FS** | **Trivy**                         | Root filesystem, Dockerfiles, packages                                          | Zero `HIGH` or `CRITICAL` CVEs                                       | `trivy fs . --severity CRITICAL,HIGH`  |
| **Secrets Leak**   | **gitleaks**                      | Git commits, unpushed revisions                                                 | Zero unexempted credentials or tokens                                | `gitleaks git . --redact`              |
| **CodeQL Parity**  | **ESLint** (@axiom/eslint-config) | Client & server TypeScript                                                      | Insecure randomness (`Math.random`), URL hostname substring matching | `pnpm turbo run lint`                  |

---

## 2. Standard Pre-Push Security Verification

Always run the unified local security scanner before opening a PR or pushing to `main` / `staging`:

```bash
# 1. Run full security scan (Bandit + Gitleaks + ESLint CodeQL parity)
pnpm security:scan

# 2. Audit Node/TypeScript production dependencies
pnpm audit --prod --audit-level=high

# 3. Audit locked Python dependencies across all services
for service in agent-runtime temporal-workers model-gateway; do
  uv export --locked --no-dev --no-emit-project --project "services/$service" --output-file "/tmp/$service-requirements.txt"
  uvx --python 3.11 pip-audit==2.10.1 --strict --disable-pip --no-deps -r "/tmp/$service-requirements.txt"
done

# 4. Optional: Run Trivy filesystem audit if installed locally
if command -v trivy >/dev/null 2>&1; then
  trivy fs . --severity CRITICAL,HIGH --exit-code 1
fi
```

---

## 3. Remediating Common Scanner Findings

### A. Bandit (Python Security Linter)

- **B101 (`assert_used`)**:
  - _Risk_: Python bytecode optimization (`python -O`) removes `assert` statements, neutralizing security validations in production.
  - _Rule_: Never use `assert` for permission checks, input validations, or runtime constraints in production code. Raise explicit exceptions (`ValueError`, `PermissionError`, `SecurityViolationError`).
  - _Exception_: Pytest test suites (`tests/`) are excluded via `.bandit`.

- **B105 / B106 / B107 (`hardcoded_password_string`)**:
  - _Risk_: Static secret or token strings in code.
  - _Rule_: Read from environment variables via Pydantic Settings (`axiom.config.Settings`). In test mocks, use dedicated fixture generators.

- **B311 (`random`)**:
  - _Risk_: Non-cryptographic pseudo-random number generators (`random.choice`, `random.random`) used for tokens or IDs.
  - _Rule_: Use `secrets.choice`, `secrets.token_hex`, or `uuid.uuid4()`.

- **B506 (`yaml_load`)**:
  - _Risk_: Arbitrary code execution via `yaml.load()`.
  - _Rule_: Always use `yaml.safe_load()`.

- **B603 / B607 (`subprocess_without_shell_equals_true`)**:
  - _Risk_: Command injection or untrusted executable resolution.
  - _Rule_: When invoking external commands (e.g. Spire agent, Docker CLI), use explicit, absolute executable paths or constant argv tuples, validate arguments with regex/schemas, and use justified `# nosec B603` / `# nosec B607` comments explaining why argv is trusted.

### B. Node & TypeScript Security (ESLint & CodeQL Parity)

- **Insecure Randomness (CWE-338)**:
  - Never use `Math.random()` for UUIDs, session keys, tokens, or security decisions.
  - Use `crypto.randomUUID()` or Web Crypto API (`window.crypto.getRandomValues`).

- **URL Host Matching (CWE-20)**:
  - Do NOT match hostnames using substring checks:
    ```ts
    // BAD (matches attacker-gcs.com)
    url.includes('storage.googleapis.com')

    // GOOD (strict parsed host validation)
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' && parsed.hostname === 'storage.googleapis.com') { ... }
    ```

### C. Dependency Management & Vulnerabilities

- **Major Version Guard**:
  - Do NOT blindly upgrade major framework dependencies (e.g., Tailwind CSS v3 to v4, Next.js majors) via Dependabot without reading migration guides and verifying PostCSS/CSS build pipelines.
  - In `.github/dependabot.yml`, lock or ignore breaking major versions until migration is scheduled.

- **Audit Resolution**:
  - If `pnpm audit` reports a high-severity vulnerability in a transitive dependency, use `pnpm.overrides` in the root `package.json` to pin the patched version.

---

## 4. GitHub Actions CI Configuration Rules

1. **Graceful SARIF Uploads**:
   - If GitHub Code Scanning / Advanced Security is not enabled for the repository, `github/codeql-action/upload-sarif` will return HTTP 403.
   - Always set `continue-on-error: true` on `upload-sarif` steps and pair them with `actions/upload-artifact@v4` so SARIF reports are archived and accessible to developers and auditors regardless of repo licensing.

2. **Runner Disk Space Management**:
   - Building multiple Docker images alongside Supabase and Playwright consumes substantial disk space on GitHub Actions Ubuntu runners.
   - Run a disk-clearing step before Docker-heavy jobs:
     ```bash
     sudo rm -rf /usr/share/dotnet /usr/local/lib/android /opt/ghc /opt/hostedtoolcache/CodeQL || true
     ```
   - Avoid creating duplicate Docker image layers (e.g., avoid `RUN chown -R` after `COPY --chown`).
