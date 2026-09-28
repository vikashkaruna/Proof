# Axiom Proof — Phase 0–5 Gap Closure Extension: Samadhan & Pramaan Architecture

**Document ID:** `DOC-EXT-01` / `docs/19_Phase0-5_Extension_Samadhan_Pramaan_Architecture.md`  
**Classification:** Architecture & Engineering Implementation Specification  
**Status:** Ready for Implementation  
**Base Line:** Revision 108 Complete (Phase 0–5 W0–W10)  
**Target Branch:** `codex/revision75-controller-generation-transition`  
**Target Milestone:** Extension Workstreams W11 – W14

---

## 1. Executive Summary & Problem Formulation

### 1.1 The Operational Gap

Following the completion of the Phase 0–5 Gap Closure (W0 through W10, Revision 108), the platform possesses enterprise-grade cryptographic building blocks:

1. **Lekha (Audit Custodian):** An append-only, SHA-256 hash-chained ledger (`public.audit_ledger`).
2. **Saakshi (Evidence Custodian):** An S3 WORM Object Lock vault in Compliance mode.
3. **Execution Detail Tables:** Migration 0060–0063 execution batches, rollbacks, verification results, and reconciliations.
4. **Prativedan (Reporting Agent):** A document generator that turns findings into HTML/markdown tables.

However, **the business and statutory deliverable is not yet completed**:

- A Board of Directors, a Data Protection Board of India (DPB) Adjudicating Officer, or an external ISO 27001/SOC 2 auditor cannot evaluate raw Postgres ledger JSON rows or isolated binary blobs in S3.
- The **Maker-Checker reconciliation** is currently performed by an anonymous system routine (`axiom/verification.py`) and logged simply as `'agent', 'reconciler'`, leaving the dual-control proof persona unnamed.
- **Prativedan** in its current form is merely a document drafter; it does not synthesize the ledger, the WORM evidence manifest, and the maker-checker reconciliation into an authoritative, sealed attestation.

### 1.2 The Two-Agent Architectural Resolution (Option B)

To achieve statutory closure without compromising separation of duties:

1. **Samadhan (समाधान · Maker-Checker & Reconciler):** The independent dual-control arbiter that reconciles **Sudhaar's** remediation plan against **Karya's** executed reality, enforces zero out-of-scope mutation, flags configuration drift, and signs the reconciliation certificate.
2. **Prativedan (प्रतिवेदन · The Draftsman):** Retained as the L1 document compiler for working registers, gap scan drafts, and internal policy/notice documents.
3. **Pramaan (प्रमाण · Statutory Closure & Proof Attestation):** Introduced as the **Master Closure Authority**. In the `CLOSURE` phase, Pramaan ingests outputs from all upstream agents, bundles the offline-verifiable evidence manifest, seals the ledger root, and generates the unassailable, auditor-ready **Axiom Pramaan Dossier** bearing the Gold ProofSeal.

---

## 2. The 12-Agent Roster & Separation of Duties

