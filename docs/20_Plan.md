# Axiom Proof — Plan (W0–W12), scope and traceability

### Axiom Minds Private Limited · https://axiomminds.ai

**This is the single plan document.** It replaces
`11_Phase0-5_Gap_Closure_Plan.md`,
`19_Phase0-5_Extension_Samadhan_Pramaan_Architecture.md` and
`13_Roadmap_Traceability.md` (now stubs). Its companions:
[21_Progress.md](21_Progress.md) (append-only log),
[22_Architecture_and_Flow.md](22_Architecture_and_Flow.md) and
[23_Operator_Runbook.md](23_Operator_Runbook.md).

**Rules for editing this file** (see
`.agents/skills/axiom-docs-increment/SKILL.md`): update only the status table
and the "Open discrepancies" list at each checkpoint; never add a new
plan/handoff file; never mark a status from anything except a verified result
that is recorded in `21_Progress.md`.

**Provenance.** Everything below is carried over from the pre-consolidation
docs as they stood at `origin/staging` `41b70b6`. Full original text of every
merged file remains in git (`git show 41b70b6:docs/<old file>`). Source tags
in brackets name the old file: `[11]`, `[13]`, `[14]`, `[15]`, `[16]`,
`[17A]` (17_Deployed_Acceptance), `[17B]` (17_Fresh_Session_Brief), `[18]`,
`[19]`, `[A91]`/`[A98]` (audits 91 and 98), `[brief]` (the 2026-10-01
maintainer-verified state supplied with the consolidation request; not yet
stated in any older doc).

---

## 1. Headline status (2026-10-01)

- No production deployment and no remote preprod acceptance run is recorded
  anywhere. Local Docker parity stack is engineering evidence only
  `[16][18][A91]`.
- The Revision 108 claim that W0–W10 were complete was **withdrawn by Audit 91**
  `[11][16][A91]`.
- Gates still open per `[16]`: W8 (+ W8.4, W8.5), W9, W10, remote release.
  Per `[brief]`: migration 0099 is an untested draft and a production blocker
  (see §5 and `21_Progress.md`).

## 2. Scope as accepted

### 2.1 Original workstreams W0–W10 `[11]`

Order and size are the plan's own (sizes relative: S/M/L/XL, no calendar).
**W0 blocks everything** `[11]`; W7 and W10 config hardening run parallel to W0;
W9 runs alongside everything and gates every merge; W5 starts after W4.4.

| ID  | Workstream                                  | Priority / size  | Scope in one line                                                                                                                                                                                                                                     |
| --- | ------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W0  | Security remediation and environment parity | P0 blocking / L  | One codebase, one ruleset: preprod authenticates exactly like production; SEC-1…SEC-13 closed with regression tests; deployed parity lane `[11]`                                                                                                      |
| W1  | Tenancy, RBAC, MFA, personas                | P0 / L           | Central capability matrix, tenant context, TOTP + recovery step-up (email OTP deferred, SMS defined-but-disabled), `axiom_analyst` persona `[11]`                                                                                                     |
| W2  | Data model completion                       | P0 / M           | Append-only migrations; 40 named target tables; tenant-consistent FKs and RLS `[11]`                                                                                                                                                                  |
| W3  | Client estate and onboarding                | P1 / M           | tenant → estates → systems → connectors; resumable wizard; sustenance. **W3.5** Entity Relationship Graph `/estate/graph` `[11]`                                                                                                                      |
| W4  | Universal Connection Framework              | P1 / XL          | W4.1 registry + descriptors; W4.2 credential broker; W4.3 SPIFFE identity + token exchange; W4.4 grant model; W4.5 internal MCP-style tool registry; W4.6 live bindings (PostgreSQL, MySQL); W4.7 REST/GraphQL + descriptor packs + SAML grant `[11]` |
| W5  | Phase 3 execution loop                      | P1 / XL          | Dry-run engine, Karya v1, rollback engine, blast-radius governor, post-execution verification, maker-checker reconciliation (W5.6), progress telemetry `[11]`                                                                                         |
| W6  | Continuous compliance                       | P1 / L           | Scheduler, drift, standing approval policies (W6.2), monitoring health; W6.3 self-serve SMB, W6.4 TPRM/DPIA, W6.5 partner/white-label, W6.6 Sanket `[11][13]`                                                                                         |
| W7  | Control library and multi-regulator         | P0-adjacent / L  | Citation correction (CTL-1), versioned baseline `IN-DPDP@2026-09-20` (W7.0), frameworks/mappings, sector packs `[11]`                                                                                                                                 |
| W8  | Reporting, evidence, branding               | P1 / L           | Shared `@axiom/report-kit`, server PDF, evidence retrieval and packs, four report formats, approval history; W8.1 rights/consent, W8.2 breach, W8.3 founder review/release `[11][13]`                                                                 |
| W9  | Test, audit, performance                    | P0 alongside / L | BFF/web suites, RLS integration tests, persona E2E, PRD §B.10 acceptance, coverage floors, load and restore evidence (W9.1 operational evidence) `[11][13]`                                                                                           |
| W10 | On-prem deployment environment              | P2 / M           | `onprem` as a first-class strict-auth topology: Compose/Helm, MinIO Object Lock, Temporal, Redis, self-hosted model, offline license (W10.1 gated items) `[11][13]`                                                                                   |

