# Axiom Proof — Complete Strategy & Build Document Set

### Axiom Minds Private Limited · https://axiomminds.ai

**Compiled:** August 2026

**Implementation status.** W0, W1 and W2 are **partial**; migration allocation runs
through 0031. Nothing has been deployed, no evidence bucket is locked and no action
has executed against a client estate — the earlier Phase 3 _audit_ completion was
not completion of the Phase 3 product. Start with
[Doc 11](11_Phase0-5_Gap_Closure_Plan.md), whose newest revision section is the
current checkpoint and whose workstream status register carries W0–W10, then
[Doc 14 implementation progress](14_Implementation_Progress.md)
and [Doc 15 session handoff](15_Session_Handoff.md), which names the staging head
this all rests on. The most recent reviews are
[audit 11](audits/11-w1-authenticator-replacement-review-2026-09-21.md) and
[audit 12](audits/12-w1-revocation-quarantine-review-2026-09-21.md). Doc 12 is a
historical snapshot kept for its design reasoning; do not resume from it.

_This block deliberately names no revision number or commit. It was four revisions
stale when that was tried, because every merge invalidates both and nobody updates
the index. Doc 11's own header and Doc 15 carry those, and are edited by the work
that changes them._

---

## Document index

| #         | Document                                                         | Contents                                                                                                                                                                                                                                                                                                                                   | Use it for                                                                                                      |
| --------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| **00**    | `00_README_Document_Index.md`                                    | This file                                                                                                                                                                                                                                                                                                                                  | Orientation                                                                                                     |
| **01**    | `01_Product_Naming_Branding_and_GTM.md`                          | Product name options + recommendation, agent roster, brand guidelines (colour, type, logo, tone), positioning, messaging, 3-channel GTM, launch sequence, materials checklist, objection handling                                                                                                                                          | Naming decision, brand build, website copy, sales conversations                                                 |
| **02**    | `02_Phase_Wise_Implementation_Plan.md`                           | Agentic autonomy ladder (L0–L4), Phases 0–5 with every module and feature, build sequence, 49-module master index, critical path and dependency graph                                                                                                                                                                                      | Build planning, sprint sequencing, what to build next                                                           |
| **03**    | `03_BRD_PRD.md`                                                  | Business context, objectives, scope, stakeholders, business rules, personas, user journeys, 13 functional requirement groups, non-functional requirements, constraints, risks, acceptance criteria                                                                                                                                         | Handing to a developer/contractor, defining "done", scoping                                                     |
| **04**    | `04_Solution_Architecture.md`                                    | 4-layer architecture (Experience / API / Agentic Middle / Data), control plane vs data plane, agent runtime and permissions, execution safety chain, audit ledger schema, tenancy, deployment evolution, 10 ADRs                                                                                                                           | Technical build, architecture decisions, future engineering hires                                               |
| **05**    | `05_Technology_Stack_Analysis.md`                                | Vendor & framework selection resolving Doc 04's open "or"s (API language, orchestration), specific India-region hosting per layer, the LLM-residency finding that shapes the Model Gateway, docs/help-site choice. **Vendor picks in §5/§7/§8 superseded by Doc 06.**                                                                      | Vendor sign-up, infra provisioning, resolving "which specific tool" questions Doc 04 left open                  |
| **06**    | `06_Infrastructure_and_Lockin_Strategy.md`                       | Single-CSP consolidation analysis (AWS vs GCP vs Azure), lock-in scoring per service, Supabase/S3/Redis/compute alternatives, hybrid self-hosted + hosted LLM strategy, on-prem trade-off                                                                                                                                                  | Choosing the actual CSP and deploy targets, evaluating "no lock-in" trade-offs before signing up for any vendor |
| **10**    | `10_Systems_Map.html`                                            | Five grounded diagram views of the running system: the non-technical five-stage loop, the layered stack with real ports/services, a top-down module map read from the actual monorepo, the agent/subagent separation-of-duties wall (ADR-2/ADR-3), and the execution safety chain with its shared ledger rail. Open directly in a browser. | Onboarding a new engineer or stakeholder, a quick visual gut-check against the current codebase                 |
| **Audit** | `audits/README.md` and numbered reports                          | Evidence-backed repository baseline, security, module coverage, and Phase 3 quality review                                                                                                                                                                                                                                                 | Current implementation status, fixed findings, and external TODOs                                               |
| **11**    | [Phase 0–5 Gap Closure Plan](11_Phase0-5_Gap_Closure_Plan.md)    | Numbered revisions, newest first; the top one is current. Findings, scope and closure packages                                                                                                                                                                                                                                             | Prioritise implementation without losing intentional roadmap additions                                          |
| **12**    | [Implementation Handoff](12_Implementation_Handoff.md)           | The 20 September design snapshot: commits, worktree, WIP and acceptance gates as they stood then. **Historical — its commit tables and workspace paths are now wrong.**                                                                                                                                                                    | Design reasoning behind the closure work, not resumption                                                        |
| **13**    | [Roadmap Traceability](13_Roadmap_Traceability.md)               | Every phase module, BR/FR family and NFR mapped to closure work                                                                                                                                                                                                                                                                            | Prevent roadmap omissions and unsupported completion claims                                                     |
| **14**    | [Implementation Progress](14_Implementation_Progress.md)         | Milestone-by-milestone delivery record: commit SHA, CI run, what was verified, and what each milestone explicitly does **not** prove                                                                                                                                                                                                       | Establishing what is actually built and evidenced                                                               |
| **15**    | [Session Handoff](15_Session_Handoff.md)                         | The current resume baseline: workspace, standing decisions, next implementation sequence, founder decisions still open, and operational state of the local test stacks                                                                                                                                                                     | Resuming implementation in a new session                                                                        |
| **16**    | [Operator Completion Runbook](16_Operator_Completion_Runbook.md) | W0–W3 only: the ordered steps the **operator** runs to configure, deploy and test, what evidence to return, and what Claude does with that evidence to move a status. Names one owner per item and never mixes them                                                                                                                        | Taking W0–W3 from "code complete" to "proven in a deployed environment"                                         |
| **—**     | `DPDPA_Axiom_Minds_Strategic_Roadmap.md`                         | Market sizing (TAM/SAM/SOM), competitive landscape, right-to-win, pricing, cash-flow model, revenue projections, risk register, council deliberation log                                                                                                                                                                                   | Strategic context, investor conversation (if ever), market positioning                                          |

