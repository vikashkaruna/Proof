# Axiom Proof — Solution Architecture

### Layered, Evolutionary, Agent-Native Platform Architecture

**Axiom Minds Private Limited** · https://axiomminds.ai
**Document:** 04 of 05 · **Version:** 1.0 · **Date:** August 2026

## Accepted deployment clarification — 23 September 2026

The user selected a **dedicated Mumbai runner VM per tenant** for isolated per-job workers and the SPIRE node agent in higher environments. Public APIs remain on Cloud Run. The runner belongs to the trusted backend layer; Docker control and node-attestation access are not exposed to public API processes or workers. Each job retains private namespaces, network denial, a read-only Workload API mount and scoped tool calls. Protected node bootstrap, trust-bundle delivery and controller/opaque-scheduler deployment composition remain implementation gates; this decision does not mean a VM was provisioned. The separate private SPIRE issuer remains shared; each tenant runner has its own instance, private address, service account and state disk. Preserve the controller’s one-tenant scope and verify its assigned VM/node before activation. Tenant-scoped backend credentials, effective cloud permissions and signed scheduler authorization remain separate requirements. See Doc 16, Revision 69, for the current placement and operator sequence. Local Docker/Supabase acceptance remains the development topology.

---

## 1. ARCHITECTURAL PRINCIPLES

| #    | Principle                                             | Implication                                                                                                                                                     |
| ---- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AP-1 | **Approval is architectural, not procedural**         | Execution is physically impossible without a valid approval token. Not a code convention that can be forgotten — a gate in the execution path.                  |
| AP-2 | **Everything is evidence**                            | Every agent action emits a signed, hashed record. The ledger is not a log; it is a product surface.                                                             |
| AP-3 | **Agents are services, not scripts**                  | Each agent is independently deployable, versioned, observable and replaceable.                                                                                  |
| AP-4 | **Start modular monolith, evolve to services**        | A solo founder cannot operate twelve microservices in Phase 1. Build with clean internal module boundaries so extraction is mechanical later.                   |
| AP-5 | **Model-agnostic**                                    | The LLM is a swappable dependency behind an abstraction, never a hard-coded vendor call. Enables self-hosted models for on-prem in Phase 5.                     |
| AP-6 | **Control plane / data plane separable from day one** | Even while single-deployment, keep orchestration logically separate from data-touching execution, so Phase 5 split-plane is a deployment change, not a rewrite. |
| AP-7 | **India data residency by default**                   | All personal data stays in Indian regions. Non-negotiable.                                                                                                      |
| AP-8 | **Read-only until explicitly granted otherwise**      | Write capability is a separate, scoped, time-bound, revocable grant.                                                                                            |

---

## 2. LAYERED ARCHITECTURE OVERVIEW

```
┌──────────────────────────────────────────────────────────────────────┐
│  LAYER 1 — EXPERIENCE / PRESENTATION                                 │
│  Client Portal · Approval Console · Agent Workbench · Partner Portal │
│  Public gap-scan · Report viewer · Evidence explorer                 │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ HTTPS / WSS
┌───────────────────────────────▼──────────────────────────────────────┐
│  LAYER 2 — API & SERVICE LAYER                                       │
│  API Gateway · BFF · AuthN/AuthZ · Tenant resolution · Rate limiting │
│  REST + GraphQL · WebSocket (live agent progress) · Webhooks         │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ internal contracts / message bus
┌───────────────────────────────▼──────────────────────────────────────┐
│  LAYER 3 — BACKEND MIDDLE LAYER (the agentic core)                   │
│                                                                       │
│  ┌─ CONTROL PLANE ────────────────────────────────────────────────┐  │
│  │ Agent Orchestrator · Workflow/State Engine · Approval Engine   │  │
│  │ Policy & Guardrail Engine · Control Library Service            │  │
│  │ Scheduler · Event Bus · Model Gateway (LLM abstraction)        │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                       │
│  ┌─ AGENT RUNTIME ────────────────────────────────────────────────┐  │
│  │ Drishti · Vibhaag · Parikshan · Saakshi · Sudhaar              │  │
│  │ Karya · Lekha · Nazar · Prativedan · Sanket                    │  │
│  │ Tool/MCP Server registry · Sandbox · Context assembler          │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                       │
│  ┌─ DATA PLANE (execution surface) ───────────────────────────────┐  │
│  │ Connector Framework · Discovery Engine · Dry-Run Simulator     │  │
│  │ Execution Engine · Rollback Engine · Blast-Radius Governor     │  │
│  │ Evidence Pipeline · Verification Engine                        │  │
│  └────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────┬──────────────────────────────────────┘
                                │
┌───────────────────────────────▼──────────────────────────────────────┐
│  LAYER 4 — DATA & PERSISTENCE                                        │
│  PostgreSQL (transactional) · Audit Ledger (append-only, hash-chain) │
│  Object Store (evidence, WORM) · Vector DB (regulatory RAG)          │
│  Redis (cache/queue) · Search Index · Time-series (metrics)          │
└──────────────────────────────────────────────────────────────────────┘

  CROSS-CUTTING: Observability · Secrets/KMS · Tenancy · Security · CI/CD
```

