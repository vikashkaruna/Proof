# Axiom Proof — Functional flow and technical architecture

### Axiom Minds Private Limited · https://axiomminds.ai

Replaces `LIVE_FUNCTIONAL_FLOW_GUIDE.md` and the architecture parts of
`19_Phase0-5_Extension_Samadhan_Pramaan_Architecture.md` (both now stubs).
The authoritative system architecture is
[04_Solution_Architecture.md](04_Solution_Architecture.md) (four layers,
control vs data plane, execution safety chain, ledger schema, ADRs); this
file links to it and does not repeat it. Visual map:
[10_Systems_Map.html](10_Systems_Map.html). Status of everything described
here: [20_Plan.md](20_Plan.md) section 3. Source tags: `[G]` = the
live-functional-flow guide, `[19]` = the Samadhan/Pramaan spec, `[16]` =
operator runbook, `[08]` = deployment guide.

> **Status caveat.** The flow below is the **intended** end-to-end flow. As of
> 2026-10-01 the production connector write path, the source-bound statutory
> and approval-proof stages, and any deployment are not delivered or accepted
> (see `20_Plan.md`). The staging flow script exercises local Docker/staging
> stacks, not production.

## 1. Functional flow

### 1.1 Chain of custody (12 agents; target, unaccepted) `[19]`

```
Drishti + Vibhaag  -> personal-data inventory and RoPA mapping
Parikshan          -> 46 DPDPA control findings and exposure
Sudhaar (maker)    -> remediation plan + rollbacks + dry-run (read-only, ADR-3)
Client approver    -> MFA step-up + signed, scope-bound approval token (BR-2)
Karya (doer)       -> mutating execution + pre/post state capture (token-gated)
Parikshan          -> post-execution control verification
Samadhan           -> maker-checker reconciliation, zero-drift statement
Saakshi + Lekha    -> S3 Object Lock Compliance vault + append-only ledger entry
Prativedan         -> working registers and executive drafts
Pramaan            -> source-bound closure synthesis, verifiable offline pack
Founder / DPO      -> statutory review and release gate (BR-4) -> client / regulator
```

Also: **Nazar** (regulatory watch: MeitY gazette, DPB) and **Sanket** (market
and incident signals). Roster, autonomy levels and `can_mutate` flags are in
section 2.2.

### 1.2 Walkthrough A: web workbench (interactive) `[G]`

Seeded personas exist for local/staging (founder/super-admin; a fintech DPO
`admin`; a healthcare auditor `reviewer`; a SaaS security lead `approver`).
Credentials are defined only in the seed scripts (`scripts/seed-users.ts`,
`scripts/seed-personas.ts`); they are deliberately not repeated here. A
skip-login bypass is forbidden in every environment `[G]`.

| Step                           | Where (local default `http://localhost:3001`)               | What happens                                                                                                                                                                                                                                |
| ------------------------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 Sign in / sign up            | `/login`, `/login?mode=signup`                              | Strict auth; redirects to the workbench                                                                                                                                                                                                     |
| 2 Onboard organisation         | `/onboarding` or tenant switcher "Onboard New Organization" | Legal name, slug, tier (Growth/Enterprise), statutory flags (SDF s.10, health, children), DPO details, initial repositories; creates tenant, records `tenant.created` in the ledger, binds the account as owner, initialises the engagement |
| 3 Run discovery and assessment | `/workbench`                                                | Run Drishti, Vibhaag, Parikshan (46 controls, DPDPA v0.1.0 per guide), Sudhaar (plans with rollback)                                                                                                                                        |
| 4 Approve                      | `/approval` or `/plans`                                     | Review dry-run diff and validated rollback; "Approve Selected Actions" records rationale and issues an HMAC-SHA256 scope-bound token; Karya dispatched with the token                                                                       |
| 5 Seal and report              | `/evidence`, `/monitoring`, `/reports`, `/ledger`           | Saakshi-sealed artifacts; Nazar/Sanket surveillance; Board Executive Pack and DPB Auditor Dossier; "Verify Cryptographic Chain" on the ledger                                                                                               |

Current reality for step 4-5 (see `20_Plan.md` D10): approval requires a
completed dry-run and validated rollback in every case; historical Pramaan
dossiers are metadata only; only source-bound board and auditor paths are
open; outbound email dispatch is closed.

### 1.3 Walkthrough B: headless script `[G]`

