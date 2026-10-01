---
name: axiom-docs-increment
description: Incremental documentation discipline for Axiom Proof. Use at every checkpoint (merge, milestone, handoff, operator step) to record progress by appending to docs/21_Progress.md and updating docs/20_Plan.md and docs/23_Operator_Runbook.md, instead of creating new handoff, progress, session or runbook files.
---

# Axiom Docs Increment Skill

Axiom Proof keeps exactly **four living documents** besides the numbered
reference set (`docs/00`-`09`). Agents extend them; they never fork them.

| Doc                                | Purpose                                                                             | How you change it                                                                                       |
| ---------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `docs/20_Plan.md`                  | Scope, workstreams W0-W12, status table, traceability, open discrepancies           | Edit the **status table** and "Open discrepancies" only; change scope only on an explicit user decision |
| `docs/21_Progress.md`              | Append-only progress and handoff log, plus the verified-state block                 | **Append** a dated entry at the end; refresh the status table and the "Verified current state" block    |
| `docs/22_Architecture_and_Flow.md` | Functional flow and technical architecture (links to `04_Solution_Architecture.md`) | Edit when architecture or flow genuinely changes; do not duplicate doc 04                               |
| `docs/23_Operator_Runbook.md`      | Operator to-do by priority (P0/P1/P2) and workstream, with local-Docker rules       | **Tick** items whose closure evidence exists; add items in place; never a second runbook                |

## Hard rules

1. **Never create a new handoff, progress, session, brief, status or runbook
   file** (no `docs/NN_*Handoff*.md`, `*Progress*.md`, `*Session*.md`,
   `*Runbook*.md`, no per-revision documents). Old files `11`-`19` and
   `LIVE_FUNCTIONAL_FLOW_GUIDE.md` are stubs that point to the four docs
   above. Do not put content back into them. Audit reports under
   `docs/audits/` remain the place for requirement-level review evidence (one
   numbered file per review, indexed in `docs/audits/README.md`).
2. **Never invent facts.** Record only verified results: exact command or CI
   run, the exact SHA (copy it from `git`/the CI page, never from memory),
   counts as printed, and what the result does **not** prove. If a source and
   a newer fact conflict, add a line to "Open discrepancies" in
   `20_Plan.md` instead of choosing silently.
3. **Status words are earned.** A workstream moves to Closed only when the
   closure evidence in `23_Operator_Runbook.md` (or the plan's own exit
   criteria) is recorded in `21_Progress.md`. Local Docker parity and green PR
   checks are engineering evidence, not deployment or release clearance.
   Withdrawn claims (for example the Revision 108 "W0-W10 complete") are never
   restored.
4. Hard rules in `AGENTS.md` are untouched by documentation work: approval
   gate, Sudhaar read-only, append-only ledger, Object Lock Compliance,
   `ap-south-1` residency. Never write secrets, `.env` contents or private
   target/persona state into any doc.

## Checkpoint procedure (every merge, milestone or handoff)

1. **Verify first.** Run the relevant commands; for a merge, confirm CI and
   security results on the **exact merge SHA**.
2. **Append to `docs/21_Progress.md`** (end of section 3, below the append
   marker): `### YYYY-MM-DD - Revision/PR - title`, then bullets: what changed,
   evidence (SHAs, run IDs, counts), and "Not proven". Never edit earlier
   entries; correct them with a new entry.
3. **Update the status tables** in `docs/21_Progress.md` section 1 and
   `docs/20_Plan.md` section 3 in the same commit; keep them identical in
   meaning. Refresh the "Verified current state" block (staging/main SHAs,
   local-only branches, blockers).
4. **Tick or add items** in `docs/23_Operator_Runbook.md`: tick a box only with
   linked closure evidence; add new operator actions under the right priority
   and workstream with owner, input needed, how to verify, closure evidence.
5. **Re-point cross-references.** Search for links to renamed or moved content
   (`grep -rn "docs/2[0-3]_\|Doc 2[0-3]" .`), fix stale anchors, keep
   `docs/00_README_Document_Index.md`, the `README.md` links and the
   `AGENTS.md` "Where to look" table pointing at docs 20-23, and update
   `docs/audits/README.md` when you add an audit.
6. **Format and check:** `pnpm exec prettier --check <touched files>` (fix with
   `--write`); the control-count gate (`scripts/check-control-count.sh`) scans
   markdown for "<number> controls", so use the canonical count (46) or add an
   `axiom-count-ok` marker comment for unrelated counts.
7. Commit with a `docs:` message. Do not push, open PRs or merge unless the
   user asked.

## Local Docker rule to preserve in docs

Teardown scripts must not remove local database containers or volumes by
default; full removal only through an explicit flag. Say so in
`docs/23_Operator_Runbook.md` section 1 whenever you touch teardown guidance.