With the addition of **Samadhan** and **Pramaan**, the Axiom Proof agent roster expands from 10 to 12 specialized agents, maintaining strict architectural separation:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        THE 12-AGENT ROSTER                             │
├────────────────────────────────────────────────────────────────────────┤
│  1. Drishti    (Discovery)          - L1 Autonomous                    │
│  2. Vibhaag    (Classification)     - L1 Autonomous                    │
│  3. Parikshan  (Assessment)         - L1 Autonomous                    │
│  4. Sudhaar    (Planning - Maker)   - L1 (Strictly Read-Only, ADR-3)   │
│  5. Karya      (Execution - Doer)   - L2 Approval-Gated (Mutating)     │
│  6. Samadhan   (Maker-Checker)      - L1 Reconciler & Dual-Control     │
│  7. Saakshi    (Evidence Vault)     - L1 WORM Compliance Custodian     │
│  8. Lekha      (Ledger Custodian)   - L1 Cryptographic Chain Anchor    │
│  9. Prativedan (Draftsman)          - L1 Document & Working Compiler   │
│ 10. Pramaan    (Proof & Closure)    - L1 + Founder/DPO Release Seal    │
│ 11. Nazar      (Regulatory Watch)   - L1 Gazette & DPB Surveillance    │
│ 12. Sanket     (Market Signals)     - L1 Threat & Buying Telemetry     │
└────────────────────────────────────────────────────────────────────────┘
```

### Complete End-to-End Chain of Custody

```
[Drishti + Vibhaag] ──▶ Personal Data Inventory & RoPA Mapping
         │
         ▼
    [Parikshan] ──────▶ 46 DPDPA Statutory Findings & Exposure Calculation
         │
         ▼
     [Sudhaar] ───────▶ Remediation Plan + Rollbacks + Dry-Run Simulation (Maker)
         │
         ▼
  [Client Approver] ──▶ MFA Step-Up Challenge + Cryptographic Approval Token
         │
         ▼
      [Karya] ────────▶ Mutating Execution + Pre/Post State Capture (Doer)
         │
         ▼
    [Parikshan] ──────▶ Post-Execution Control Gap Verification
         │
         ▼
    [Samadhan] ───────▶ Maker-Checker Reconciliation & Zero-Drift Statement
         │
         ▼
[Saakshi + Lekha] ────▶ WORM Object Lock Vault + Append-Only Ledger Entry
         │
         ▼
   [Prativedan] ──────▶ Technical Registers & Executive Drafts (Drafter)
         │
         ▼
    [Pramaan] ────────▶ Master Synthesis + Deterministic Offline Pack + Gold Seal
         │
         ▼
 [Founder / DPO] ─────▶ Statutory Review & Release Gate (BR-4) ──▶ CLIENT & REGULATOR