```bash
./scripts/run-staging-flow.sh                       # Linux/macOS, local stack
./scripts/run-staging-flow.sh http://192.168.1.11:4000 http://192.168.1.11:55321 "Zenith Fiduciary Corp"
.\scripts\run-staging-flow.ps1                      # Windows 11
.\scripts\run-staging-flow.ps1 -BffUrl "http://192.168.1.11:4000" -SupabaseUrl "http://192.168.1.11:55321" -OrgName "Zenith Fiduciary Corp"
```

Runs the 13-step flow with dynamically generated account, tenant, engagement
and systems; prints per-agent status and latency (the guide lists Drishti
~40 ms, Parikshan 46 controls, Approval Console token, Karya "token-gated
simulated execution", Saakshi sealing, Nazar, Sanket, Prativedan board pack,
Ledger `intact: true`) and clickable workbench URLs. Karya execution in this
flow is simulated.

### 1.4 Continuous monitoring and regression checks `[G]`

- **Nazar**: watches MeitY gazette/DPB orders; links changes to affected
  control IDs and queues re-assessment in Parikshan.
- **Breach protocol (s.8(6))**: `/breaches` simulates the 6-hour CERT-In and
  72-hour DPB clocks with immutable ledger receipts.
- **Ledger verification** (any officer or auditor):

```bash
curl -s -X POST http://localhost:4000/v1/ledger/verify \
  -H "Authorization: Bearer <JWT>" -H "X-Tenant-Id: <TENANT_UUID>" | jq .
```

Must return `{"intact": true}`; on tampering the first break and sequence
number are reported.

## 2. Technical architecture

### 2.1 Components (monorepo; see AGENTS.md)

| Layer                | Component                                                                                                      | Notes                                                                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Apps                 | `apps/web` (Workbench `app.axiomproof.ai`), `apps/marketing`                                                   | SSR calls the BFF; web/marketing receive no service-role key (Helm fixed in Rev 109)                                                   |
| API / execution gate | `services/bff` (Hono)                                                                                          | Approval-token issuance (dry-run + rollback required, BR-2), capability matrix, idempotency, ledger writes                             |
| Agents               | `services/agent-runtime` (FastAPI, named agents)                                                               | Executor, dry-run, rollback, verification, reconciliation, scheduler (`axiom/scheduler.py`, off unless `feature_continuous_scheduler`) |
| Model                | `services/model-gateway`                                                                                       | PII redaction before egress; self-hosted option                                                                                        |
| Orchestration        | `services/temporal-workers`                                                                                    | Opaque assessment workflow `axiom.assessment.job.v1`; v2 compliance workflow                                                           |
| Data                 | Postgres (self-hosted Supabase in higher envs), S3 Object Lock Compliance (MinIO on-prem)                      | RLS tenant-bound; ledger via SECURITY DEFINER `append_ledger()` only                                                                   |
| Shared               | `packages/{design-tokens,ui,types,control-library,ledger,evidence,approval-engine,supabase,config,report-kit}` | `@axiom/report-kit` carries branding and the offline evidence-pack verifier                                                            |

Architecture-of-record items from the runbook `[16]`:

- **Topology:** public APIs on Cloud Run; one **dedicated private Mumbai runner
  VM per tenant** and a separate private SPIRE issuer VM (Terraform module
  `infra/terraform/modules/workload-vms`, default off); user decision 2026-09-23.
- **Workload identity:** SPIFFE JWT-SVIDs for every agent workload; the
  broker's acquisition endpoint stays deny-all until W4.3/W4.4 enforcement is
  wired. One connector identity per tenant; `connector.write` only for Karya
  with a valid approval token.
- **Dispatch:** encrypted outbox (0044/0045), per-tenant KMS wrapping keys in
  `ap-south-1` / `asia-south1`, persisted dispatch policy fences (0047),
  per-job container isolation (UID 20003 worker; only the controller UID 20000
  holds the daemon socket), claims are single-use and never reset.
- **Execution:** `/internal/execute` consumes claimed batches through a
  write-adapter seam; blast-radius governor; stop-on-failure; kill switch;
  rollback in reverse order; reconciliation statement HMAC-signed with the
  approval signing key (0061-0063).
- **Discovery:** read-only SQL (PostgreSQL, MySQL) and REST/GraphQL transports
  return metadata and value-shape counts only, recorded before being returned
  (0059).
- **Proof boundary (0089):** founder review/release and proof mutations are
  callable only by the BFF through the `statutory_proof_writer` role, not by
  shared `service_role` `[A98]`. Migration 0099 (untested draft) is meant to
  extend this boundary to `append_ledger` and the execution gate; see
  `21_Progress.md` section 2.