---

## 3. LAYER 1 — EXPERIENCE / PRESENTATION

### 3.1 Surfaces

| Surface                    | User                   | Phase | Purpose                                                                     |
| -------------------------- | ---------------------- | ----- | --------------------------------------------------------------------------- |
| **Public site + gap-scan** | Prospect               | 0     | Marketing, lead capture, free assessment                                    |
| **Agent Workbench**        | Founder                | 0     | Run agents, review outputs, manage prompts/versions — the founder's cockpit |
| **Approval Console**       | Client compliance head | 3     | ⭐ The most important screen in the product                                 |
| **Client Portal**          | Client team            | 3     | Posture, gaps, evidence, reports, pending approvals                         |
| **Evidence Explorer**      | Client / auditor       | 2     | Browse, verify and export sealed evidence                                   |
| **Partner Portal**         | Channel partner        | 4     | Multi-client management, branded output                                     |

### 3.2 The Approval Console — design requirements

This screen carries the product's entire trust proposition. It must show, for every action, without the user hunting for it:

1. **What** — plain-language description of the action, plus its typed technical definition
2. **Why** — the gap it closes, with the control and statutory citation
3. **What changes** — the dry-run diff, rendered as a readable before/after
4. **How big** — blast radius: records, systems and users affected
5. **How risky** — risk score with the reasoning behind it
6. **How to undo** — the generated rollback plan, in full
7. **Approve controls** — approve all / approve selected / approve individually / reject with reason / defer

Design rule: **an approver must never have to trust the agent to approve safely.** Everything needed to make an informed decision is on the screen. If the diff cannot be rendered legibly, the action is not eligible for agent execution and must be routed to manual handling.

### 3.3 Technology

- **Next.js (React) + TypeScript**, server components for report-heavy views
- **Tailwind CSS** with brand tokens (Deep Indigo / Signal Teal / Seal Gold)
- **WebSocket** for live agent progress streaming — users must see agents working, not a spinner
- **Server-side PDF generation** for reports and evidence packs
- Hosted on managed edge/serverless with Indian-region origin

---

## 4. LAYER 2 — API & SERVICE LAYER

### 4.1 Responsibilities

| Component                      | Function                                                                           |
| ------------------------------ | ---------------------------------------------------------------------------------- |
| **API Gateway**                | TLS termination, routing, rate limiting, request signing, WAF                      |
| **BFF (Backend-for-Frontend)** | Surface-specific aggregation; keeps clients thin                                   |
| **AuthN**                      | OIDC; email+MFA in Phase 1; SSO/SAML in Phase 5                                    |
| **AuthZ**                      | RBAC → ABAC evolution; roles: Owner, Approver, Reviewer, Viewer, Partner, Agent    |
| **Tenant Resolver**            | Resolves tenant on every request; injects tenant context into all downstream calls |
| **Idempotency Service**        | Idempotency keys on all mutating operations                                        |
| **Webhook Dispatcher**         | Outbound events to client systems (approval pending, execution complete)           |

### 4.2 API design

- **REST** for CRUD and command operations; **GraphQL** for the dashboard's aggregate reads
- **WebSocket/SSE** for agent progress and approval notifications
- Versioned (`/v1/`), contract-first (OpenAPI + JSON Schema)
- **Every mutating endpoint requires an idempotency key and emits a ledger entry**

### 4.3 Critical API contract — the execution gate