---

## The core idea in one paragraph

**Axiom Proof** is an agentic DPDPA compliance platform from Axiom Minds Private Limited. AI agents discover personal data across a client's systems, classify it, assess it against a versioned control library mapped to the DPDP Act and Rules, collect and seal evidence, generate reports, and propose prioritised remediation plans — each with a dry-run diff preview and a generated rollback plan. **A human reviews and approves**, individually or in batches. Only then do agents execute, with blast-radius caps, per-action approval-token validation, pre/post state capture, post-execution verification, and an append-only hash-chained audit ledger recording every action by both agents and humans. The company is bootstrapped: a solo founder plus agents, with hiring and certifications triggered by realised revenue rather than a funding calendar.

---

## The recommended name

> ### ✅ **Axiom Proof** — _by Axiom Minds_
>
> _"Agents do the work. You approve. The proof is automatic."_

Full rationale in Document 01. Backup name: **ProofPlane**. Trademark filing recommended in Phase 0 (Classes 42 and 45, ~₹15–25k).

---

## The agent roster

| Agent          | Function                                                                              |
| -------------- | ------------------------------------------------------------------------------------- |
| **Drishti**    | Discovery — finds personal data (batch or targeted)                                   |
| **Vibhaag**    | Classification — categorises by DPDPA type and sensitivity                            |
| **Parikshan**  | Assessment — scores against the control library                                       |
| **Saakshi**    | Evidence — collects, timestamps, seals                                                |
| **Sudhaar**    | Remediation planning — proposes fixes with rollback plans (holds **no** write access) |
| **Karya**      | Execution — executes approved actions only (batch or individual)                      |
| **Lekha**      | Audit — writes the immutable hash-chained ledger                                      |
| **Nazar**      | Regulatory watch — monitors MeitY/DPB/gazette                                         |
| **Prativedan** | Reporting — Board, auditor and DPB-ready documents                                    |
| **Sanket**     | Market signal — buying-intent intelligence (internal GTM)                             |

---

## The non-negotiable safety rules

These appear in every document and must never be relaxed:

1. **No mutating agent action executes without recorded human approval.** Enforced architecturally via signed, scope-bound approval tokens validated per action — not by convention.
2. **Every executable action must have a completed dry-run with a readable diff preview before approval is even possible.**
3. **Every action must carry a generated, validated rollback plan, created at planning time.**
4. **Every action — read or write, agent or human — is written to the append-only, hash-chained audit ledger.**
5. **The planning agent holds no write credentials.** Separation of duties between proposing and executing.
6. **Blast-radius caps are enforced pre-flight and in-flight**, with a global kill switch.

---

## Suggested reading order

**If you are deciding the name and brand:** 01
**If you are about to start building:** 02 → 03 → 04
**If you are explaining the business to someone:** Strategic Roadmap → 01
**If you are briefing a contractor or future hire:** 03 → 04 → 02

---

## Immediate next actions (first 30 days)

- [ ] Confirm product name; file trademark for AXIOM PROOF (Classes 42, 45)
- [ ] Complete incorporation of Axiom Minds Private Limited
- [ ] Stand up `axiomminds.ai` with positioning, product page and gap-scan waitlist
- [ ] Build Control Library v0 — decompose DPDPA + Rules into 46 testable controls
- [ ] Build Parikshan v0 (assessment) + Prativedan v0 (reporting) + public gap-scan
- [ ] Begin LinkedIn content cadence
- [ ] Open 10 first conversations in the founder network
