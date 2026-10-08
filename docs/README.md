# Documentation map, confidentiality policy and naming convention

This file is tracked and contains no confidential content. It defines where
documents live, what may enter Git, and how files are named.

## Three zones

| Folder                         | In Git?                                  | Audience                       | Holds                                                                                                                                                                                                               |
| ------------------------------ | ---------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`shared-docs/`](shared-docs/) | **Yes**                                  | contributors, integrators      | Product overview, local development quickstart, documentation conventions. Placeholders only: no real hostnames, tenants, keys, accounts or topology. Every file starts with `classification: shared`.              |
| `private-docs/`                | **No** (only its `README.md` is tracked) | operators and maintainers only | Operator configuration, deployment, validation and sign-off guides; complete architecture, integrations and dataflow; requirements; testing guides and suites; status and the session log; audits; persona manuals. |
| `private-plans/`               | **No** (only its `README.md` is tracked) | operators and maintainers only | Implementation plans, roadmaps and phase plans.                                                                                                                                                                     |

**Rule: if in doubt, it is private.** The `doc-classification` skill
(`.agents/skills/doc-classification/SKILL.md`) is the working procedure.

## How the boundary is enforced (defence in depth)

1. `.gitignore` ignores everything under `docs/private-docs/` and
   `docs/private-plans/` except their `README.md`, plus env, key, state and
   `*.private.md` files.
2. `.husky/pre-commit` runs `scripts/guard-private-docs.sh --staged`: blocks
   private paths, secret-bearing file names, secret-looking text in added
   documentation lines, shared docs without the marker, and (for
   private-zone files that are somehow tracked) naming violations.
3. `scripts/check-private-docs.sh` (CI job "Maintenance regressions and ignored
   documentation") fails when any private path is tracked or the ignore rules
   are missing, without reading document prose.
4. A Claude Code `PreToolUse` hook (`.claude/hooks/block_private_leak.py`)
   blocks `git add -f`, `--no-verify`, secret-looking documentation writes and
   shared documents without the marker.
5. `scripts/check-doc-names.py` validates names in the private zones locally.

## Limits

- **Git history is not rewritten.** Documents committed before this policy
  remain in earlier commits until a coordinated purge (`git filter-repo` plus
  force-push). Treat them as disclosed if the repository was ever shared.
- **Ignored files do not travel.** A fresh clone or worktree has no private
  content. Restore from the encrypted private backup; never paste private
  content into issues, pull requests, chat tools or shared docs.

## Module codes

Operator guides, test guides and plans group content by these 14 modules.
The two-digit code is part of every module-scoped file name.

| Code | Slug                       | Covers                                                                                 |
| ---- | -------------------------- | -------------------------------------------------------------------------------------- |
| 00   | `platform-ops`             | Local stack, environment, deploy targets, health, backup/restore, release, kill switch |
| 01   | `identity-access`          | Login, MFA, invitations, roles, members, security settings, sessions                   |
| 02   | `workbench-estate`         | Dashboard, workbench, estate, onboarding, engagements, setup                           |
| 03   | `connectors`               | Connectors, credential vault, OAuth broker, workload identity                          |
| 04   | `discovery-classification` | Discovery, classification, data map, public-source workflow                            |
| 05   | `assessment-controls`      | Control library, assessments, gap scan, questionnaire, human review                    |
| 06   | `reports-pramaan`          | Reports, Pramaan attestations, multi-format delivery                                   |
| 07   | `plans-approval-execution` | Remediation plans, dry-run, approval, execution, rollback, guardrails                  |
| 08   | `evidence-ledger`          | Evidence vault, retention lock, audit ledger, proof archive                            |
| 09   | `rights-consent-breach`    | DSAR, consent, breach and incident operations                                          |
| 10   | `policies-ropa`            | Policy and notice generation, RoPA                                                     |
| 11   | `monitoring-regwatch`      | Continuous monitoring, regulatory watch                                                |
| 12   | `portal-partner`           | Client portal, partner and white-label                                                 |
| 13   | `agents-ai`                | Agent runtime, model gateway, temporal workers                                         |

## Naming convention

Pattern: `<TYPE>-<scope>-<slug>.md`, lower-case kebab-case slugs, no spaces,
no revision numbers, no dates in names except audits.

| Type prefix | Zone and folder              | Name pattern                     | Example                                          |
| ----------- | ---------------------------- | -------------------------------- | ------------------------------------------------ |
| `OPS`       | `private-docs/operator/`     | `OPS-<MM>-<module-slug>.md`      | `OPS-03-connectors.md`                           |
| `TEST`      | `private-docs/testing/`      | `TEST-<MM>-<module-slug>.md`     | `TEST-05-assessment-controls.md`                 |
| `ARCH`      | `private-docs/architecture/` | `ARCH-<NN>-<slug>.md`            | `ARCH-01-solution-architecture.md`               |
| `REQ`       | `private-docs/requirements/` | `REQ-<NN>-<slug>.md`             | `REQ-01-brd-prd.md`                              |
| `SEC`       | `private-docs/security/`     | `SEC-<NN>-<slug>.md`             | `SEC-01-security-review.md`                      |
| `AUD`       | `private-docs/audits/`       | `AUD-<YYYYMMDD>-<NNN>-<slug>.md` | `AUD-20260921-007-staging-integration-review.md` |
| `HELP`      | `private-docs/help/`         | `HELP-<audience>-<slug>.md`      | `HELP-founder-manual.md`                         |
| `STATUS`    | `private-docs/status/`       | `STATUS-<slug>.md`               | `STATUS-session-log.md`, `STATUS-current.md`     |
| `PLAN`      | `private-plans/`             | `PLAN-<NN>-<slug>.md`            | `PLAN-02-phase-wise-implementation.md`           |
| `INDEX`     | any folder                   | `INDEX.md` (one per folder)      | `operator/INDEX.md`                              |
| `REF`       | `private-docs/reference/`    | `REF-<slug>.md`                  | `REF-local-checks.md`                            |
| `ARCHIVE`   | `private-docs/archive/`      | original filename preserved      | superseded stubs                                 |

Rules:

- One file per module per type. Content grows **inside** a file; never create a
  per-revision, per-session, handoff, brief or runbook copy.
- The session log is a single file, `private-docs/status/STATUS-session-log.md`,
  in **reverse chronological order**: the newest session is at the top, directly
  under the `NEWEST SESSION ENTRIES GO BELOW THIS LINE` marker.
- Every operator procedure states **What** (purpose), **Why** (reason),
  **How** (numbered steps and exact commands), **Expected output** and
  **Confirm** (the validation the operator records).
- Validate names with `python3 scripts/check-doc-names.py`.
