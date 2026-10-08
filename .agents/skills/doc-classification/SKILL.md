---
name: doc-classification
description: Decide where a document belongs (docs/private-docs, docs/private-plans or docs/shared-docs), name it correctly, and keep confidential operator material out of git. Use whenever creating, moving, renaming or editing anything under docs/, writing deployment, configuration, architecture, requirements, runbook, testing or plan content, or before committing documentation.
---

# Doc classification, placement and naming

One rule: **if in doubt, it is private.** The authoritative map and naming
convention is the tracked `docs/README.md`; read it before creating a file.

## Zones

| Zone    | Path                  | Git                                 | Holds                                                                                                                                                                          |
| ------- | --------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Private | `docs/private-docs/`  | **ignored** (only `README.md` kept) | operator config and deployment guides, architecture, integrations and dataflow, requirements, security review, testing guides, status and session log, audits, persona manuals |
| Private | `docs/private-plans/` | **ignored** (only `README.md` kept) | implementation plans, phase plans, roadmaps                                                                                                                                    |
| Shared  | `docs/shared-docs/`   | tracked                             | product overview, local development quickstart, documentation conventions. Starts with `classification: shared`; placeholders only                                             |

Private signals: real hostnames, IPs, regions, cloud accounts, tenant or
customer names, vendor contracts, key or secret **values or locations**,
internal topology, attack-aiding failure modes, pricing, unreleased plans,
credentials of any kind.

## Placement and naming (module codes 00-13 are in docs/README.md)

| What               | Where and name                                             |
| ------------------ | ---------------------------------------------------------- |
| Operator guide     | `private-docs/operator/OPS-<MM>-<module-slug>.md`          |
| Test guide / suite | `private-docs/testing/TEST-<MM>-<module-slug>.md`          |
| Architecture       | `private-docs/architecture/ARCH-<NN>-<slug>.md`            |
| Requirements       | `private-docs/requirements/REQ-<NN>-<slug>.md`             |
| Security           | `private-docs/security/SEC-<NN>-<slug>.md`                 |
| Audit              | `private-docs/audits/AUD-<YYYYMMDD>-<NNN>-<slug>.md`       |
| Session log        | `private-docs/status/STATUS-session-log.md` (the only one) |
| Plan               | `private-plans/PLAN-<NN>-<slug>.md`                        |

Extend the existing module file; never fork per revision, session, handoff,
brief or runbook. Each folder has an `INDEX.md`; add a row when you add a file.

## Procedure

1. Classify before writing; private if any private signal applies.
2. Choose the module code and file by the table; extend it in place.
3. Operator procedures use the five labels: **What (purpose)**, **Why
   (reason)**, **How (steps)**, **Expected output**, **Confirm (validation)**.
4. Shared docs: add `classification: shared`; use `<PLACEHOLDER>` values.
5. Never `git add -f`, never `--no-verify`. If a guard blocks you, move the
   content; do not bypass.
6. Before committing documentation run `bash scripts/guard-private-docs.sh
--staged`, `bash scripts/check-private-docs.sh` and
   `python3 scripts/check-doc-names.py`.

## Enforcement already in place

- `.gitignore` allow-list: only `docs/README.md`, the two private READMEs and
  `docs/shared-docs/` can be tracked.
- `.husky/pre-commit` runs `scripts/guard-private-docs.sh --staged`.
- CI job "Maintenance regressions and ignored documentation" runs
  `scripts/check-private-docs.sh` and the guard tests.
- `.claude/hooks/block_private_leak.py` blocks forced adds, `--no-verify`,
  secret-looking doc writes, unmarked shared docs and badly named private files.

## Limits

- Ignoring does not remove history; earlier commits keep earlier files until a
  coordinated purge.
- Ignored files do not travel: new clones and worktrees start without private
  docs. Restore from the encrypted private backup
  (`~/.axiom-proof-private/documentation/`).