### 2.2 Scope changes (user-added, 2026-09-30) `[11][16]`

Two work items were added and tracked **inside W8** to preserve W0–W10
numbering; both are release-blocking:

| ID             | Item                                 | Meaning                                                                                                                                                                                                                 | Maps to                         |
| -------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| W11 = **W8.4** | Pramaan dossiers                     | Each dossier type binds its own authoritative released source, exact retained archive version, founder seal/release and permitted dispatch; unsupported source types stay closed `[11]`                                 | Agent **Pramaan**               |
| W12 = **W8.5** | Reconciliation-backed approval proof | Database-derived maker-checker statement verified against the signed approval and the complete dry-run/rollback/execution/verification chain, then an independently retained, access-controlled approval archive `[11]` | Agent **Samadhan** (reconciler) |

### 2.3 Added agents: Samadhan and Pramaan `[19]`

Roster goes from 10 to 12 named agents. Target design only; `[19]` itself says
"proposed architecture; implementation and acceptance incomplete".

| Agent        | Role                                                                                                                                                                                                                                     | can_mutate | Notes          |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------------- |
| **Samadhan** | Maker-checker and reconciler: reconciles Sudhaar's plan against Karya's executed reality, flags `out_of_scope_executed` / `content_digest_drift`, signs the reconciliation statement (HMAC-SHA256 with the batch's approval signing key) | false      | Phase 3 `[19]` |
| **Pramaan**  | Statutory closure compiler: binds findings, plan, approver, execution, reconciliation, WORM manifest and ledger hash into a dossier; offline-verifiable pack; draft until founder/DPO release (BR-4)                                     | false      | Phase 5 `[19]` |

Prativedan stays the L1 working-document drafter `[19]`. Architecture detail:
[22_Architecture_and_Flow.md](22_Architecture_and_Flow.md).

## 3. Workstream status table

Statuses are stated **only** from facts in the source docs (newest source wins
where noted; conflicts are in §6). "Delivered locally" means code merged to
staging with CI green, not deployed.

| ID             | Status                                                      | Basis (source)                                                                                                                                                                                                   | Still open (source)                                                                                                                                                                                                |
| -------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| W0             | **Partial**                                                 | Harness delivered, locally rehearsed; W0.0/W0.2 closed and CI-held `[16]`                                                                                                                                        | Deployed acceptance on two remote targets; C-W0-5 effective IAM; EKS CIDR decision; held-secret rotation confirmation `[16][14]`                                                                                   |
| W1             | **Partial**                                                 | C-W1-1…4 delivered (invitations Rev 78, atomic recovery policy 0036) `[16]`                                                                                                                                      | Real mail provider/domain; deployed MFA enrolment/step-up/replacement evidence `[16]`                                                                                                                              |
| W2             | **Partial**                                                 | 36/40 named tables at Rev 101 `[17B]`                                                                                                                                                                            | Four workflows: `ropa_records`, `policy_drafts`, `playbook_entries`, `classification_reviews` `[17B]`                                                                                                              |
| W3             | **Partial** (code complete locally per `[14]`)              | Wizard (Rev 79), sustenance (Rev 80), inventory/proposals `[16][14]`                                                                                                                                             | Scheduled drift/notifications moved to W6; deployed acceptance `[14]`                                                                                                                                              |
| W3.5           | **Partial**                                                 | Graph, filters, SVG (Rev 81), PNG (Rev 88) `[14]`                                                                                                                                                                | Derivation edges (need lineage model), live updates, branded export `[14]`                                                                                                                                         |
| W4.1–W4.5      | **Code complete** locally `[14]`                            | Registry, vault, broker, SPIFFE, grants, tool registry `[14]`                                                                                                                                                    | Production broker/SPIRE composition; broker acquisition stays disabled until W4.3/4 enforcement is wired `[14][16]`                                                                                                |
| W4.6           | **Mostly done**                                             | PostgreSQL discovery (Rev 84, 87), MySQL (Rev 98, PR #85) `[14]`                                                                                                                                                 | RDS `ap-south-1` staging acceptance (operator) `[14][17B]`                                                                                                                                                         |
| W4.7           | **Mostly done**                                             | REST (Rev 85), GraphQL (Rev 86), five-system reference pack `[14]`                                                                                                                                               | `saml2_bearer` (TODO, not a blocker); vendor-verified descriptors (need client tenants) `[14]`                                                                                                                     |
| W5             | **Backend delivered locally; production write path absent** | Dry-run (0060), executor (0061), rollback (0062), verification + reconciliation (0063), telemetry (0064), manual rollback route (PR #81) `[14]`                                                                  | No production connector write path (`execution_unconfigured` without a configured origin); operator-gated broker/SPIRE composition; deployed PRD §B.10 acceptance `[14]`                                           |
| W6             | **Partial**                                                 | Tables (0065), scheduler (0066), drift ack + health (0067), standing-policy engine (0068); rediscovery/reassessment executors promoted via PR #80 `[14]`                                                         | Scheduler composition/alerts, monitoring UI, SMB/vendor/partner/Sanket work (W6.3–6.6) `[14][17B]`                                                                                                                 |
| W7             | **Partial**                                                 | 46 controls; frameworks/mappings tables (0070) and BFSI pack #1 (Rev 98) `[14]`                                                                                                                                  | Healthcare then Tech packs; library completeness `[17B]`                                                                                                                                                           |
| W8             | **Open**                                                    | Board source/PDF versions and manager/founder UI passed exact-staging gate (Rev 118); auditor source-bound pack (PR #118, `56dfba9`) `[16]`                                                                      | Source-bound DPB and technical reports; permitted dispatch; independently retained approval proof; all positive/refusal journeys `[16]`                                                                            |
| W8.4 (W11)     | **Open, partial**                                           | Board `board_executive` source-bound dossier (audit 98, Rev 120; merge `38762c4` of PR #119 is in staging history) `[A98]`                                                                                       | `dpb_statutory`, `auditor_assurance`, `technical_register`, `full_closure` still return `source_bound_dossier_required`; dispatch closed `[A98]`                                                                   |
| W8.5 (W12)     | **On staging `6dab9ac` (exact-SHA CI pending)**             | Approval exports honestly labelled, not sealed (Rev 113) `[16]`; branch `codex/revision124-approval-proof-archive` `d617c2a` is **local only**, its 14-journey real-provider browser run **not green** `[brief]` | Verified maker-checker statement, exact approval archive, export/release authority `[16][brief]`                                                                                                                   |
| W9             | **Open**                                                    | Real disposable restore drill strengthened (Rev 109) `[A91]`                                                                                                                                                     | CI-enforced coverage floors (web gate 80% not met in last integrated measurement `[brief]`; 7 of 14 modules failed at Rev 109 `[A91]`); real 1M-row load; scheduled-backup RPO and DB+evidence restore `[16][A91]` |
| W10            | **Open**                                                    | Compose/Helm/bootstrap/license code exists but Audit 91 found it not genuinely isolated `[A91]`                                                                                                                  | Live air-gapped acceptance **not done** `[brief]`; strict secrets, local Auth/PostgREST/DB, model path, fail-closed WORM/bootstrap `[A91]`                                                                         |
| Remote release | **Open**                                                    | none                                                                                                                                                                                                             | Exact revision/migration checks on real targets, residency/IAM/Object Lock readback, synthetic-tenant preprod and production acceptance `[16]`                                                                     |

### Engineering blocker not in any older doc `[brief]`

| Item                                                    | State                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migration **0099** (ledger source + execution gate)     | **Untested draft; production blocker.** Reasons stated in the brief: `service_role` can call `append_ledger` directly, has DML grants on `remediation_plans`/`remediation_actions`, and `start_execution_batch` can bypass the cancelled-plan path. Violates the spirit of AGENTS.md hard rules 1 and 3 until fixed and tested. |
| Statutory dossier migrations **0091–0097** and **0098** | Local only (not on staging) `[brief]`                                                                                                                                                                                                                                                                                           |

## 4. Sequencing `[11]`

```
W0  Security ─────────────────────────────── blocks everything
W2  Data model ─┬─ W1 Tenancy / RBAC / MFA ── makes staging testable
                ├─ W3 Estate ── W3.5 graph
                │   └─ W4 Connection Framework (4.1→4.7)
                │        └─ W5 Execution loop  (starts at W4.4)
                ├─ W6 Continuous / standing policies
                └─ W8 Reporting / evidence / branding (+ W8.4, W8.5)
W7 starts day one (parallel to W0); W10 parallel from W0; W9 gates every merge
```

**Current work order `[16]`:** (1) close W8 in requirement order including
W8.4 and W8.5: source-bound report and dossier generation, verified retained
source/PDF/archive versions, founder review/release and permitted dispatch,
truthful approval exports, then positive and refusal E2E/UX/security; do not
reopen the unsourced paths to make a demo work. (2) Close W9 with measured
coverage, real load and full recovery. (3) Close W10 with an isolated offline
install/upgrade/restore/persona test. (4) Reassess W0–W10 coverage and
security; each increment: local tests + Docker parity → staging PR → merge only
after the full PR gate → verify CI **and** security on the exact staging merge
SHA. No main promotion or production release is due while a gate is open.
(5) Then follow [23_Operator_Runbook.md](23_Operator_Runbook.md) for preprod and
production.

Definition of done per workstream `[11]`: tests first for security-relevant
behaviour, suite green, no `--passWithNoTests`, deployed to staging with
`AXIOM_AUTH_MODE=strict`, exercised through the UI as each persona. Per-merge
gate: typecheck, lint, unit, RLS integration, E2E, no-service-role-in-web grep,
secret scan, control-count check. Phase 3 sign-off is the eight PRD §B.10
criteria as passing tests plus a live rollback in a controlled staging estate.

## 5. Standing invariants (release conditions) `[16]` + AGENTS.md

No mutating agent action without recorded human approval and a signed
scope-bound token; approval requires a completed dry-run and validated
rollback (BR-2). Sudhaar has no write credentials. Ledger append-only via
`append_ledger()`. Evidence retention is S3 Object Lock **Compliance** mode.
Client personal data stays in `ap-south-1`; model egress redacted. Migrations
are append-only; never edit an applied migration. Every new ledger action must
also be added to `LedgerActionType` in `packages/types/src/enums.ts`.

## 6. Decisions

### 6.1 Resolved `[11][14][16]`

| #   | Decision                                                                                                                                                           | Lands in   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| 1   | MFA: TOTP + recovery; email OTP deferred by accepted scope; SMS defined-but-disabled                                                                               | W1         |
| 2   | Connectors: Universal Connection Framework; REST/OpenAPI primary; outbound MCP optional per descriptor; inbound MCP dropped; initial live targets PostgreSQL/MySQL | W4         |
| 3   | On-prem in scope as `onprem` environment at production strictness                                                                                                  | W10        |
| 4   | Control library: add every missing control incl. all 7 Schedules, plus CTL-1 citation re-map                                                                       | W7         |
| 5   | Estate: build all missing pieces plus Entity Relationship Graph                                                                                                    | W3, W3.5   |
| 6   | Maker-checker: build it (Sudhaar cannot execute, Karya cannot plan, reconciliation proves they agreed)                                                             | W5.6       |
| 7   | Tests: comprehensive across every package/app/service                                                                                                              | W9         |
| 8   | Preprod is an exact replica of production; environment determines topology only                                                                                    | W0.0/0.1   |
| 9   | Control library versioned against `IN-DPDP@2026-09-20`, content-hashed                                                                                             | W7.0       |
| 10  | All agents get SVIDs; only Drishti (read) and Karya (write) reach a client estate; Nazar loses `control_library.write`                                             | W4.3, W7.0 |
| 12  | One connector identity per tenant; `connector.write` only Karya SVID + valid approval token                                                                        | W4.2–4.4   |
| —   | Recovery-code replacement ends prior MFA attestations; current-factor replacement keeps them (0036)                                                                | W1         |
| —   | Owner **and tenant admin** may approve staff-prepared onboarding proposals; analyst only prepares                                                                  | W3         |
| —   | Higher environments: self-hosted Supabase (Cloud SQL may sit underneath); do not substitute managed Supabase                                                       | W0         |
| —   | Public APIs on Cloud Run; dedicated private Mumbai runner VM per tenant; separate issuer VM                                                                        | W4.3       |
| —   | Production deployment is in scope **after** full engineering clearance; conditional, not permission to bypass gates `[17B][18]`                                    |            |

### 6.2 Still open `[11][12][14][15]`

- Mock-data line: permitted only behind an explicit `demo` tenant flag with `provenance: 'simulated'` (proposal; proceeded on that basis) `[11]`.
- BR-4: founder review vs automatic public gap-scan delivery: introduce the gate or record a scoped exception `[12]`.
- Authoritative provider/retention equivalence record; marketing/API boundary reconciliation `[12]`.
- Promotion to `main`: paused by the operator `[14][16]`.

## 7. Roadmap traceability `[13]`

Status words are `[13]`'s own (as of its newest addenda, Revision 63; later
revisions are in the §3 table). Owners are workstream IDs.

### Phase 0 / 1

| Module                                                                                      | Status             | Remaining                                                         | Owner           |
| ------------------------------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------- | --------------- |
| M0.1 Corporate and digital foundation                                                       | Partial / External | Incorporation, tax/banking, domain/trademark: founder evidence    | Founder; W8     |
| M0.2 Control Library v0                                                                     | Partial            | Python mirror still 0.1.0; provenance publication                 | W7              |
| M0.3 Parikshan Assessment v0                                                                | Partial            | Pinned-version runtime parity; reviewed live journey              | W7/W3.1         |
| M0.4 Prativedan Report v0                                                                   | Partial            | Branded PDF, released-output evidence                             | W8              |
| M0.5 Free Gap-Scan                                                                          | Partial            | API boundary, version parity, release policy, deployed acceptance | W0/W7/W8.3      |
| M0.6 Agent Workbench                                                                        | Partial            | Invocation authority, prompt/version governance                   | W1/W3.1         |
| M1.1–M1.8 Drishti, Vibhaag, RoPA, Sudhaar, Saakshi, policy/notice, review console, playbook | Partial            | Persistence, review queues, released output, delivery benchmarks  | W3.1/W2/W8/W9.1 |

### Phase 2 / 3

| Module                                                                                    | Status `[13]`                                                        | Owner                         |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------- |
| M2.1 Connector Framework v1 (three live families: DB, Workspace/M365, object store)       | Pending (one SQL binding is an intermediate milestone, not the exit) | W4                            |
| M2.2 Drishti live discovery                                                               | Pending                                                              | W3/W4/W6.1                    |
| M2.3 Automated classification                                                             | Partial                                                              | W3.1/W4                       |
| M2.4 Evidence Vault v1                                                                    | Partial                                                              | W8                            |
| M2.5 Lekha ledger v1                                                                      | Partial                                                              | W5/W8/W9.1                    |
| M2.6 Approval workflow v1                                                                 | Partial                                                              | W1/W5/W8.3                    |
| M2.7 Multi-format reporting                                                               | Partial                                                              | W8                            |
| M2.8 DSAR/rights tracker                                                                  | Partial                                                              | W8.1                          |
| M2.9 Nazar regulatory watch                                                               | Partial                                                              | W7/W6.1                       |
| M3.1–M3.7 Planner, dry-run, approval console, Karya, rollback, blast-radius, verification | Pending/Partial at Rev 63; backend since delivered (see §3 W5)       | W5                            |
| M3.8 Consent / M3.9 Breach / M3.10 Monitoring / M3.11 Portal                              | Partial/Pending at Rev 63                                            | W8.1 / W8.2 / W6.1 / W1,W8,W9 |

The eight PRD §B.10 scenarios remain the core acceptance suite.

### Phase 4 / 5

| Module                                                                        | Status `[13]`                                    | Owner      |
| ----------------------------------------------------------------------------- | ------------------------------------------------ | ---------- |
| M4.1 Standing approval policies                                               | Pending at Rev 63 (engine since delivered, 0068) | W6.2       |
| M4.2 Multi-regulator reuse                                                    | Pending at Rev 63 (BFSI pack since delivered)    | W7         |
| M4.3 Connector Framework v2                                                   | Pending                                          | W4.7       |
| M4.4 Self-serve SMB; M4.5 TPRM; M4.6 DPIA                                     | Pending                                          | W6.3, W6.4 |
| M4.7 Partner/white-label                                                      | Partial                                          | W6.5/W8    |
| M4.8 Sectoral pack #1                                                         | Pending decision (BFSI since delivered)          | W7         |
| M4.9 Sanket market signals                                                    | Pending (`_run()` returns empty stub)            | W6.6       |
| M5.1 Split-plane; M5.3 Enterprise tier; M5.5 pack #2; M5.7 policy-governed L4 | Gated                                            | W10.1 etc. |
| M5.2 On-prem/VPC                                                              | Pending, intentionally pulled forward            | W10        |
| M5.4 SOC 2 / ISO 27001; M5.6 Consent Manager registration                     | Gated / External (revenue/capital-triggered)     | Founder    |

### BR/FR/NFR owners `[13]`

| Requirements                                 | Owner           |
| -------------------------------------------- | --------------- |
| BR-1, BR-2                                   | W1/W5/W6.2      |
| BR-3, BR-5                                   | W5/W8           |
| BR-4                                         | W8.3            |
| BR-6                                         | W0/W4/W9.1/W10  |
| BR-7                                         | W8              |
| BR-8                                         | Founder/W9.1    |
| FR-1                                         | W3/W3.1/W4/W6.1 |
| FR-2                                         | W3.1/W4         |
| FR-3                                         | W7/W3.1/W6.1    |
| FR-4                                         | W8/W8.1         |
| FR-5, FR-6, FR-8, FR-9                       | W5              |
| FR-7                                         | W1/W5/W8.3/W6.2 |
| FR-10                                        | W5/W8/W9.1      |
| FR-11                                        | W8              |
| FR-12                                        | W8.1            |
| FR-13                                        | W8.2            |
| NFR-1 Residency                              | W0/W9.1/W10     |
| NFR-2 Isolation                              | W1/W2/W4/W9.1   |
| NFR-3 Encryption                             | W0/W9.1         |
| NFR-4 Least privilege                        | W4              |
| NFR-5 Auditability                           | W5/W8           |
| NFR-6 Availability (99.5% P3 / 99.9% P5)     | W9.1            |
| NFR-7 Throughput (1M records/hour/connector) | W4/W9.1         |
| NFR-8 Reports (<5 min)                       | W8/W9.1         |
| NFR-9 Recovery (RPO <= 1h, RTO <= 4h)        | W9.1/W10        |
| NFR-10 Model portability                     | W10             |
| NFR-11 Cost (alert at 15% of ACV)            | W9.1            |
| NFR-12 Explainability                        | W7/W8           |

Prototype route mappings: `/remediation` = `/plans`; `/dsar` = `/dsars`;
`/breach` = `/breaches`; `/estate/graph` is new; MFA lives at
`/settings/security` and `/verify` `[13]`. Phase exits also need commercial and
operating evidence (client counts, delivery-time reductions, funded costs,
production-client remediation outcomes): founder-owned, not waived `[13]`.

## 8. Samadhan / Pramaan implementation roadmap `[19]` (target, unaccepted)

`[19]` proposes four extension workstreams W11–W14. They are retained here as
the target decomposition of the user-added W8.4/W8.5 work (see discrepancy D1).

| `[19]` ID | Content                                                         | Checkboxes carried over (all unchecked in source)                                                                                                                                                                                                                                   |
| --------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W11       | Contracts, enums and DB foundation (migration "0072" in `[19]`) | Add `SAMADHAN`/`PRAMAAN` to `AgentName`; `AgentContract`s; ledger actions `execution.reconciliation.attested`, `closure.pramaan.drafted`, `closure.pramaan.sealed`; `reconciled_by_agent` on `plan_reconciliations`; table `pramaan_dossiers`; function `seal_pramaan_dossier(...)` |
| W12       | Agent runtime classes and executor integration                  | `samadhan.py`, `pramaan.py`; attribute reconciliation to Samadhan in `executor.py`; tests >= 90% coverage                                                                                                                                                                           |
| W13       | BFF endpoints and offline packaging kit                         | report-kit includes `reconciliation_statement.json` and `ledger_chain_receipt.json`; `verify_evidence_pack.py` verifies them; `POST /v1/engagements/:id/closure/pramaan`; `POST /v1/dossiers/:id/release` guarded by `Capability.REPORT_RELEASE` + founder                          |
| W14       | Web UI, closure workflow, brand                                 | Samadhan card in execution console; Reports page distinguishes Prativedan (working) from Pramaan (statutory); sidebar entries; marketing agents page to 12 agents; Gold `ProofSeal` only on verified closure                                                                        |

Acceptance gates `[19]`: G1 contract integrity (`pnpm --filter @axiom/types test`);
G2 database immutability (`scripts/test-database.sh`); G3 runtime isolation
(`Sudhaar.can_mutate == False`, `Samadhan.can_mutate == False`,
`Karya.can_mutate == True`); G4 offline verification of Pramaan ZIPs
(`pnpm --filter @axiom/report-kit test`); G5 end-to-end finding-to-dossier
walkthrough (`pnpm test:e2e`).

## 9. Open discrepancies between sources

Listed, not resolved by guessing. Latest-dated or git-verifiable fact is noted
where one exists.

| #   | Discrepancy                                                                                                                                                                                                       | Sources                                                           | Note                                                                                                                               |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| D1  | User-added extension numbering: W11/W12 = Pramaan dossiers and reconciliation-backed approval proof (tracked as W8.4/W8.5) vs `[19]` W11–W14 = contracts/runtime/BFF/UI decomposition                             | `[11]`/`[16]` vs `[19]`                                           | This plan uses W8.4/W8.5 for scope and `[19]` as decomposition. `[19]` also names migration "0072", already used on staging.       |
| D2  | Status of W0/W1/W3: "Code complete" vs "Partial"                                                                                                                                                                  | `[14]` Build Board Rev 88 vs `[16]` 2026-10-01                    | `[16]` is newer and has the withdrawn-claim context; table uses Partial.                                                           |
| D3  | W2 named-table count: 19/40 vs 36/40                                                                                                                                                                              | `[16]`, `[00 index]` (19/40) vs `[17B]` (36/40, Rev 101)          | Later source used (36/40). Index and runbook figures were never refreshed.                                                         |
| D4  | Migration count: runbook W0-5 expects "42 migrations 0000→0041" and W0 closure checks "39 migrations"; progress docs record 0000–0089                                                                             | `[16]` vs `[14]`, git                                             | Git at `41b70b6` has 90 migration files (0000–0089). Do not use 39/42 for acceptance.                                              |
| D5  | W7 sector pack #1 "pending decision" vs BFSI pack delivered                                                                                                                                                       | `[13]`/`[14]` Rev 88 vs `[14]` Rev 98                             | BFSI delivered (Rev 98); Healthcare then Tech next `[17B]`.                                                                        |
| D6  | PR #119 (Revision 120 board Pramaan): "pending security-head CI and exact-staging merge"                                                                                                                          | `[11]`, `[16]`                                                    | Git shows merge `38762c4` of PR #119 in `origin/staging`. Closure of the amended-head security finding is not recorded in any doc. |
| D7  | Promotion to `main`: "Rev 98 promotion still due" vs "promotion to main is paused"                                                                                                                                | `[11]` Rev 98 note vs `[14]`/`[16]` operator decisions 2026-09-25 | `main` is at `3492ffa` (also `[A91]`: staging = main at `3492ffa` on 2026-09-30). Latest instruction: paused.                      |
| D8  | MFA: decision table E.1 #1 says "TOTP + email OTP" vs W1 text "email OTP deferred"                                                                                                                                | `[11]`                                                            | W1 text, `[12]` and `[16]` confirm deferred.                                                                                       |
| D9  | Agent counts: "10 agents" (guide, `[11]` roster section, README) vs 12 (`[19]`, guide's script output)                                                                                                            | `[11]`, `LIVE_FUNCTIONAL_FLOW_GUIDE`, `[19]`                      | 12 is the target; Samadhan/Pramaan are not accepted as deployed.                                                                   |
| D10 | The functional-flow guide shows Prativedan compiling Board and Auditor dossiers; `[16]` records that generic Prativedan report paths and historical Pramaan sealing are closed and only source-bound paths remain | guide vs `[16][A91]`                                              | Guide flow is the intended end state, not current behaviour.                                                                       |
| D11 | Stale baselines: `[00 index]` quotes 0051/52 migrations; `[18]` references the retired Rev 98 checklist; `[14]` older W-status tables                                                                             | various                                                           | Superseded by this plan and `21_Progress.md`.                                                                                      |
| D12 | `down.sh` is referenced in the consolidation brief for local Docker teardown; no such script exists at `41b70b6` (closest: `scripts/dev-docker.sh --down`, which runs `docker compose down` without `-v`)         | brief vs git                                                      | Rule recorded in the runbook; script follow-up is an engineering item, not done here (docs only).                                  |
