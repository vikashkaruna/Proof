# Axiom Proof — Business & Product Requirements Document (BRD / PRD)

### Axiom Minds Private Limited · https://axiomminds.ai

**Document:** 03 of 05 · **Version:** 1.0 · **Date:** August 2026 · **Owner:** Founder

---

# SECTION A — BUSINESS REQUIREMENTS (BRD)

## A.1 Business context

India's Digital Personal Data Protection Act, 2023 and the DPDP Rules, 2025 (G.S.R. 846(E), notified 13 November 2025) impose substantive obligations on every entity processing digital personal data in India, with full enforcement of the core obligations from **13 May 2027** and penalties up to **₹250 crore per contravention**. Indian mid-market enterprises — 200 to 1,000 employees, ₹50–500 crore revenue — are structurally the worst-served segment: they carry the same penalty exposure as large enterprises but have neither a privacy team nor the budget for ₹25 lakh-plus enterprise compliance suites, and existing sub-₹1 lakh tools address only consent banners, a single control out of forty-six.

The unsolved problem is not _knowing_ what's wrong. Roughly forty vendors will run a gap assessment, most of them free. The unsolved problem is **doing the remediation work and producing continuous, defensible proof of it** — which today is done manually by expensive consultants or not at all.

## A.2 Business objectives

| #    | Objective                                                                                                     | Measure                                                                                        |
| ---- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| BO-1 | Establish Axiom Proof as the agentic remediation-and-evidence platform for Indian mid-market DPDPA compliance | 15–30 paying clients by Month 12                                                               |
| BO-2 | Convert founder delivery capacity into software margin via agent automation                                   | ≥60% reduction in delivery hours per engagement by Month 9 vs Phase 1 baseline                 |
| BO-3 | Achieve self-funded, cash-positive operation without external capital                                         | Positive operating cash from Month 5; no external raise required                               |
| BO-4 | Build a defensible evidence moat                                                                              | Continuous evidence history that creates switching cost; ≥120% net revenue retention by Year 2 |
| BO-5 | Reach the May 2027 enforcement wave with L2 agentic execution live                                            | Execution capability in production by Month 15                                                 |

## A.3 Business scope

**In scope:** DPDPA and DPDP Rules compliance for Indian data fiduciaries; discovery, assessment, evidence, reporting, remediation planning and agent-executed remediation; virtual DPO service delivery; multi-regulator control reuse (Phase 4+).

**Out of scope (explicitly):** Consent Manager registry operation (₹2 crore net-worth barrier); GDPR/CCPA multi-jurisdiction coverage; enterprise on-premises deployment before Phase 5; legal advice or legal opinion (Axiom Proof produces compliance artifacts, not legal opinions — client counsel retains that role).

## A.4 Stakeholders

| Stakeholder                       | Interest                                              | Influence                   |
| --------------------------------- | ----------------------------------------------------- | --------------------------- |
| Founder (Axiom Minds)             | Product, delivery, GTM, all approvals                 | Total                       |
| Client compliance/legal head      | Primary user; reviews and approves agent output       | High — is the approver      |
| Client CISO/IT head               | Gatekeeper for system access and execution permission | High — can block connectors |
| Client CFO/COO                    | Economic buyer                                        | High — signs the contract   |
| Client Board / Audit Committee    | Consumer of reports                                   | Medium — drives urgency     |
| Referral partners (CA/CS/law/MSP) | Channel; may white-label                              | Medium                      |
| Data Protection Board of India    | Ultimate consumer of evidence in an inquiry           | External constraint         |

## A.5 Business rules

- **BR-1** No agent action that mutates a client system executes without recorded human approval. Architecturally enforced.
- **BR-2** Every executable action must have a completed dry-run and a generated rollback plan before approval is permitted.
- **BR-3** Every agent action — read or write — is written to an append-only, hash-chained audit ledger.
- **BR-4** All client-facing outputs in Phases 0–2 are reviewed by the founder before release.
- **BR-5** Evidence artifacts are immutable once sealed; corrections are appended, never overwritten.
- **BR-6** Client data residency is India by default; no client personal data leaves Indian infrastructure.
- **BR-7** Axiom Proof produces compliance artifacts and recommendations; it does not issue legal opinions or compliance guarantees.
- **BR-8** No recurring operating cost is incurred that is not covered by realised revenue.