```
POST /v1/remediation/plans/{planId}/execute
Headers: Idempotency-Key, Authorization
Body: {
  approvalToken: "<signed, single-use, scope-bound>",
  mode: "batch" | "individual",
  actionIds: [...],              // subset permitted (partial approval)
  concurrency: <int>,
  stopOnFailure: <bool>
}
```

The `approvalToken` is **cryptographically signed by the Approval Engine**, bound to a specific plan version, a specific action set, a specific approver identity, and an expiry. The Execution Engine **validates the token before every single action** — not once at batch start. A token that does not cover a given action ID causes that action to be skipped and flagged, not executed.

This is how AP-1 (approval is architectural) is realised concretely: there is no code path from API to execution that does not pass through signature validation.

---

## 5. LAYER 3 — BACKEND MIDDLE LAYER (the agentic core)

### 5.1 Control Plane

| Service                       | Responsibility                                                                                                                                                                                |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Agent Orchestrator**        | Plans and dispatches agent work; manages multi-agent workflows; handles retries, timeouts, partial failure                                                                                    |
| **Workflow / State Engine**   | Durable state machine per engagement: `discovery → classification → assessment → evidence → planning → dry-run → approval → execution → verification → closure`. Survives restarts; resumable |
| **Approval Engine**           | Issues, validates, expires and revokes signed approval tokens. Single source of truth for "is this permitted?"                                                                                |
| **Policy & Guardrail Engine** | Evaluates standing policies (Phase 4 L3), blast-radius caps, environment rules, escalation triggers                                                                                           |
| **Control Library Service**   | Versioned DPDPA control catalogue with citations, evidence requirements and remediation patterns; multi-framework mapping from Phase 4                                                        |
| **Scheduler**                 | Cron and event-driven agent runs (scheduled re-discovery, monitoring, regulatory watch)                                                                                                       |
| **Event Bus**                 | Async backbone; every domain event published (`DiscoveryCompleted`, `PlanGenerated`, `ApprovalGranted`, `ExecutionFailed`)                                                                    |
| **Model Gateway**             | LLM abstraction: provider routing, prompt/version registry, token accounting, caching, fallback, PII redaction before egress                                                                  |

**Model Gateway detail (important for cost and portability):** every model call passes through here, which gives one chokepoint for (a) swapping providers, (b) per-tenant cost attribution against NFR-11, (c) redacting personal data before it ever reaches a model provider, and (d) recording the prompt hash and model version into the ledger for reproducibility. Without this chokepoint, an agentic product becomes un-auditable and cost-unpredictable — both fatal for a bootstrapped compliance vendor.

### 5.2 Agent Runtime

Each agent is a versioned service with a declared contract: inputs, tool permissions, output schema, autonomy level, and escalation conditions.

| Agent                    | Autonomy ceiling                  | Tool permissions                                          |
| ------------------------ | --------------------------------- | --------------------------------------------------------- |
| Drishti (Discovery)      | L1 (current; L2 read-only target) | Connector read; inventory/evidence record writes          |
| Vibhaag (Classification) | L1 (current; L2 target)           | None (operates on discovery output)                       |
| Parikshan (Assessment)   | L1 (current; L2 target)           | Control Library read; findings record writes              |
| Saakshi (Evidence)       | L1 (current; L2 target)           | Evidence store **write-once**                             |
| Sudhaar (Planning)       | L2 — proposes only                | Read-only; **can never execute**                          |
| **Karya (Execution)**    | **L2 — requires approval token**  | Connectors: **write, scoped, token-gated**                |
| Lekha (Audit)            | L1 (current; L2 target)           | Ledger **append-only**                                    |
| Nazar (Regulatory)       | L1 (current; L2 target)           | Government-source read; regulatory-signal proposals       |
| Prativedan (Reporting)   | L1 (current; L2 target)           | Findings/evidence/Control Library read; report generation |
| Sanket (Signal)          | L1 (current; L2 target)           | External sources read (internal use)                      |

The current ceilings above match the implemented Phase 0–3 runtime contracts in
`packages/types/src/agents.ts` and `services/agent-runtime`. L2/L3 values in
earlier drafts were roadmap targets, not deployed permissions. Karya remains the
only agent permitted to mutate client systems, subject to approval and execution gates.

