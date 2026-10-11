---
name: axiom-docs-increment
description: Incremental documentation discipline for Axiom Proof. Use at every checkpoint (merge, milestone, handoff, operator step) to record a session by PREPENDING an entry to docs/private-docs/status/STATUS-session-log.md and updating the plan, current status and the module operator and test guides, instead of creating new handoff, progress, session or runbook files.
---

# Axiom Docs Increment Skill

All working documentation is private and lives under `docs/private-docs/` and
`docs/private-plans/` (git-ignored). Layout, module codes and naming are in the
tracked `docs/README.md`; placement rules are in the `doc-classification`
skill. Agents **extend** existing files and never fork them.

| Doc                                                    | Purpose                                              | How you change it                                                                                        |
| ------------------------------------------------------ | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `docs/private-docs/status/STATUS-session-log.md`       | The single session, progress and handoff log         | **Prepend** a dated entry directly under the newest-first marker; never edit older entries               |
| `docs/private-docs/status/STATUS-current.md`           | Verified current state: SHAs, branches, blockers     | Refresh in place at each checkpoint                                                                      |
| `docs/private-plans/PLAN-20-master-plan.md`            | Scope, workstreams W0-W12, status table, open items  | Edit the status table and open discrepancies only; change scope only on an explicit user decision        |
| `docs/private-docs/operator/OPS-<MM>-<module-slug>.md` | Per-module operator procedures (what/why/how/output) | Edit the affected procedure in place; add a new `OPS-<MM>.<n>` procedure when a new operator step exists |
| `docs/private-docs/testing/TEST-<MM>-<module-slug>.md` | Per-module manual cases and automated suite map      | Edit in place; keep case IDs stable                                                                      |
| `docs/private-docs/architecture/ARCH-*.md`             | Architecture and flow                                | Edit only when architecture or flow genuinely changes                                                    |

## Hard rules

1. **Never create** a new handoff, progress, session, brief, status or
   runbook file (no `*Handoff*`, `*Progress*`, `*Session*`, `*Brief*`,
   `*Runbook*`, no per-revision copies). One session log, newest first.
2. **Never invent facts.** Record only verified results: exact command or CI
   run, the exact SHA copied from `git` or the CI page (never from memory),
   counts as printed, and what the result does **not** prove. If a source and
   a newer fact conflict, add a line to the plan's open discrepancies instead
   of choosing silently.
3. **Status words are earned.** A workstream is Closed only when its closure
   evidence is recorded in the session log. Local Docker parity and green PR
   checks are engineering evidence, not deployment or release clearance.
   Withdrawn claims are never restored.
4. Hard rules in `AGENTS.md` are untouched by documentation work: approval
   gate, Sudhaar read-only, append-only ledger, Object Lock Compliance, Mumbai
   residency (AWS `ap-south-1` prod / GCP `asia-south1` preprod). Never write secrets, `.env` contents or private
   target or persona state into any document, shared or private.

## Checkpoint procedure (every merge, milestone or handoff)

1. **Verify first.** Run the relevant commands; for a merge, confirm CI and
   security results on the **exact merge SHA**.
2. **Prepend to `STATUS-session-log.md`**, directly under the exact line
   `<!-- NEWEST SESSION ENTRIES GO BELOW THIS LINE -->`: `### YYYY-MM-DD HH:MM
UTC - Revision/PR - title`, then bullets: what changed, evidence (SHAs, run
   IDs, counts) and "Not proven". Add a row to the index table at the top.
3. **Refresh `STATUS-current.md`** (staging and main SHAs, local-only
   branches, blockers) and the plan's status table in the same change; keep
   them identical in meaning.
4. **Update the module guides.** For each module touched, edit its `OPS-<MM>`
   procedures (what, why, how, expected output, confirm) and `TEST-<MM>` cases
   so they describe the shipped behaviour; tick a confirmation only with linked
   closure evidence.
5. **Re-point cross-references** when you rename or move anything: search for
   old names, fix links, update the `INDEX.md` of each touched folder and the
   `AGENTS.md` "Where to look" table.
6. **Run the checks:** `python3 scripts/check-doc-names.py`,
   `bash scripts/check-private-docs.sh`, `bash scripts/guard-private-docs.sh
--staged`. The control-count gate (`scripts/check-control-count.sh`) scans
   markdown for "<number> controls", so use the canonical count or add an
   `axiom-count-ok` marker comment for unrelated counts.
7. Keep all documents in the ignored zones; do not stage them. Commit only
   code, tooling, ignore rules and the tracked READMEs and shared docs, with a
   `docs:` message for documentation-maintenance changes. Refresh the private
   backup under `~/.axiom-proof-private/documentation/`. Do not push, open PRs
   or merge unless the user asked.

## Local Docker rule to preserve in docs

Teardown scripts must not remove local database containers or volumes by
default; full removal only through an explicit flag. Say so in
`OPS-00-platform-ops.md` whenever you touch teardown guidance.

Session chronology: locate the insertion marker as an exact standalone line, never by substring (instructions may quote it). Keep timed entries newest first within each day, with explicit UTC. Preserve historical date-only entries without inventing a time. Run the chronology checker after every prepend.
