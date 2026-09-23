# Axiom Proof — roadmap traceability and delivery status

> **This matrix is a 20 September snapshot and is not the current status.** It
> maps every phase-table module in Doc 02 to a closure owner, which nothing else
> does, so it is kept for that mapping. For what is actually delivered now, read
> the [workstream status register in Doc 11](11_Phase0-5_Gap_Closure_Plan.md#workstream-status-register--as-at-revision-22-21-sep-2026),
> which is re-derived from the repository each checkpoint. Where the two
> disagree, the register is right.

**Review snapshot: 20 September 2026, implementation `2c54fcd` + analyst WIP.** This matrix restores coverage of every phase-table module in Doc 02 and maps it to a closure owner. It is not a production acceptance report.

**Status:** `Partial` = source foundation exists, required journey/evidence incomplete; `Pending` = intended capability not delivered (a stub or prototype does not qualify); `Gated` = roadmap demand/funding/safety condition precedes delivery; `External` = not provable from repository. `Source complete` is used only for individual committed changes in [Doc 12](12_Implementation_Handoff.md), not whole phases.

## Current delivery addendum — Revision 62 (23 September 2026)

| Roadmap scope                            | Implemented in this revision                                                                                                  | Remaining acceptance                                                                                 |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| W4.3 separate issuer/runner hosts        | Pinned, bounded host bundle; protected first installation; initialized-state-only systemd units; protected CA digest delivery | Explicit first enrollment, marker workflow, runner/observer runtime acceptance and real GCP identity |
| Persistent trust and fail-closed restart | Integrity preflight; UUID mount/service dependency; native disposable Linux mount-loss and recovery test gate                 | Deployed disk replacement, Mumbai backup/restore, operational recovery approval                      |
| W3/W4 end-to-end execution               | Existing estate/proposal, registry, assessment/controller milestones retained                                                 | Full wizard/readiness/graph, other workers, live grants, controller/scheduler deployment             |

Revision 61's verified base is `13ce160` / CI 35833267173. Revision 62 exact-merge results are recorded in the session. Prepared host files do not constitute cloud deployment or complete W4.3. Schema remains 0048 / 49 migrations / 55 tables; W2 targets remain 19/40.

## Current delivery addendum — Revision 61 (23 September 2026)

This addendum updates current implementation traceability without treating the historical phase tables below as current completion claims. Verified baseline: staging `3e505c5`, CI [35831554373](https://github.com/vikashkaruna/Proof/actions/runs/35831554373). Final Revision 61 merge evidence is recorded in the saved session.

| Roadmap / boundary                             | Current evidence                                                                                                                                                            | Still required                                                                                                                                                     |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| W4.3 workload identity and execution perimeter | Exact node/UID/image preparation, persistence and issuer-sync gate; read-only UUID/mount/state guard and explicit fresh-disk checks                                         | Supervised/pinned host install, first enrollment, mount-loss stop, CA delivery, effective cloud IAM/firewalls, deployed composition and other workers/actor chains |
| M0.3 / W3 assessment execution                 | Isolated Parikshan path, durable one-time claims and independently confirmed persistence; stale health refuses new authority while historical confirmation remains possible | Complete live onboarding/readiness journey, production acceptance and other agent workflows                                                                        |
| W4.1 / W4.2 / W4.4 connectors                  | Registry/contracts/lifecycle and vault/broker core retained; health does not create connector grants                                                                        | Live grants/UI, real connector operations and later accepted W4.5–7 scope                                                                                          |
| W3 estate and onboarding                       | Estate/inventory APIs/UI and owner/admin-reviewed proposals retained                                                                                                        | Full resumable wizard, readiness and live estate graph                                                                                                             |
| W0 / W1 / W2 and later phases                  | Existing work preserved; schema tip 0048, 49 migrations, W2 named targets 19/40                                                                                             | Earlier contact/provenance, invitation/deployed acceptance and remaining 21 W2 targets; later intentional work remains separately scoped                           |

Neither passing local SPIRE tests nor health freshness proves a cloud deployment, instant global revocation or complete W3/W4 delivery. Read [Doc 16](16_Operator_Completion_Runbook.md) before operational activation.

## Phase 0

| Module                              | Status             | Evidence / remaining delivery                                                                                              | Owner         |
| ----------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------- | ------------- |
| M0.1 Corporate & Digital Foundation | Partial / External | Marketing exists; incorporation, tax/banking, domain/trademark and commercial setup require founder evidence               | Founder; W8   |
| M0.2 Control Library v0             | Partial            | 46-control TS source corrected to 0.1.1; Python still 0.1.0, provenance publication pending                                | W7, R-06      |
| M0.3 Parikshan Assessment v0        | Partial            | Agent and tests exist; pinned-version runtime parity and reviewed live journey required                                    | W7/W3.1       |
| M0.4 Prativedan Report v0           | Partial            | JSON/HTML generator; branded PDF and released-output evidence pending                                                      | W8/W8.3       |
| M0.5 Free Gap-Scan                  | Partial            | Working source route/scoring/report/email; API-boundary, version parity, release policy and deployed acceptance unresolved | W0/W7/W8.3    |
| M0.6 Agent Workbench                | Partial            | UI and prompt tables; invocation authority and prompt/version governance incomplete                                        | W1/W3.1, R-03 |

## Phase 1

| Module                         | Status  | Evidence / remaining delivery                                                       | Owner          |
| ------------------------------ | ------- | ----------------------------------------------------------------------------------- | -------------- |
| M1.1 Drishti Discovery v0      | Partial | Interview-driven agent; persisted resumable intake and delivery journey             | W3.1           |
| M1.2 Vibhaag Classification v0 | Partial | Classification core; human correction/review queue and feedback persistence         | W3.1           |
| M1.3 RoPA Generator            | Partial | `ropa_generator.py`; persisted processing records, review/export                    | W2/W3.1/W8     |
| M1.4 Sudhaar Planner v0        | Partial | Typed planner and rollback definitions; persisted reviewed plan lifecycle           | W3.1/W5        |
| M1.5 Saakshi Evidence v0       | Partial | Evidence client/agent; actual retention and provenance proof                        | W8, R-10       |
| M1.6 Policy & Notice Generator | Partial | Generator core; drafts/versioned notices, localisation and release                  | W3.1/W8.1/W8.3 |
| M1.7 Human Review Console v0   | Partial | Remediation approval UI; general output review/reasons/founder release missing      | W8.3           |
| M1.8 Delivery Playbook Capture | Partial | `playbook.py`; persistence, time-spent capture, ranked backlog, delivery benchmarks | W3.1/W9.1      |

M1.8 exists in the phase table but is omitted from Doc 02's master index. This matrix uses phase-table IDs and includes it.

## Phase 2

| Module                        | Status  | Evidence / remaining delivery                                                                                    | Owner      |
| ----------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------- | ---------- |
| M2.1 Connector Framework v1   | Pending | Contracts, credentials, grants, health and three live families: DB, Workspace/M365, object store                 | W4         |
| M2.2 Drishti Live Discovery   | Pending | Batch/targeted real scans, scheduling, incremental/delta and load controls                                       | W3/W4/W6.1 |
| M2.3 Automated Classification | Partial | Agent/LLM path; review queue and recorded corrections                                                            | W3.1/W4    |
| M2.4 Evidence Vault v1        | Partial | Store/client and schema; WORM verification, pack assembly and exports                                            | W8         |
| M2.5 Lekha Audit Ledger v1    | Partial | Append-only/hash-chain primitives; all-path audit coverage, correlation, checkpoint/restore proof                | W5/W8/W9.1 |
| M2.6 Approval Workflow v1     | Partial | Token engine, approval route and step-up; RLS/safety transitions, bound conditions and sealed approval artifacts | W1/W5/W8.3 |
| M2.7 Multi-Format Reporting   | Partial | HTML/JSON; four report formats, PDF and artifact-level citations                                                 | W8         |
| M2.8 DSAR/Rights Tracker      | Partial | Table and UI; verified identity, server clock, fulfilment and response delivery                                  | W8.1       |
| M2.9 Nazar Regulatory Watch   | Partial | Agent and UI; source ingestion, scheduling, impact mapping, reviewed baseline delta                              | W7/W6.1    |

One initial live SQL binding is an intentional intermediate milestone. It does not satisfy the original three-connector-type Phase 2 exit.

## Phase 3 — core product

| Module                              | Status  | Evidence / remaining delivery                                                                      | Owner            |
| ----------------------------------- | ------- | -------------------------------------------------------------------------------------------------- | ---------------- |
| M3.1 Structured Remediation Planner | Partial | Typed output/rollback definitions; version/hash/dependency/cycle and connector-bound persistence   | W5               |
| M3.2 Dry-Run/Simulation             | Pending | Real simulator, readable structured diff, hash/expiry and failure refusal                          | W5               |
| M3.3 Customer Approval Console      | Partial | UI/partial selection/step-up exist; real dry-run, complete authority and sealed approval proof     | W1/W5/W8.3       |
| M3.4 Karya Execution v1             | Pending | Karya remains skipped stub; dispatch contract, batch key, durable work and approved-only execution | W2/W5, R-04/R-05 |
| M3.5 Rollback Engine                | Pending | Execute and simulate rollback, failure threshold, immediate failure escalation                     | W5               |
| M3.6 Blast-Radius Guardrails        | Partial | Planner cap and shared BFF halt state; live pre/in-flight governor and worker halt absent          | W5, R-09         |
| M3.7 Post-Execution Verification    | Pending | Re-run targeted checks and seal closure evidence; independent reconciliation                       | W5               |
| M3.8 Consent Management             | Partial | UI; purpose/notice capture, immutable history, withdrawal, seven-year product retention and EN/HI  | W8.1             |
| M3.9 Breach & Incident Ops          | Partial | Table/UI; clocks, reviewed notifications and warm forensic instrumentation                         | W8.2             |
| M3.10 Continuous Monitoring         | Pending | Restart-safe schedules, drift, alerts and monitor health                                           | W6.1             |
| M3.11 Client Portal                 | Partial | Tenant context/navigation improved; complete persona journeys, evidence/report/approval wiring     | W1/W8/W9         |

The eight PRD B.10 scenarios remain the core acceptance suite. Code-only tests and a staging rollback are necessary but do not replace the roadmap's production-client acceptance requirement.

## Phase 4

| Module                          | Status           | Evidence / remaining delivery                                                                            | Owner   |
| ------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------- | ------- |
| M4.1 Standing Approval Policies | Pending          | Human-authored, versioned, revocable boundaries and exception escalation through the existing token gate | W6.2    |
| M4.2 Multi-Regulator Reuse      | Pending          | RBI/SEBI/IRDAI/CERT-In overlays, mapping strength and reusable evidence                                  | W7      |
| M4.3 Connector Framework v2     | Pending          | CRM/HRMS/warehouse/ticketing/repository descriptor + live protocol/permission coverage                   | W4.7    |
| M4.4 Self-Serve SMB             | Pending          | Self-onboarding, entitlements, guided journey and operating support                                      | W6.3    |
| M4.5 TPRM                       | Pending          | Vendor/DPA/questionnaire/sub-processor lifecycle                                                         | W6.4    |
| M4.6 DPIA Automation            | Pending          | Guided generation, risk justification, review and export; control prose is not automation                | W6.4    |
| M4.7 Partner/White-Label        | Partial          | Shell and tenant relation; assigned-client security, management and brand workflow                       | W6.5/W8 |
| M4.8 Sectoral Pack #1           | Pending decision | Select Healthcare or BFSI before building overlay/evidence/remediation pack                              | W7      |
| M4.9 Sanket Market Signals      | Pending          | `_run()` explicitly returns empty stub output; actual sourced signals and internal delivery needed       | W6.6    |

## Phase 5

| Module                            | Status                                | Gate and remaining delivery                                                                                         | Owner         |
| --------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------- |
| M5.1 Split-Plane                  | Gated                                 | Enterprise demand + funding; actual control/data-plane separation, connectivity and failure tests                   | W10.1/W4      |
| M5.2 On-Prem/VPC                  | Pending, intentionally pulled forward | W10 accepted addition; complete appliance, air-gap operation, self-hosted model, upgrades, backup and install tests | W10           |
| M5.3 Enterprise Tier              | Partial / Gated                       | RBAC foundations only; customer login SSO/SAML, custom SLA/support; original certification gate retained            | W1/W10.1      |
| M5.4 SOC 2 Type 2 / ISO 27001     | Gated / External                      | Revenue-triggered certification programme and audit evidence; not established by CI                                 | Founder/W10.1 |
| M5.5 Sectoral Pack #2             | Gated                                 | Cash-funded second vertical; select after pack #1 evidence                                                          | W7/W10.1      |
| M5.6 Consent Manager Registration | Gated / External                      | Original capital/reserves and regulatory registration gate; distinct from building a CMP or coverage controls       | Founder/W10.1 |
| M5.7 Policy-Governed L4           | Gated                                 | Proven L3 track record and explicit policy-bound approval design; never unrestricted autonomous mutation            | W6.2/W10.1    |

## BR/FR coverage ownership

Ranges below cover **all IDs in each PRD family**, including the specific easy-to-miss clauses shown. This is an acceptance ownership map, not a claim every subclause passes.

| Requirements | Closure owner   | Required evidence                                                                                                       |
| ------------ | --------------- | ----------------------------------------------------------------------------------------------------------------------- |
| BR-1, BR-2   | W1/W5/W6.2      | No unapproved mutation; real dry-run and executable rollback; standing policy has recorded human authority              |
| BR-3, BR-5   | W5/W8           | Every read/write agent action audited; immutable evidence and append-only corrections                                   |
| BR-4         | W8.3            | Founder output release gate in Phases 0–2; resolve public gap-scan exception explicitly                                 |
| BR-6         | W0/W4/W9.1/W10  | India residency across all stores and egress; redacted provider input                                                   |
| BR-7         | W8              | Output language avoids legal opinion or compliance guarantee                                                            |
| BR-8         | Founder/W9.1    | New recurring spend covered by realised revenue; preserve phase gates                                                   |
| FR-1 (all)   | W3/W3.1/W4/W6.1 | Read-only-first, batch/targeted/incremental discovery and complete inventory metadata                                   |
| FR-2.1–2.4   | W3.1/W4         | Classification confidence/category flags, low-confidence review and human correction feedback                           |
| FR-3.1–3.5   | W7/W3.1/W6.1    | Versioned scoring, SDF, exposure, scheduled/on-demand/post-remediation assessment                                       |
| FR-4.1–4.5   | W8/W8.1         | WORM, provenance, multi-control evidence, packs and configurable retention                                              |
| FR-5.1–5.5   | W5              | Vetted typed action, owner/effort/dependencies, rollback, cycle detection and plan versioning                           |
| FR-6.1–6.4   | W5              | Diff before approval; valid expiry; failed simulation blocks approval                                                   |
| FR-7.1–7.7   | W1/W5/W8.3/W6.2 | Explicit/partial approval, conditions/identity/expiry, sealed artifact, rejection reason, standing policy               |
| FR-8.1–8.7   | W5              | Exact approved scope, concurrency/order, durable idempotency, snapshots, caps, immediate halt and environment awareness |
| FR-9.1–9.4   | W5              | On-demand/automatic rollback, dry-run/logging and immediate diagnostic escalation                                       |
| FR-10.1–10.5 | W5/W8/W9.1      | Hash-chain, complete model/prompt/input/output/approver provenance, shared correlation and independent verification     |
| FR-11.1–11.4 | W8              | Four formats, branded PDF/structured export, claim-to-artifact trace and agent/approver identity                        |
| FR-12.1–12.3 | W8.1            | DSAR fulfilment, purpose/cookie consent/withdrawal, English/Hindi                                                       |
| FR-13.1–13.4 | W8.2            | Intake/triage, notification clock, affected-principal notices and forensic evidence                                     |

## NFR acceptance register

| NFR                       | Owner         | Measurement / closure evidence                                                                     |
| ------------------------- | ------------- | -------------------------------------------------------------------------------------------------- |
| 1 Residency               | W0/W9.1/W10   | Data-flow and provider inventory incl. logs/backups/telemetry; actual region and egress assertions |
| 2 Isolation + tenant keys | W1/W2/W4/W9.1 | Direct RLS/cross-tenant FK attacks denied; per-tenant key ID, isolation, rotation/recovery proof   |
| 3 Encryption              | W0/W9.1       | TLS 1.3 and AES-256 deployment verification, not just config intent                                |
| 4 Least privilege         | W4            | Default read-only; explicit timed/revocable write scopes enforced at target and broker             |
| 5 Auditability            | W5/W8         | Failure injection cannot produce unaudited action; durable intent/completion reconciliation        |
| 6 Availability            | W9.1          | Monitoring and error-budget evidence for 99.5% Phase 3 / 99.9% Phase 5                             |
| 7 Throughput              | W4/W9.1       | 1M records/hour/connector measured with safe source load and resource/cost conditions recorded     |
| 8 Reports                 | W8/W9.1       | Standard assessment report generated in <5 minutes on representative data                          |
| 9 Recovery                | W9.1/W10      | Timed restore: RPO ≤1h, RTO ≤4h; restored ledger/evidence verify                                   |
| 10 Model portability      | W10           | Provider adapter tests and fully self-hosted model path by Phase 5                                 |
| 11 Cost                   | W9.1          | Tenant token + infrastructure attribution; alert if cost reaches 15% of ACV                        |
| 12 Explainability         | W7/W8         | Each conclusion reconstructs inputs, prompt/model/config and exact versioned clause                |

## Prototype route reconciliation

The original HTML route map remains a design artifact. These mappings avoid building duplicates when resuming:

| Prototype reference             | Current route / action                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------- |
| `/remediation`                  | `/plans` and `/plans/[id]`                                                                        |
| `/dsar`                         | `/dsars`                                                                                          |
| `/breach`                       | `/breaches`                                                                                       |
| `/policies` standing policies   | Distinguish W6 standing policies from W3.1 policy-document drafts; current shell is not an engine |
| `/estate/graph`                 | New planned W3.5 surface, not in the original 21-route prototype                                  |
| Account MFA                     | `/settings/security` and `/verify` added by W1                                                    |
| Demo tenants in wiring examples | Illustrative only; runtime switcher derives memberships                                           |

Phase exits also require commercial and operating evidence: client counts, delivery-time reductions, funded recurring costs and production-client remediation outcomes. Those remain founder-owned, not presumed missing code and not silently waived by this plan.