`canMutate`/`can_mutate` is retained as a compatibility alias for the explicit
`mutatesClientEstate`/`mutates_client_estate` field. `writesAxiomState`/
`writes_axiom_state` describes changes to domain records (including proposals),
excluding ordinary run telemetry. Neither metadata field grants credentials.
The W4.3 identity/registration verification core is implemented, but shared-runtime
workload isolation and every-tool scope enforcement remain pending; the current
broker factory denies all acquisition. Prativedan read declarations must become
tenant/estate-scoped checks at each data access, not a replacement for them.

**Separation-of-duties design:** the agent that _plans_ (Sudhaar) is architecturally distinct from the agent that _executes_ (Karya), and Sudhaar holds no write credentials whatsoever. A planning agent cannot execute its own plan even if compromised or misbehaving. This mirrors the maker-checker principle Indian compliance buyers already understand from banking, and it is a genuine security property, not a talking point.

**Tool/MCP Server Registry:** agent capabilities are exposed as declared tools with explicit permission scopes. Every tool invocation is logged with arguments and results. Tools are sandboxed; network egress is allowlisted.

### 5.3 Data Plane

| Component                 | Function                                                                                                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Connector Framework**   | Pluggable adapters with a common contract: `authenticate → enumerate → sample → read → (write)`. Read and write are separate interfaces with separate credential scopes |
| **Discovery Engine**      | Batch and targeted scanning; incremental/delta; parallelism control; rate limiting to avoid impacting client production                                                 |
| **Dry-Run Simulator**     | Executes the action against a shadow/read-only path; computes and renders the diff; results are hashed and time-bound                                                   |
| **Execution Engine**      | Token-validated, idempotent, ordered execution; per-action pre/post state capture; concurrency and stop-on-failure control                                              |
| **Rollback Engine**       | Executes generated rollback plans; supports automatic trigger on failure threshold; rollback is itself dry-run-able                                                     |
| **Blast-Radius Governor** | Pre-flight and in-flight enforcement of caps; halts and escalates on breach; enforces production/non-production rules                                                   |
| **Evidence Pipeline**     | Normalises, hashes, seals and stores artifacts; links to controls; builds export packs                                                                                  |
| **Verification Engine**   | Post-execution re-assessment of targeted controls; produces closure evidence                                                                                            |

### 5.4 The execution safety chain (end to end)

```
Gap identified (Parikshan)
   → Typed action generated (Sudhaar) ── includes mandatory rollback plan
      → Policy/guardrail pre-check (Policy Engine)
         → Dry-run executed (Simulator) ── produces diff + hash, time-bound
            → Presented for approval (Approval Console)
               → Human approves: all / selected / individual ── reason captured
                  → Signed approval token issued (Approval Engine)
                     → Blast-radius pre-flight check (Governor)
                        → Per-action token validation (Execution Engine)
                           → Execute (Karya) ── pre/post state captured
                              → Verify (Verification Engine)
                                 → Seal closure evidence (Saakshi)
                                    → Ledger entry (Lekha)

  FAILURE at any point → Rollback Engine → escalate → log both failure and rollback
  KILL SWITCH → halts all in-flight execution immediately, globally
```

---

## 6. LAYER 4 — DATA & PERSISTENCE

### 6.1 Stores

| Store              | Technology                                                                    | Contents                                                                   | Why                                                                   |
| ------------------ | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **Transactional**  | PostgreSQL 16+                                                                | Tenants, users, engagements, controls, findings, plans, actions, approvals | ACID; relational integrity matters for compliance data                |
| **Audit Ledger**   | PostgreSQL append-only table + hash chain (→ dedicated ledger store at scale) | Every agent and human action                                               | Tamper-evident; independently verifiable                              |
| **Evidence Store** | S3-compatible object store, India region, versioning + object lock (WORM)     | Evidence artifacts, reports, dry-run diffs, snapshots                      | Immutability is the product                                           |
| **Vector DB**      | pgvector (Phase 0–3) → dedicated vector store (Phase 4+)                      | Regulatory corpus, control library, precedent for RAG                      | Start inside Postgres to minimise operational load for a solo founder |
| **Cache / Queue**  | Redis                                                                         | Sessions, rate limits, job queues, agent state                             | Standard                                                              |
| **Search**         | Postgres FTS (early) → OpenSearch (Phase 4)                                   | Evidence and finding search                                                | Defer complexity                                                      |
| **Metrics**        | Time-series (Prometheus-compatible)                                           | Ops and cost telemetry                                                     | Cost-per-client tracking (NFR-11)                                     |