### 2.2 Agent roster `[19]` (target; Samadhan and Pramaan not accepted as deployed)

| #   | Agent      | Function                     | Level / mutation                       |
| --- | ---------- | ---------------------------- | -------------------------------------- |
| 1   | Drishti    | Discovery                    | L1 autonomous                          |
| 2   | Vibhaag    | Classification               | L1                                     |
| 3   | Parikshan  | Assessment (46 controls)     | L1                                     |
| 4   | Sudhaar    | Planning (maker)             | L1, strictly read-only (ADR-3)         |
| 5   | Karya      | Execution (doer)             | L2 approval-gated; only mutating agent |
| 6   | Samadhan   | Maker-checker and reconciler | L1, `can_mutate=false`                 |
| 7   | Saakshi    | Evidence vault (WORM)        | L1                                     |
| 8   | Lekha      | Ledger custodian             | L1                                     |
| 9   | Prativedan | Draftsman (working docs)     | L1                                     |
| 10  | Pramaan    | Statutory closure and proof  | L1 + founder/DPO release seal          |
| 11  | Nazar      | Regulatory watch             | L1                                     |
| 12  | Sanket     | Market signals               | L1                                     |

### 2.3 Samadhan and Pramaan contracts `[19]`

**Samadhan.** Facts come from the database (`approval_tokens`,
`execution_batches`). Out-of-scope execution fails `out_of_scope_executed`;
digest recomputed at settle time, mismatch flagged `content_digest_drift`;
statement signed HMAC-SHA256 with the batch's `approval_signing_key`.
Contract (`packages/types/src/agents.ts`): input `tenant_id, plan_id, batch_id,
correlation_id`; output `verdict` in `clean | drift_detected |
partial_execution | out_of_scope`, `unexecuted_count`, `content_digest_drift`,
`statement`, `statement_signature`; tool scopes `plan.read, batch.read,
reconciliation.write, ledger.append`; escalations `out_of_scope_executed,
content_digest_drift, swept_actions_present`; phase 3.

**Pramaan.** Binds findings, plan, approver identity, execution batches,
Samadhan certificate, Saakshi manifest and Lekha ledger hash; produces a
deterministic `@axiom/report-kit` ZIP with an embedded
`verify_evidence_pack.py`; stays `draft` until the founder/DPO gate
(`release_report`, BR-4). Input `tenant_id, engagement_id, dossier_type`
(`board_executive | dpb_statutory | auditor_assurance | technical_register`),
`title`; output `dossier_id, status (draft|approved|published), merkle_root,
manifest_hash, archive_hash, proof_seal_hash, sealed_at`; tool scopes
`findings.read, plan.read, reconciliation.read, evidence.read, ledger.read,
dossier.write, pdf.render`; escalations `unreconciled_batch_present,
ledger_hash_chain_discontinuity, unsealed_evidence_member`; phase 5. **Gold
ProofSeal and any statutory attestation must not be claimed before exact
source/archive object versions and review are independently verified.**

Current implementation boundary `[A98]`: only `board_executive` has an
authoritative source contract (published board report from a finalized
assessment, its frozen request/source packet, exact retained source JSON and
PDF versions); `dpb_statutory`, `auditor_assurance`, `technical_register` and
`full_closure` return `source_bound_dossier_required`.

### 2.4 Implementation checklist for the two agents

Carried over from `[19]` roadmap; all items were unchecked in the source.
Tracked as work under W8.4/W8.5 in `20_Plan.md` section 8.

- [ ] `AgentName` enum, `AgentContract`s, three ledger action types, `plan_reconciliations.reconciled_by_agent`, table `pramaan_dossiers`, `seal_pramaan_dossier(...)`
- [ ] `samadhan.py`, `pramaan.py`, executor attribution; tests >= 90% coverage
- [ ] report-kit additions (`reconciliation_statement.json`, `ledger_chain_receipt.json`) and offline verifier extension; BFF closure/release routes
- [ ] Web: execution console Samadhan card, Reports page Prativedan/Pramaan split, sidebar entries, marketing roster of 12; Gold `ProofSeal` only on verified closure

### 2.5 Brand rules (AGENTS.md)

Indigo `#1E2A4A` trust; Teal `#0FB5A5` machine intelligence/approvals; Gold
`#C9A227` **reserved for sealed evidence and attestations only**; Ember
`#D9534F` gaps/risks; Slate/Mist neutrals.