## A.6 Success criteria

| Horizon  | Criterion                                                                 |
| -------- | ------------------------------------------------------------------------- |
| Month 5  | 3–5 paying clients; positive operating cash                               |
| Month 9  | 8–15 clients; delivery time down ≥60%; audit ledger live on all actions   |
| Month 12 | 15–30 clients; ₹40–90 lakh ARR-equivalent; approval console demo-able     |
| Month 18 | Agentic execution live in production; ready for May 2027 demand wave      |
| Month 30 | ₹1.5–3 crore ARR; L3 continuous compliance; first hires funded by revenue |

---

# SECTION B — PRODUCT REQUIREMENTS (PRD)

## B.1 Product vision

> Axiom Proof is an agentic compliance platform where AI agents do the compliance work — discovering personal data, assessing gaps, collecting evidence, generating reports, and proposing remediation — and a human approves before anything is executed. Every action leaves a traceable, rollback-capable, permanently auditable record.

## B.2 Personas

**P1 — Priya, Compliance Head (mid-market fintech, 400 employees).** Primary user. Has legal training, no engineering team, no privacy staff. Reports to the CFO and quarterly to the Board. Her fear: being asked "are we compliant?" and having nothing but a spreadsheet. She is the **approver** in the workflow. She needs to understand _exactly_ what an agent will change before she approves it, and she needs to be able to explain her approval to an auditor a year later.

**P2 — Rajan, CISO/IT Head (same company).** Gatekeeper. Will not grant system access without understanding blast radius, rollback and access scope. Sceptical of AI touching production. Needs read-only-first onboarding, explicit scoping, and a kill switch.

**P3 — Meera, CFO.** Economic buyer. Compares Axiom Proof's cost against an in-house DPO (₹25 lakh+) and against penalty exposure. Wants predictable pricing and Board-presentable output.

**P4 — Founder (Axiom Minds).** Supervising human across all clients in Phases 0–2. Needs high-throughput review tooling — the ability to review twenty agent outputs quickly is the difference between serving five clients and serving thirty.

**P5 — Partner (CA/CS firm).** White-label or referral. Needs multi-client visibility and branded output (Phase 4).

## B.3 Core user journeys

### UJ-1 — Assessment (Phases 0–2)

1. Client onboards; Drishti runs discovery (interview-driven in Phase 1, live-connector in Phase 2), in **batch** across the estate or **targeted** at one system.
2. Vibhaag classifies discovered data by DPDPA category, flagging children's data, sensitive categories and cross-border flows.
3. Parikshan assesses findings against the control library, scoring each of 46 controls.
4. Saakshi seals supporting evidence with timestamp and hash.
5. Prativedan generates the report; Lekha records every step.
6. **Human reviews and approves the report** before it reaches the client.

### UJ-2 — Remediation (Phase 3, the core loop)

1. Sudhaar converts each identified gap into a typed, parameterised remediation action with risk score, blast radius, dependencies and a **generated rollback plan**.
2. Dry-run engine simulates every action; produces a diff preview.
3. **Human opens the Approval Console**, reviews the plan, the diff, the blast radius and the rollback plan.
4. Human approves — **individually, or as a batch, or partially** (e.g. approve 7 of 12 actions, defer 5).
5. Karya executes only approved actions, batch or single, with configurable concurrency and stop-on-failure.
6. Post-execution verification agent re-runs the targeted checks and confirms closure.
7. Closure evidence sealed; ledger updated; report regenerated.
8. If anything fails: rollback plan executes; failure and rollback both logged.

### UJ-3 — Continuous compliance (Phase 4)

1. Human authors a standing approval policy defining which low-risk action classes may execute without per-instance approval.
2. Agents monitor continuously, re-assess on schedule, auto-remediate within policy.
3. Anything outside policy escalates to human review.
4. Human audits the ledger periodically.

## B.4 Functional requirements

### FR-1 Discovery

- FR-1.1 Agent-run discovery in **batch mode** (full estate) and **targeted mode** (single system, schema, or dataset)
- FR-1.2 Scheduled and on-demand execution
- FR-1.3 Read-only by default; write access separately and explicitly granted
- FR-1.4 Data-flow mapping including third-party processors and cross-border transfers
- FR-1.5 Incremental re-discovery with drift detection
- FR-1.6 Discovery results are evidence artifacts, sealed and hashed