**Deliberate simplicity note:** Phases 0–3 run on **PostgreSQL + object store + Redis only** — pgvector handles embeddings, Postgres FTS handles search. A solo founder adding a dedicated vector database and a search cluster in Phase 1 is buying operational burden they cannot service. Each store is promoted out of Postgres only when a measured limit is hit.

### 6.2 Audit ledger design

```
audit_ledger
─────────────────────────────────────────────
  id                  bigserial PK
  tenant_id           uuid
  correlation_id      uuid          -- ties a full chain together
  sequence_no         bigint        -- per-tenant monotonic
  actor_type          enum(agent|human|system)
  actor_id            text          -- agent name or user id
  agent_version       text
  model_id            text          -- e.g. provider/model@version
  prompt_hash         text
  action_type         text
  target_ref          text          -- system/resource acted upon
  input_hash          text
  output_hash         text
  approval_token_id   uuid NULL     -- present for all mutating actions
  approver_id         uuid NULL
  pre_state_ref       text NULL     -- object store pointer
  post_state_ref      text NULL
  result              enum(success|failure|rolled_back|skipped)
  occurred_at         timestamptz
  prev_entry_hash     text          -- hash chain
  entry_hash          text          -- H(this entry || prev_entry_hash)
─────────────────────────────────────────────
INSERT-ONLY. No UPDATE, no DELETE — enforced by DB role permissions,
not application code.
```

Chain integrity is verifiable by recomputing hashes from genesis. Periodic chain checkpoints are sealed into the evidence store. **A client can hand this ledger to an auditor or the DPB and it stands on its own** — which is the entire point of the product being called Proof.

### 6.3 Multi-tenancy

- **Phase 0–3:** shared database, `tenant_id` on every table, PostgreSQL Row-Level Security enforced at the database role level (not application filtering — application-level tenant filtering is a bug waiting to happen)
- **Phase 4:** schema-per-tenant for larger clients
- **Phase 5:** dedicated database or full split-plane for enterprise
- Per-tenant encryption keys via KMS throughout

---

## 7. CROSS-CUTTING CONCERNS

| Concern               | Approach                                                                                                                                |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Observability**     | OpenTelemetry traces spanning agent workflows; structured logs; correlation ID from API request through every agent hop to ledger entry |
| **Secrets**           | Managed KMS/secrets manager; client connector credentials encrypted per-tenant; write credentials time-bound and auto-expiring          |
| **Security**          | Least privilege, network egress allowlisting, agent sandboxing, dependency scanning, SAST in CI                                         |
| **Cost control**      | Per-tenant token and infrastructure attribution via Model Gateway; alerting on cost-per-client breaching 15% of ACV                     |
| **CI/CD**             | Trunk-based; automated tests; agent prompt/version changes are versioned artifacts subject to the same review as code                   |
| **Prompt governance** | Prompts are versioned, hashed, and recorded in the ledger — a compliance product cannot have untracked prompt drift                     |
| **Disaster recovery** | Cross-AZ within India region; RPO ≤ 1h, RTO ≤ 4h; ledger and evidence store replicated                                                  |

---

## 8. DEPLOYMENT EVOLUTION

| Phase   | Topology                                                                                                                                          | Rationale                                                                           |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **0–1** | Single managed container + managed Postgres + object store                                                                                        | One person cannot operate more; cost near-zero                                      |
| **2–3** | Modular monolith + separate agent worker pool + queue; managed services throughout                                                                | Agents scale independently of API without full microservice overhead                |
| **4**   | Extract high-load services (Discovery, Execution, Model Gateway) into separate deployables; horizontal scaling                                    | Extraction is mechanical because module boundaries were clean from the start (AP-4) |
| **5**   | **Split-plane:** hosted control plane + customer-perimeter data plane (Kubernetes appliance); optional air-gapped variant with self-hosted models | Enterprise/BFSI/government data-residency demand                                    |