```

---

## 3. Detailed Specifications for New Agents

### 3.1 Samadhan (समाधान · Maker-Checker & Reconciler Agent)

- **Purpose:** Independent verifier of the Maker-Checker workflow (BR-1 / W5.6).
- **Core Guarantees:**
  1. _Facts are the database's facts:_ Computes reality directly from `approval_tokens` and `execution_batches`.
  2. _Out-of-scope screams:_ Any action executed outside the approved token fails with `out_of_scope_executed`.
  3. _Drift is stated:_ Recomputes parameter content digest at settle time; mismatches are flagged as `content_digest_drift`.
  4. _Cryptographic binding:_ Signs the reconciliation statement with HMAC-SHA256 using the batch's `approval_signing_key`.

#### TypeScript Contract (`packages/types/src/agents.ts`)

```typescript
samadhan: {
  name: 'samadhan',
  displayName: 'Samadhan',
  oneLiner: 'I prove that execution matched your plan and your approval.',
  autonomyLevel: 'L1',
  canMutate: false,
  mutatesClientEstate: false,
  writesAxiomState: true,
  inputSchema: z.object({
    tenant_id: z.string().uuid(),
    plan_id: z.string().uuid(),
    batch_id: z.string().uuid(),
    correlation_id: z.string().uuid(),
  }),
  outputSchema: z.object({
    batch_id: z.string().uuid(),
    verdict: z.enum(['clean', 'drift_detected', 'partial_execution', 'out_of_scope']),
    unexecuted_count: z.number().int(),
    content_digest_drift: z.boolean(),
    statement: z.string(),
    statement_signature: z.string(),
  }),
  toolScopes: [
    'plan.read',
    'batch.read',
    'reconciliation.write',
    'ledger.append',
  ],
  escalationConditions: [
    'out_of_scope_executed',
    'content_digest_drift',
    'swept_actions_present',
  ],
  phase: 3,
}
```

---

### 3.2 Pramaan (प्रमाण · Statutory Closure & Proof Attestation Agent)

- **Purpose:** Master synthesis agent for the `CLOSURE` engagement phase.
- **Core Guarantees:**
  1. _Full Provenance Binding:_ Binds Parikshan's findings, Sudhaar's plan, Approver's identity, Karya's execution batches, Samadhan's dual-control certificate, Saakshi's WORM vault manifest, and Lekha's ledger hash.
  2. _Deterministic Offline Verification:_ Generates a `@axiom/report-kit` compliant ZIP pack with embedded `verify_evidence_pack.py` so any third-party auditor can verify hashes offline without cloud access.
  3. _BR-4 Release Gate:_ Operates in `draft` mode until the statutory Founder/DPO gate signs off (`release_report`).

#### TypeScript Contract (`packages/types/src/agents.ts`)

```typescript
pramaan: {
  name: 'pramaan',
  displayName: 'Pramaan',
  oneLiner: 'I turn findings, ledgers, and evidence into unassailable, auditor-ready proof.',
  autonomyLevel: 'L1',
  canMutate: false,
  mutatesClientEstate: false,
  writesAxiomState: true,
  inputSchema: z.object({
    tenant_id: z.string().uuid(),
    engagement_id: z.string().uuid(),
    dossier_type: z.enum(['board_executive', 'dpb_statutory', 'auditor_assurance', 'technical_register']),
    title: z.string().min(1).max(200),
  }),
  outputSchema: z.object({
    dossier_id: z.string().uuid(),
    title: z.string(),
    dossier_type: z.string(),
    status: z.enum(['draft', 'approved', 'published']),
    merkle_root: z.string(),
    manifest_hash: z.string(),
    archive_hash: z.string().nullable(),
    proof_seal_hash: z.string(),
    sealed_at: z.string(),
  }),
  toolScopes: [
    'findings.read',
    'plan.read',
    'reconciliation.read',
    'evidence.read',
    'ledger.read',
    'dossier.write',
    'pdf.render',
  ],
  escalationConditions: [
    'unreconciled_batch_present',
    'ledger_hash_chain_discontinuity',
    'unsealed_evidence_member',
  ],
  phase: 5,
}
```

---

## 4. Implementation Roadmap (Workstreams W11 – W14)

### Workstream W11: Contracts, Enums & Database Foundation (Migration 0072)

- [ ] Add `SAMADHAN: 'samadhan'` and `PRAMAAN: 'pramaan'` to `AgentName` in `packages/types/src/enums.ts`.
- [ ] Add `AgentContract` definitions for both in `packages/types/src/agents.ts`.
- [ ] Add new ledger action types:
  - `EXECUTION_RECONCILIATION_ATTESTED: 'execution.reconciliation.attested'`
  - `CLOSURE_PRAMAAN_DRAFTED: 'closure.pramaan.drafted'`
  - `CLOSURE_PRAMAAN_SEALED: 'closure.pramaan.sealed'`
- [ ] Author **Migration 0072**:
  - Add `reconciled_by_agent` column (`default 'samadhan'`) to `public.plan_reconciliations`.
  - Create table `public.pramaan_dossiers`:
    - Columns: `id`, `tenant_id`, `engagement_id`, `report_id`, `status`, `dossier_type`, `merkle_root`, `manifest_hash`, `archive_hash`, `proof_seal_hash`, `created_by_agent`, `released_by`, `released_at`.
    - Tenant-bound RLS with `service_role` security-definer execution functions.
  - Create function `public.seal_pramaan_dossier(...)` enforcing non-empty reconciliation and unbroken ledger chain.

### Workstream W12: Agent Runtime Classes & Executor Integration

- [ ] Create `services/agent-runtime/src/axiom/agents/samadhan.py`:
  - Implements `SamadhanAgent(BaseAgent[SamadhanInput, SamadhanOutput])`.
  - Encapsulates `reconcile_batch()` and executes post-batch evaluation.
- [ ] Create `services/agent-runtime/src/axiom/agents/pramaan.py`:
  - Implements `PramaanAgent(BaseAgent[PramaanInput, PramaanOutput])`.
  - Gathers engagement artifacts: Parikshan findings, Sudhaar plans, Karya batches, Samadhan reconciliation statements, Lekha ledger root hash, and Saakshi evidence bundles.
- [ ] Update `services/agent-runtime/src/axiom/executor.py`:
  - Attribute reconciliation step directly to `SamadhanAgent`.
  - Pass `samadhan` actor ID to `append_ledger`.
- [ ] Test suites:
  - `services/agent-runtime/tests/test_samadhan.py` (>= 90% coverage).
  - `services/agent-runtime/tests/test_pramaan.py` (>= 90% coverage).

### Workstream W13: BFF Gateway Endpoints & Offline Packaging Kit

- [ ] Extend `@axiom/report-kit`:
  - Include `reconciliation_statement.json` and `ledger_chain_receipt.json` inside the deterministic archive.
  - Update `packages/report-kit/python/verify_evidence_pack.py` to verify the dual-control and ledger receipts offline.
- [ ] Mount BFF routes in `services/bff/src/routes/`:
  - `POST /v1/engagements/:id/closure/pramaan`: Invocable by authorized operators to synthesize the final closure.
  - `POST /v1/dossiers/:id/release`: Strictly guarded by `Capability.REPORT_RELEASE` and `access.founder` (BR-4).
- [ ] Unit & integration tests in `services/bff/src/routes/pramaan-closure.test.ts`.

### Workstream W14: Web Workbench UI, Closure Workflow & Brand Attribution

- [ ] **Execution Console (`apps/web/src/app/(app)/execution/batch-card.tsx`):**
  - Update the reconciliation card to prominently feature **Samadhan · Maker-Checker & Reconciler**.
- [ ] **Reports & Proof Attestation Center (`apps/web/src/app/(app)/reports`):**
  - Clarify the distinction:
    - _Prativedan:_ Generates and displays "Working Reports & Gap Scan Summaries".
    - _Pramaan:_ Generates and displays "Statutory Closure Dossiers & Sealed Attestations".
  - Render the interactive Gold [`ProofSeal`](file:///Users/vikash/Axiom%20Proof/apps/web/src/app/%28app%29/execution/batch-card.tsx#L464) upon verified closure.
- [ ] **Sidebar Agent Drawer (`apps/web/src/app/(app)/sidebar-agent-panel.tsx`):**
  - Add **Samadhan** (linking to `/execution`).
  - Add **Pramaan** (linking to `/reports`).
- [ ] **Marketing Site (`apps/marketing/src/app/agents/page.tsx`):**
  - Update the agent roster to 12 named agents, highlighting the **Sudhaar (Plan) ➔ Karya (Act) ➔ Samadhan (Reconcile) ➔ Pramaan (Prove)** workflow.

---

## 5. Acceptance Criteria & Verification Gates

| Gate                           | Acceptance Requirement                                                                     | Test Tool                              |
| :----------------------------- | :----------------------------------------------------------------------------------------- | :------------------------------------- |
| **G1: Contract Integrity**     | All 12 agents defined in `enums.ts` and `agents.ts` with 0 type errors.                    | `pnpm --filter @axiom/types test`      |
| **G2: Database Immutability**  | Migration 0072 applied; out-of-scope constraint tested; ledger action registered.          | `scripts/test-database.sh`             |
| **G3: Runtime Isolation**      | `Sudhaar.can_mutate == False`, `Samadhan.can_mutate == False`, `Karya.can_mutate == True`. | `uv run pytest services/agent-runtime` |
| **G4: Offline Verification**   | `verify_evidence_pack.py` passes 100% on generated Pramaan ZIP packs.                      | `pnpm --filter @axiom/report-kit test` |
| **G5: End-to-End Walkthrough** | Complete audit trail from finding to sealed Pramaan dossier passes in E2E.                 | `pnpm test:e2e`                        |

---

_Authored for Axiom Proof — Axiom Minds Private Limited._  
_"Agents do the work. You approve. The proof is automatic."_