### FR-2 Classification

- FR-2.1 Classify fields/records into DPDPA categories with confidence scoring
- FR-2.2 Flag children's data, sensitive categories, and data lacking lawful basis
- FR-2.3 Low-confidence classifications routed to human review queue
- FR-2.4 Human corrections captured as feedback signal

### FR-3 Assessment

- FR-3.1 Score against a versioned control library mapped to Act sections and Rules
- FR-3.2 Risk-weighted posture score with penalty-exposure estimate
- FR-3.3 SDF self-assessment
- FR-3.4 Re-assessment on demand, on schedule, and after remediation
- FR-3.5 Control library versioning — assessments record which library version they used

### FR-4 Evidence

- FR-4.1 Immutable, content-addressed evidence store (WORM semantics)
- FR-4.2 Every artifact carries source, timestamp, collecting agent, content hash
- FR-4.3 Evidence-to-control linkage; one artifact may satisfy multiple controls
- FR-4.4 Evidence pack assembly and export for auditors/DPB
- FR-4.5 Retention configurable; consent records retained 7 years minimum

### FR-5 Remediation planning

- FR-5.1 Every gap converts to one or more **typed, parameterised** actions from a vetted catalogue — never free-text
- FR-5.2 Each action carries: risk score, blast radius, effort, dependencies, owner
- FR-5.3 **Rollback plan generated for every action** — mandatory, validated as executable
- FR-5.4 Dependency-ordered sequencing with cycle detection
- FR-5.5 Plans are versioned, reviewable documents

### FR-6 Dry-run

- FR-6.1 Every executable action must complete a dry-run before approval is possible
- FR-6.2 Dry-run produces a human-readable diff preview of exactly what would change
- FR-6.3 Dry-run results expire (stale dry-runs cannot back an approval)
- FR-6.4 Dry-run failures block approval

### FR-7 Approval

- FR-7.1 Explicit human approval required before any mutating execution — **architecturally enforced, not policy-enforced**
- FR-7.2 Approval granularity: individual action, batch, or partial batch
- FR-7.3 Approver identity, timestamp, scope and any conditions recorded
- FR-7.4 Approvals expire after a configurable window
- FR-7.5 Approval artifacts are themselves sealed evidence
- FR-7.6 Rejection requires a captured reason
- FR-7.7 Standing approval policies (Phase 4) with explicit scope boundaries and escalation rules

### FR-8 Execution

- FR-8.1 Executes **only** approved actions
- FR-8.2 **Batch execution** with configurable concurrency, ordering and stop-on-failure; or **individual execution**
- FR-8.3 Idempotent — safe re-execution
- FR-8.4 Pre-state and post-state captured per action
- FR-8.5 Blast-radius caps enforced; breach triggers halt and escalation
- FR-8.6 Global kill switch, immediately effective
- FR-8.7 Production/non-production environment awareness

### FR-9 Rollback

- FR-9.1 Rollback executable on demand for any completed action
- FR-9.2 Automatic rollback on configurable failure threshold within a batch
- FR-9.3 Rollback is itself dry-run-able and fully logged
- FR-9.4 Rollback failure escalates immediately with full diagnostic capture

### FR-10 Audit & traceability

- FR-10.1 Append-only, hash-chained ledger; tamper-evident
- FR-10.2 Every entry records: acting agent, model identifier and version, prompt/config hash, inputs, outputs, human approver (where applicable), timestamp, correlation ID
- FR-10.3 Full chain reconstructable: finding → plan → dry-run → approval → execution → verification → closure
- FR-10.4 Ledger is queryable and exportable for auditors
- FR-10.5 Ledger integrity verifiable independently

### FR-11 Reporting

- FR-11.1 Board report, auditor pack, DPB-ready submission, technical remediation register
- FR-11.2 Branded, exportable (PDF and structured formats)
- FR-11.3 Every claim in a report traceable to a specific evidence artifact
- FR-11.4 Agent attribution and human approver named on every report

### FR-12 Rights & consent (Phase 3)