**Why the split-plane is cheap later if designed for now:** the Control Plane never touches client personal data — it holds plans, approvals, policies and ledger metadata. The Data Plane touches personal data — discovery, execution, evidence capture. If that boundary is respected from Phase 1 (which costs nothing to maintain as a discipline), then Phase 5 split-plane deployment is a packaging and networking exercise, not an architectural rewrite. Violating this boundary early is the single most expensive mistake available in this design.

---

## 9. TECHNOLOGY STACK SUMMARY

| Layer         | Choice                                                                    | Rationale                                                                          |
| ------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Frontend      | Next.js + TypeScript + Tailwind                                           | Solo-founder velocity; SSR for reports; large agent-assisted ecosystem             |
| API           | Node/TypeScript (Hono BFF)                                                | Single language across the API tier; Python/FastAPI is reserved for agent services |
| Agent runtime | Python                                                                    | Best AI/ML ecosystem; MCP tooling maturity                                         |
| Orchestration | Durable workflow engine (Temporal-class) or Postgres-backed state machine | Must survive restarts mid-workflow                                                 |
| Datastore     | PostgreSQL + pgvector                                                     | One database does transactional, audit, vector and search early                    |
| Object store  | S3-compatible, India region, object lock                                  | WORM evidence                                                                      |
| Queue         | Redis / managed queue                                                     | Simplicity                                                                         |
| LLM           | Provider-abstracted via Model Gateway                                     | Portability; self-hosted option Phase 5                                            |
| Infra         | Managed containers, India region                                          | Minimal ops burden for one person                                                  |

**Language pragmatism:** TypeScript for the web tier and Python for the agent tier is the one place where two languages is justified — the agent ecosystem is Python-native and fighting that costs more than the context switch. Everywhere else, resist adding a language.

---

## 10. ARCHITECTURE DECISION RECORDS (key decisions)

| ADR    | Decision                                                     | Rationale                                                                    | Revisit when                              |
| ------ | ------------------------------------------------------------ | ---------------------------------------------------------------------------- | ----------------------------------------- |
| ADR-1  | Modular monolith before microservices                        | Solo operator cannot run a distributed system                                | Load or team size forces extraction       |
| ADR-2  | Approval enforced by signed token validated per-action       | Makes unapproved execution architecturally impossible, not merely prohibited | Never — this is foundational              |
| ADR-3  | Planning agent holds no write credentials                    | Separation of duties; compromised planner cannot act                         | Never                                     |
| ADR-4  | pgvector before dedicated vector DB                          | Operational simplicity outweighs marginal performance at this scale          | Retrieval latency or corpus size degrades |
| ADR-5  | Append-only ledger with DB-role-enforced immutability        | Application-enforced immutability is not immutability                        | Never                                     |
| ADR-6  | Control plane / data plane boundary respected from Phase 1   | Makes Phase 5 split-plane a packaging change                                 | Never                                     |
| ADR-7  | Model access only via Model Gateway                          | Cost attribution, PII redaction, reproducibility, portability                | Never                                     |
| ADR-8  | Row-Level Security for tenancy, not app-layer filtering      | Eliminates an entire class of cross-tenant leak bugs                         | Schema-per-tenant migration               |
| ADR-9  | Dry-run mandatory before approval eligibility                | Informed approval is the trust proposition                                   | Never                                     |
| ADR-10 | Rollback plan generated at planning time, not execution time | A rollback designed under pressure is not a rollback                         | Never                                     |

---

## 11. PHASE-TO-ARCHITECTURE MAPPING

| Phase | Layers built                                                                                                                                                                                              |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0** | Current: L0/L1 workbench, gap-scan, Parikshan, Prativedan, control library, API/auth, and Postgres/object-store integrations.                                                                             |
| **1** | Current: L1 Drishti, Vibhaag, Sudhaar, Saakshi, review console, and typed generator cores; production delivery integrations remain tracked TODOs.                                                         |
| **2** | Current: approval engine, audit ledger, evidence client, model gateway, and shared repeatability paths; live connectors and full persistence are not yet production-complete.                             |
| **3** | Current: approval-gated Karya path, dry-run/rollback safety contracts, client portal, and completed quality audit; mTLS, live connector execution, and external infrastructure verification remain TODOs. |
| **4** | Planned: standing-policy autonomy, multi-framework control library, service extraction, and partner portal.                                                                                               |
| **5** | Planned: split-plane deployment, on-prem packaging, self-hosted model support, and enterprise auth.                                                                                                       |