- FR-12.1 DSAR intake, identity verification, fulfilment tracking with statutory clock
- FR-12.2 Consent capture (cookie and purpose-based), consent ledger, withdrawal workflow
- FR-12.3 English and Hindi at launch; additional Eighth Schedule languages as demand warrants

### FR-13 Breach & incident (Phase 3)

- FR-13.1 Incident intake and triage
- FR-13.2 72-hour DPB notification workflow with countdown clock
- FR-13.3 Affected-principal notification generation
- FR-13.4 Forensic log instrumentation so the 72-hour report is answerable from warm data

## B.5 Non-functional requirements

| ID     | Requirement                                                                                         | Target                                                                    |
| ------ | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| NFR-1  | **Data residency** — all client personal data resident in India                                     | Absolute                                                                  |
| NFR-2  | **Tenant isolation** — logical isolation minimum; per-tenant encryption keys                        | Absolute                                                                  |
| NFR-3  | **Encryption** — TLS 1.3 in transit; AES-256 at rest                                                | Absolute                                                                  |
| NFR-4  | **Least privilege** — connectors read-only by default; write scopes explicit, time-bound, revocable | Absolute                                                                  |
| NFR-5  | **Auditability** — no action bypasses the ledger                                                    | Absolute                                                                  |
| NFR-6  | **Availability**                                                                                    | 99.5% Phase 3; 99.9% Phase 5                                              |
| NFR-7  | **Discovery throughput**                                                                            | 1M records/hour/connector (Phase 3 target)                                |
| NFR-8  | **Report generation**                                                                               | < 5 minutes for standard assessment                                       |
| NFR-9  | **Recoverability**                                                                                  | RPO ≤ 1 hour; RTO ≤ 4 hours                                               |
| NFR-10 | **Model portability**                                                                               | LLM provider abstracted; self-hosted model support by Phase 5             |
| NFR-11 | **Cost discipline**                                                                                 | Infrastructure cost per client tracked; must stay under 15% of client ACV |
| NFR-12 | **Explainability**                                                                                  | Every agent conclusion traceable to inputs and cited control clause       |

## B.6 Constraints

- Solo founder plus AI agents; no engineering team until revenue-triggered hiring
- No external capital; all build funded by realised revenue
- Build velocity capped by one human's review capacity — this is the real scaling constraint, and is why review-throughput tooling is a first-class product requirement, not an internal nicety
- Certifications (SOC 2, ISO 27001) deferred until a deal demands them

## B.7 Assumptions

- DPDPA enforcement holds at 13/14 May 2027
- Mid-market buying accelerates in the two waves (Q4 2026, H1 2027)
- Client system access can be obtained read-only before write access
- LLM capability and cost continue improving

## B.8 Risks (product-level)

| Risk                                                           | Mitigation                                                                                                                            |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Agent-executed change causes a client incident                 | Dry-run + rollback + blast-radius caps + approval gate + kill switch; start with lowest-risk action classes only                      |
| Agent misclassification produces a wrong compliance conclusion | Confidence scoring, human review queue, explainability, founder sign-off in early phases                                              |
| Human review becomes the bottleneck                            | Review-throughput tooling as a first-class product surface; batch approval; standing policies at L3                                   |
| Client refuses write access                                    | Product remains fully valuable in read-only/advisory mode; execution is an upsell, not a prerequisite                                 |
| Liability for a recommendation                                 | Explicit non-legal-opinion positioning; human approval of record; professional indemnity insurance before Phase 3 execution goes live |

## B.9 Out of scope for v1

Multi-jurisdiction (GDPR/CCPA) coverage · Consent Manager registry operation · On-premises deployment · Mobile applications · Real-time streaming discovery · Automated legal opinion generation

## B.10 Acceptance criteria for the Phase 3 core release

The Phase 3 release is accepted when, in a production client environment:

1. An agent-generated remediation plan is produced with rollback plans for every action
2. Dry-run produces an accurate diff preview for every action
3. Approval is architecturally impossible without a successful dry-run
4. A partial batch approval executes exactly the approved subset and nothing else
5. Rollback successfully reverses a completed action
6. The full chain — finding → plan → dry-run → approval → execution → verification → closure — is reconstructable from the ledger by an independent reviewer
7. Blast-radius cap breach halts execution and escalates
8. The kill switch stops in-flight execution
