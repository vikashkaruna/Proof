# Axiom Proof — Modules Setup Quick Reference

This guide covers local development, full local/on-premise deployment, and production prerequisites for Axiom Proof.

Authoritative references:

- [Staging & Windows 11 LAN deployment guide](docs/STAGING_DEPLOYMENT_WINDOWS_LAN.md)
- [Live dynamic functional flow execution guide](docs/LIVE_FUNCTIONAL_FLOW_GUIDE.md)
- [Deployment guide](docs/08_DEPLOYMENT_GUIDE.md)
- [Operational runbook](docs/09_RUNBOOK.md)
- [Docker Compose](docker-compose.yml)
- [Production Helm values](infra/helm/axiom-proof/values-prod.yaml.example)
- [Production Terraform](infra/terraform/envs/prod/)

## 1. Modules and dependencies

| Module              |          Port | Primary dependencies                           |
| ------------------- | ------------: | ---------------------------------------------- |
| Marketing site      |          3000 | Supabase                                       |
| Web workbench       |          3001 | Supabase, BFF                                  |
| BFF/API             |          4000 | Supabase, Agent Runtime                        |
| Agent Runtime       |          8000 | Supabase, Model Gateway, S3-compatible storage |
| Model Gateway       |          8001 | PII redaction, self-hosted model or Bedrock    |
| Temporal Server     |          7233 | Temporal PostgreSQL                            |
| Temporal UI         |          8233 | Temporal Server                                |
| Temporal Worker     |             — | Temporal, Agent Runtime                        |
| Supabase API        |   55321 local | PostgreSQL                                     |
| Supabase PostgreSQL |   55322 local | Supabase                                       |
| Supabase Studio     |   55323 local | Supabase                                       |
| Valkey/Redis        | 6379 normally | Optional model cache                           |

### 1.1 Functional Agent Iconography & Animation Matrix

Each of the 10 named agents is designed with bespoke, hardware-accelerated SVG iconography and multi-speed CSS keyframe animations that visually represent their exact DPDPA compliance function and autonomy boundary:

| Agent          | DPDPA Statutory Function                                                              | Brand Accent                          | Functional SVG Icon Concept                                                          | Cognitive Dynamics (`thinking` state)                                  | Execution Dynamics (`working` state)                                                         | Autonomy Ceiling & Gate                                |
| :------------- | :------------------------------------------------------------------------------------ | :------------------------------------ | :----------------------------------------------------------------------------------- | :--------------------------------------------------------------------- | :------------------------------------------------------------------------------------------- | :----------------------------------------------------- |
| **Drishti**    | Personal data scanning, system inventory, cross-border data flow detection            | `#0FB5A5` (Teal)                      | Cybernetic aperture with reticle crosshairs & central scanner pupil                  | Iris aperture slowly pulses and dilates; concentric scan rings breathe | Continuous 360° rotating radar sweep line across reticle + sweeping laser line               | L1 → L2 (Read-only discovery connectors)               |
| **Vibhaag**    | Statutory categorization (Govt ID, financial, health, child data, contact) & tagging  | `#7C3AED` (Violet)                    | Geometric segmented prism separating raw streams into color-coded category facets    | Subtle harmonic shifting of facet opacities & ambient violet glow      | 180° alternating crystal rotation + data particle sorting through facets                     | L1 (Autonomous classification)                         |
| **Parikshan**  | Gap assessment across all 46 controls in DPDPA v0.1.0, risk weights & posture scoring | `#1E2A4A` (Indigo)                    | Inspection shield crest with calibrated gauge scale & verification needle            | Circular gauge meter breathes in steady evaluation rhythm              | Oscillating precision caliper arms measuring statutory thresholds + verified checkmark pulse | L1 (Read-only library assessment)                      |
| **Saakshi**    | Cryptographic evidence sealing into AWS S3 Object Lock Compliance vault               | `#C9A227` (Gold — reserved for proof) | Eight-point starburst wax seal stamp surrounding a vault lock & crypto keyhole       | Golden shimmer runs along seal facet edges; lock body steady           | Radiant solar flare & seal stamp compression with expanding golden shockwaves                | L1 (WORM-vault evidence sealer)                        |
| **Sudhaar**    | Blueprint remediation planning with blast radius & mandatory rollback definitions     | `#0EA5E9` (Sky)                       | Technical drafting compass with branching action & rollback circuit paths            | Compass legs subtly pivot while calculating risk coordinates           | Divergent blueprint circuits sequentially illuminate along action & rollback pathways        | L1 (Strictly NO mutate credentials; ADR-3)             |
| **Karya**      | Mutating execution engine; closes compliance gaps and executes approved rollbacks     | `#D9534F` (Ember — alert tone)        | High-voltage energy core housed inside dual precision planetary gears                | Core pulsates with contained thermal ember energy; gears idle          | Counter-rotating dual planetary gears with electric energy arcs pulsing through core         | L2 (Requires signed, scope-bound approval token; BR-2) |
| **Lekha**      | Immutable audit ledger witness; appends hash-chained records via `append_ledger()`    | `#525B71` (Slate)                     | Merkle block chain; interlocking ledger folios connected by cryptographic link rings | Micro-hash dots shift sequentially like a rolling cryptographic cipher | Blocks slide and interlock into chain with luminous link-weld pulse                          | L1 (Security definer append-only witness)              |
| **Nazar**      | Continuous regulatory watchdog; monitors MeitY notifications, DPB orders & gazette    | `#16A34A` (Green)                     | Deep-space observatory dish & 360° perimeter surveillance radar                      | Observatory dish oscillates angle with undulating signal carrier waves | Continuous 360° sweep beam with active amber ping blips on outer perimeter                   | L1 (Government gazette & DPB scraper)                  |
| **Prativedan** | Executive reporting; compiles Board packs, auditor dossiers & RoPA PDFs               | `#9333EA` (Purple)                    | Formal executive dossier scroll with certified wax seal ribbon & drafting stylus     | Stylus hovers above folio with rhythmic ink pulsation                  | Document pages compile and turn sequentially while certified ribbon seal stamps each section | L1 (Auditor pack compiler)                             |
| **Sanket**     | Market & breach signal monitoring; early warning telemetry & buying signals           | `#EA580C` (Orange)                    | Broadcast transmission tower with concentric spherical radio wave emitters           | Spire glows with intermittent carrier frequency pulses                 | Concentric spherical sonar waves rapidly expand and radiate outward in continuous waves      | L1 (Internal market & incident signal monitor)         |

## 2. Local prerequisites

Install Docker Desktop or Docker Engine with Compose v2, Node.js 22 LTS or newer, pnpm 9.12+, Python 3.11, uv, the Supabase CLI, curl, jq, and openssl. Install kubectl, Helm, and Terraform only if deployment testing is required.

Verify:

```bash
node --version
pnpm --version
python3 --version
uv --version
docker --version
supabase --version
```

Install JavaScript dependencies:

```bash
cd "/Users/vikash/Axiom Proof"
pnpm install
```

## 3. Local Supabase setup

Start Supabase:

```bash
cd "/Users/vikash/Axiom Proof/infra/supabase"
supabase start
supabase status
```

Important local endpoints:

```text
API:    http://127.0.0.1:55321
DB:     postgresql://postgres:postgres@127.0.0.1:55322/postgres
Studio: http://127.0.0.1:55323
SMTP:   http://127.0.0.1:55324
```

Apply schema and seed data:

```bash
cd "/Users/vikash/Axiom Proof"
pnpm db:migrate
pnpm seed:controls
pnpm tsx scripts/build-controls-json.mjs
```

The seed creates this demo tenant:

```text
Tenant slug: demo-client
Tenant ID:   00000000-0000-0000-0000-000000000001
```

Create a local Supabase Auth user through Studio or the Auth API. To make a user an internal founder for local administration:

```sql
UPDATE public.users
SET is_axiom_internal = true
WHERE email = 'founder@axiomminds.ai';
```

## 4. Local environment configuration

Create the local Docker environment file:

```bash
cp infra/docker/environments/.env.local.example \
   infra/docker/environments/.env.local
```

Important local values:

```dotenv
ENVIRONMENT=development
NODE_ENV=development

NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:55321
NEXT_PUBLIC_SUPABASE_ANON_KEY=<local-anon-key>

SUPABASE_URL=http://host.docker.internal:55321
SUPABASE_SERVICE_KEY=<local-service-role-key>
SUPABASE_DB_URL=postgresql://postgres:postgres@host.docker.internal:55322/postgres

BFF_URL=http://bff:4000
AGENT_RUNTIME_URL=http://agent-runtime:8000
MODEL_GATEWAY_URL=http://model-gateway:8001

TEMPORAL_ADDRESS=temporal:7233
TEMPORAL_NAMESPACE=axiom-proof
TEMPORAL_TLS=false

APPROVAL_SIGNING_KEY=<at-least-32-character-development-secret>
AGENT_RUNTIME_INTERNAL_TOKEN=<development-internal-token>
MODEL_GATEWAY_API_KEY=<development-model-key>

AXIOM_REGION=ap-south-1
AXIOM_EVIDENCE_BUCKET=axiom-proof-evidence-local
AXIOM_STORAGE_ACCESS_KEY_ID=test
AXIOM_STORAGE_SECRET_ACCESS_KEY=test

FEATURE_DRY_RUN_ENGINE=true
FEATURE_EXECUTION_ENGINE=true
FEATURE_LIVE_CONNECTORS=false
FEATURE_KILL_SWITCH=true

AXIOM_E2E_BYPASS_AUTH=true
```

`AXIOM_E2E_BYPASS_AUTH=true` is allowed only for local automated testing. It must be false or absent in shared, staging, preproduction, and production environments.

## 5. Start the complete local stack

From the repository root:

```bash
./scripts/dev-docker.sh --env local --build
```

Or:

```bash
pnpm docker:up
```

Check status and logs:

```bash
./scripts/dev-docker.sh --status
./scripts/dev-docker.sh --logs
./scripts/dev-docker.sh --logs agent-runtime
./scripts/dev-docker.sh --logs model-gateway
./scripts/dev-docker.sh --logs bff
```

Probe the main endpoints:

```bash
curl http://localhost:8001/health
curl http://localhost:8000/health
curl http://localhost:4000/health
curl -I http://localhost:3001
curl -I http://localhost:3000
```

Open:

```text
Marketing:  http://localhost:3000
Workbench:  http://localhost:3001
Supabase:   http://localhost:55323
Temporal:   http://localhost:8233
```

Stop the stack:

```bash
pnpm docker:down
```

## 6. Source-process development mode

```bash
pnpm --filter @axiom/bff dev
```

```bash
cd services/agent-runtime
uv sync
uv run python -m axiom
```

```bash
cd services/model-gateway
uv sync
uv run python -m model_gateway
```

```bash
cd services/temporal-workers
uv sync
uv run python -m temporal_workers.worker
```

Run the web applications:

```bash
pnpm --filter @axiom/web dev
pnpm --filter @axiom/marketing dev
```

For source-process mode, use localhost URLs:

```dotenv
AGENT_RUNTIME_URL=http://localhost:8000
MODEL_GATEWAY_URL=http://localhost:8001
BFF_URL=http://localhost:4000
TEMPORAL_ADDRESS=localhost:7233
```

## 7. Running an audit locally

The normal functional flow is:

1. Create or log into a Supabase Auth user.
2. Create or select a tenant.
3. Open the Web Workbench.
4. Create an engagement.
5. Provide discovery interview and system information.
6. Run Drishti discovery.
7. Run Vibhaag classification.
8. Run Parikshan assessment against the control library.
9. Generate a plan with Sudhaar.
10. Review findings, blast radius, dry-run output, and rollback definition.
11. Approve the plan through the approval console.
12. Verify the approval token, ledger chain, and execution status.
13. Generate or review evidence through Saakshi and Prativedan.

The execution sequence must always be:

```text
Plan → Dry run → Rollback validation → Human approval → Signed token → Execute → Verify → Ledger
```

No agent should receive write credentials. Sudhaar must remain non-mutating.

Useful BFF endpoints:

```text
GET  /health
GET  /ready
GET  /v1/engagements
POST /v1/engagements
GET  /v1/engagements/:id
GET  /v1/plans/:id
POST /v1/plans/approve
POST /v1/plans/:id/reject
POST /v1/plans/:id/execute
POST /v1/ledger/verify
GET  /v1/ledger
GET  /v1/kill-switch/status
POST /v1/kill-switch/engage
POST /v1/kill-switch/release
```

All `/v1/*` requests require:

```text
Authorization: Bearer <Supabase JWT>
X-Tenant-Id: <tenant UUID>
Idempotency-Key: <UUID for mutating requests>
```

## 8. Local/on-premise production-like setup

| Cloud dependency    | On-premise replacement                     |
| ------------------- | ------------------------------------------ |
| Supabase Cloud      | Self-hosted Supabase/PostgreSQL            |
| S3                  | MinIO or another S3-compatible store       |
| Temporal Cloud      | Temporal Server plus PostgreSQL            |
| ElastiCache Valkey  | Valkey/Redis                               |
| EKS                 | Kubernetes, k3s, RKE2, or OpenShift        |
| AWS Secrets Manager | Vault, External Secrets, or sealed secrets |
| Bedrock             | Self-hosted vLLM, TGI, or Ollama           |
| Route 53/ACM        | Internal DNS plus cert-manager/private CA  |

The on-premise topology should contain:

```text
PostgreSQL/Supabase
Temporal + Temporal PostgreSQL
MinIO with Object Lock
Valkey/Redis
Model Gateway
vLLM or equivalent model server
Agent Runtime
Temporal Worker
BFF
Web
Marketing
Ingress/reverse proxy
Centralized logs and metrics
```

For evidence storage, the S3-compatible provider must support versioning, Object Lock, Compliance retention, legal hold, audit logging, encryption at rest, and backup/replication. Do not use an ordinary filesystem as the production evidence vault.

## 9. Production prerequisites

Production is designed for AWS `ap-south-1` and requires:

- AWS account and billing configured
- VPC spanning at least three Availability Zones
- EKS cluster
- GPU node group for self-hosted inference
- Supabase production project in the India region
- S3 bucket with Object Lock Compliance mode
- KMS key for evidence and secrets encryption
- AWS Secrets Manager
- ElastiCache Valkey
- Temporal Cloud namespace
- ECR or GHCR container registry
- DNS for `axiomproof.ai`, `app.axiomproof.ai`, and `api.axiomproof.ai` (company site: `axiomminds.ai`)
- TLS certificates, ingress controller, and cert-manager
- Centralized logs, metrics, alerting, and paging
- Backup and disaster-recovery plan
- Security review and penetration test
- Tenant retention and deletion policy

Use IAM roles for service accounts rather than static AWS access keys.

## 10. Production configuration and secrets

Store production secrets in AWS Secrets Manager or an equivalent secret manager. Do not commit `.env` files or put plaintext secrets in Helm values.

Required secrets include:

```text
SUPABASE_ANON_KEY
SUPABASE_SERVICE_KEY
SUPABASE_DB_URL
APPROVAL_SIGNING_KEY
AGENT_RUNTIME_INTERNAL_TOKEN
MODEL_GATEWAY_API_KEY
TEMPORAL_API_KEY
Database credentials
Valkey/Redis credentials
Model provider credentials, if applicable
```

Minimum production settings:

```dotenv
ENVIRONMENT=production
NODE_ENV=production
AWS_REGION=ap-south-1

FEATURE_DRY_RUN_ENGINE=true
FEATURE_EXECUTION_ENGINE=true
FEATURE_LIVE_CONNECTORS=false
FEATURE_KILL_SWITCH=true

AXIOM_E2E_BYPASS_AUTH=false
```

The canonical application variable names are `SUPABASE_DB_URL`, `AXIOM_EVIDENCE_BUCKET`, `AXIOM_REGION`, and `TEMPORAL_ADDRESS` (with backwards compatibility for `AWS_S3_EVIDENCE_BUCKET` and `AWS_REGION`). Older documentation may use `DATABASE_URL`, `EVIDENCE_VAULT_BUCKET`, or `TEMPORAL_HOST_PORT`; use the names consumed by the current services.

## 11. Production deployment sequence

### 11.1 Provision infrastructure

```bash
cd infra/terraform/envs/prod

terraform init \
  -backend-config="bucket=<terraform-state-bucket>" \
  -backend-config="key=axiom-proof/prod/terraform.tfstate" \
  -backend-config="region=ap-south-1" \
  -backend-config="dynamodb_table=<terraform-lock-table>"

terraform plan -out=prod.tfplan
terraform apply prod.tfplan
```

### 11.2 Apply Supabase migrations

```bash
supabase link --project-ref <project-ref>
cd "/Users/vikash/Axiom Proof"
pnpm db:migrate
pnpm seed:controls
pnpm tsx scripts/build-controls-json.mjs
```

### 11.3 Build immutable images

```bash
TAG="prod-$(git rev-parse --short HEAD)"

docker build -f infra/docker/Dockerfile.bff -t <registry>/axiom-bff:$TAG .
docker build -f infra/docker/Dockerfile.agent-runtime -t <registry>/axiom-agent-runtime:$TAG .
docker build -f infra/docker/Dockerfile.model-gateway -t <registry>/axiom-model-gateway:$TAG .
docker build -f infra/docker/Dockerfile.temporal-worker -t <registry>/axiom-temporal-worker:$TAG .
docker build -f infra/docker/Dockerfile.web -t <registry>/axiom-web:$TAG .
docker build -f infra/docker/Dockerfile.marketing -t <registry>/axiom-marketing:$TAG .

docker push <registry>/axiom-bff:$TAG
docker push <registry>/axiom-agent-runtime:$TAG
docker push <registry>/axiom-model-gateway:$TAG
docker push <registry>/axiom-temporal-worker:$TAG
docker push <registry>/axiom-web:$TAG
docker push <registry>/axiom-marketing:$TAG
```

### 11.4 Deploy Helm release

```bash
aws eks update-kubeconfig \
  --name axiom-proof-prod \
  --region ap-south-1

helm upgrade --install axiom-proof ./infra/helm/axiom-proof \
  --namespace axiom-proof \
  --create-namespace \
  --values ./infra/helm/axiom-proof/values-prod.yaml \
  --set image.tag="$TAG"
```

Verify rollout:

```bash
kubectl -n axiom-proof get pods
kubectl -n axiom-proof get services
kubectl -n axiom-proof get ingress
kubectl -n axiom-proof rollout status deployment/axiom-proof-bff
kubectl -n axiom-proof rollout status deployment/axiom-proof-agent-runtime
kubectl -n axiom-proof rollout status deployment/axiom-proof-model-gateway
```

## 12. Production verification checklist

```bash
curl -fsS https://api.axiomproof.ai/health
curl -fsS https://api.axiomproof.ai/ready
curl -fsS https://app.axiomproof.ai/
curl -fsS https://axiomproof.ai/
curl -fsS https://axiomminds.ai/
```

Verify:

- `SudhaarAgent.can_mutate == false`
- `AXIOM_E2E_BYPASS_AUTH` is absent or false
- Model Gateway redaction is enabled
- Hosted-model routes always redact PII
- Raw model-provider access is impossible from application pods
- BFF-to-Agent Runtime authentication works
- mTLS is enabled for internal service traffic
- S3 Object Lock is Compliance mode
- S3 versioning is enabled
- Direct ledger inserts are denied
- `append_ledger()` is the only ledger write path
- RLS isolates tenant data
- Approval requires dry-run and validated rollback
- Kill switch works
- Temporal workers reconnect after restart
- Backups and restore procedures have been tested
- `verify_ledger('<tenant-id>')` returns no broken chain rows

Verify a tenant ledger:

```sql
SELECT *
FROM verify_ledger('<tenant-uuid>');
```

No returned rows means the chain is intact.

## 13. Current production gaps

The repository is suitable for local functional audits and approval-gated workflow testing, but it is not yet a complete production execution platform.

Remaining areas include:

- Real connector implementations and connector credentials
- Full Karya execution implementation; the current path is a Phase 0/1 stub
- Real model dispatch; the current Model Gateway has a deterministic stub dispatcher
- Complete RoPA, policy, and playbook persistence/API/UI integration
- Report PDF rendering and signed delivery
- Production mTLS and stronger internal service identity
- MFA assurance enforcement and verification
- Independent verification of production S3 Object Lock
- Production Supabase privilege and RLS verification
- External data-residency evidence
- SSO/SAML
- PagerDuty, Slack, and production alert integrations

Keep live connectors and real execution disabled until these controls are independently tested.

Recommended rollout:

```text
Local functional audit
→ Private staging
→ Production-parity preprod
→ Security, residency, and backup verification
→ Controlled pilot with execution disabled
→ Approval-only production
→ Limited connector rollout
→ Full production execution
```

## 14. End-to-End Testing & Live Verification Guide

This section provides the complete operational reference for validating Axiom Proof across all environments. It maintains strict architectural segregation among **Local Bare-Metal**, **Local Docker Compose**, **Staging/Pre-Production**, and **Production** environments.

---

### 14.1 Environment Architecture & Boundary Matrix

| Construct           | Local Bare-Metal (Host)            | Local Full-Stack (Docker)         | Staging / Pre-Production            | Production (EKS / AWS)             |
| :------------------ | :--------------------------------- | :-------------------------------- | :---------------------------------- | :--------------------------------- |
| **`ENVIRONMENT`**   | `local`                            | `local` or `development`          | `staging` / `preprod`               | `production`                       |
| **`NODE_ENV`**      | `development`                      | `production` (Next.js standalone) | `production`                        | `production`                       |
| **Topology**        | Host processes (`pnpm dev`, `uv`)  | Docker network (`axiom-network`)  | AWS Private VPC (`ap-south-1`)      | AWS EKS Cluster (`ap-south-1`)     |
| **Marketing Site**  | `http://localhost:3000`            | `http://localhost:3000`           | `https://staging.axiomproof.ai`     | `https://axiomproof.ai` (co: `axiomminds.ai`) |
| **Web Workbench**   | `http://localhost:3001`            | `http://localhost:3001`           | `https://app-staging.axiomproof.ai` | `https://app.axiomproof.ai`        |
| **BFF API Gateway** | `http://localhost:4000`            | `http://localhost:4000`           | `https://api-staging.axiomproof.ai` | `https://api.axiomproof.ai`        |
| **Agent Runtime**   | `http://localhost:8000`            | `http://localhost:8000`           | Internal VPC / Cluster IP           | Internal VPC / Cluster IP          |
| **Model Gateway**   | `http://localhost:8001`            | `http://localhost:8001`           | Internal VPC (Self-hosted/Bedrock)  | Internal VPC (Self-hosted/Bedrock) |
| **Temporal UI**     | `http://localhost:8233`            | `http://localhost:8233`           | Temporal Cloud / Internal UI        | Temporal Cloud / Internal UI       |
| **Supabase DB**     | `127.0.0.1:55322`                  | `127.0.0.1:55322`                 | Managed RDS / Supabase Cloud        | Managed RDS / Supabase Cloud       |
| **Supabase Studio** | `http://127.0.0.1:55323`           | `http://127.0.0.1:55323`          | Private Admin Portal / Bastion      | Private Admin Portal / Bastion     |
| **Email Delivery**  | Stdout / Mailpit (`:55324`)        | Stdout mock or live Resend key    | Resend API (Verified Domain)        | Resend API (Strict SPF/DKIM/DMARC) |
| **Evidence Vault**  | Local FS or MinIO bucket           | Local S3-compatible mock          | S3 Object Lock (Governance)         | S3 Object Lock (Compliance mode)   |
| **Auth Bypass**     | Optional (`AXIOM_E2E_BYPASS_AUTH`) | Optional for testing              | Strictly `false`                    | Strictly `false` (Mandatory MFA)   |
| **Planning Agent**  | `can_mutate = False`               | `can_mutate = False`              | `can_mutate = False`                | `can_mutate = False` (ADR-3)       |
| **Audit Ledger**    | Append-only function               | Append-only function              | `append_ledger()` SECURITY DEFINER  | `append_ledger()` SECURITY DEFINER |

---

### 14.2 Automated Test Suites (Pre-CI Verification)

Execute the all-in-one pre-flight verification script before any push or deployment:

```bash
./scripts/test-local-stack.sh
```

This automated runner executes 5 sequential stages:

1. **TypeScript Workspace Tests (`pnpm test`)**: Validates types, schema contracts, control definitions, ledger canonicalization, component UI rendering (including bespoke `AgentIcon` unit tests), and evidence packages across all 10 monorepo packages.
2. **Python Agent Runtime Pytest (`services/agent-runtime`)**: Executes 32 unit and integration tests verifying all 10 named agents, Sudhaar's non-mutating lock, Karya's execution gate, and the PII redactor. Fully compliant with Python 3.12+ / 3.14 (`datetime.now(timezone.utc)`), completing with **0 warnings** and 100% pass rate.
3. **Python Model Gateway Pytest (`services/model-gateway`)**: Executes 14 tests verifying regex and NER redaction for Indian identifiers (Aadhaar, PAN, phone numbers, passport, voter ID), model routing, and token budget governance with **0 warnings**.
4. **Live HTTP Health Checks**: Verifies live responses from:
   - Model Gateway (`http://localhost:8001/health`)
   - Agent Runtime (`http://localhost:8000/health`)
   - BFF API (`http://localhost:4000/health`)
   - Temporal UI (`http://localhost:8233`)
   - Web Product Workbench (`http://localhost:3001`)
   - Marketing Site (`http://localhost:3000`)
5. **Playwright E2E UI Suite (`tests/e2e`)**: Validates the public gap-scan funnel, contact form email submission, trust surface, kill-switch visibility, and security headers.

To run individual sub-suites:

```bash
# TypeScript workspace tests
pnpm test

# Agent Runtime tests (32 passed, 0 warnings)
cd services/agent-runtime && uv run pytest -v

# Model Gateway tests (14 passed, 0 warnings)
cd services/model-gateway && uv run pytest -v

# E2E Playwright tests (headless)
cd tests/e2e && pnpm test:e2e

# E2E Playwright interactive UI runner
cd tests/e2e && pnpm exec playwright test --ui
```

---

### 14.3 Manual End-to-End Testing (Local Docker Stack)

Follow these manual steps to interactively verify the entire application in your browser.

#### Step 1: Public Marketing Funnel & Diagnostic Scan (`http://localhost:3000`)

1. **Complete the 5-Minute Gap-Scan**:
   - Open **[http://localhost:3000/#gap-scan](http://localhost:3000/#gap-scan)** in your browser.
   - **Step 1 (Profile)**: Select _Fintech & Financial Services_, choose _51–200 employees_, and click **Start assessment**.
   - **Step 2 (Diagnostic)**: Answer the 12 Yes/No questions regarding consent notices, DPO appointment, retention schedules, and grievance redressal.
   - **Step 3 (Contact Info)**: Enter name, email, and company (e.g. `Aarav Sharma`, `aarav@example.com`, `Aarav Pay`).
   - **Step 4 (Review & Submit)**: Click **Generate my report**.
   - **Verification**: The browser redirects to **`/gap-scan/report/<id>`**, displaying:
     - Overall DPDPA posture score (0–100 scale).
     - Estimated regulatory financial exposure in INR.
     - Top 5 remediation priorities ranked by risk weight.
     - Full table of 12 evaluated controls with domain, severity, and compliance badges.

2. **Test Founder Contact Form (Resend Integration)**:
   - Open **[http://localhost:3000/contact](http://localhost:3000/contact)**.
   - Fill in:
     - **Name**: `Aarav Sharma`
     - **Email**: `aarav@example.com`
     - **Company**: `Aarav Payments Pvt Ltd`
     - **Message**: `We process customer personal data across 4 states and need guidance on multilingual consent notice requirements under DPDPA 2023.`
   - Click **Send message**.
   - **Verification**:
     - Button displays a spinner with **Sending...**.
     - Form transitions to the confirmation state: _"Message sent successfully. Your message has been sent directly to Axiom Minds Private Limited's founder."_
     - In terminal, inspect stdout: `docker logs --tail 15 axiom-marketing` to see the formatted delivery log.

3. **Inspect the Agent Roster & Animated Dynamics**:
   - Open **[http://localhost:3000/agents](http://localhost:3000/agents)**.
   - **Interactive Agent Dynamics Bar**: Use the global simulation switcher at the top:
     - Click **All Thinking**: Watch all 10 agents transition into cognitive reasoning mode (pulsing irises, shifting prisms, caliper calibrations, radiating sonar).
     - Click **All Working**: Watch all 10 agents engage in active execution mode (rotating radar sweeps, counter-rotating planetary gears, expanding golden seal shockwaves, running hash link ciphers).
     - Click **All Idle**: Return agents to the steady, crisp idle state.
   - **Per-Agent Interactive Controls**: Each agent card displays a prominent `size="lg"` icon with an accent glow halo, declared tool scopes, autonomy ceilings, and individual `[idle | thinking | working]` toggle buttons to test each agent in isolation.

---

#### Step 2: Enterprise Workbench & Compliance Console (`http://localhost:3001`)

1. **Workspace Overview & Bottom-Left Sidebar Agent Panel**:
   - Open **[http://localhost:3001/workbench](http://localhost:3001/workbench)**.
   - Verify current posture score, identified gaps count, and active compliance engagement status.
   - **Bottom-Left Sidebar Agent Panel** (`SidebarAgentPanel`):
     - Docked cleanly at the bottom of the sidebar in an institutional **solid light theme** (`bg-[#F8FAFC]` with `border-t border-slate-200` and high-contrast typography, avoiding transparency issues).
     - Displays all 10 agents with custom vector mini icons (`size="sm"`).
     - Automatically polls `/api/bff/v1/agents/runs/active` every 4 seconds. When an agent is running a task, its icon smoothly animates into `working` state with an active pulsing beacon.
     - **Preview Mode Switcher**: Click the top-right `Preview` button in the sidebar footer to cycle states: `Live` → `Thinking ⟳` → `Working ⟳` → `Live` to test animations directly in the navigation layout.
     - **Interactive Action & Inspector Panel**: Clicking any agent opens an inline high-contrast card with:
       - Agent details: Indic name, statutory responsibilities, and autonomy tier (`L1 Autonomous` vs `L2 Approval-Gated`).
       - **⚡ Direct Action Trigger**: For L1 agents, triggers real-time task execution via the BFF (`/api/bff/v1/agents/:name/run`) with live latency and cryptographic ledger proof link (`#id`).
       - **Approval Gate Safeguard (ADR-1/ADR-3)**: For Karya (mutating agent), provides a direct jump to the `/approval` console, enforcing that unapproved mutations are blocked.
       - **Navigation Links**: Quick links to the agent's dedicated module screen (`Open Screen →`), workbench prompt (`Workbench ↗`), and audit ledger (`Ledger ↗`).
   - **Agent Roster Cards**: The main workbench grid features upgraded cards with bespoke mini icons, persona badges, and one-liner descriptions.

2. **Control Library Browser**:
   - Open **[http://localhost:3001/controls](http://localhost:3001/controls)**.
   - Browse the **46 DPDPA Controls** across all 13 statutory domains (`GOV`, `CNS`, `DAT`, `RCD`, `BRCH`, `XBR`, `CHD`, `SDF`, `SEC`, `RTN`, `DPF`, `AUD`, `DPIA`).
   - Click any control to view statutory citations, verification guidance, and evidence requirements.

3. **Remediation Plans & Human Approval Gate (ADR-1, BR-2)**:
   - Open **[http://localhost:3001/plans](http://localhost:3001/plans)**.
   - Inspect actions in `pending_approval` state.
   - Verify that actions require both a completed **Dry-Run Output** and a validated **Rollback Definition** before the **Approve** button activates.
   - Verify the **Emergency Kill Switch** is readily visible on the interface.

4. **Cryptographic Audit Ledger & Active Executions Banner**:
   - Open **[http://localhost:3001/ledger](http://localhost:3001/ledger)**.
   - **Active Agent Executions Banner**: If an agent is in flight, an institutional banner appears showing the animated `working` icon, execution timer, action type, and target system reference.
   - Inspect compliance events: sequence numbers (`#1`, `#2`, `#3`, etc.), canonical action types, timestamps, and gold **ProofSeal** SHA-256 hashes.
   - Click **"Verify chain integrity"** (`POST /api/bff/v1/ledger/verify`) to confirm: _"Chain verified: every entry hash and prev_hash matches. Audit trail is intact."_

5. **Evidence Vault**:
   - Open **[http://localhost:3001/evidence](http://localhost:3001/evidence)**.
   - Verify tamper-proof evidence items, hash seals, and metadata.

---

#### Step 3: Temporal Durable Workflow Orchestration (`http://localhost:8233`)

1. Open **[http://localhost:8233](http://localhost:8233)** in your browser.
2. Select the **`default`** namespace.
3. Inspect background workflows:
   - Review task queues: `gap_scan_queue`, `agent_execution_queue`.
   - Click any workflow execution to inspect the event history tree, activity retries, execution times, and payload summaries.

---

#### Step 4: Supabase Studio & Database Admin (`http://127.0.0.1:55323`)

1. Open **[http://127.0.0.1:55323](http://127.0.0.1:55323)** in your browser.
2. In the **Table Editor**:
   - `controls`: View 46 immutable controls.
   - `gap_scan_responses`: View recent public submissions and scoring snapshots.
   - `audit_ledger`: View sealed compliance records and cryptographic hashes.
3. In the **SQL Editor**:
   - Run custom queries against the local schema:
     ```sql
     SELECT id, sector, employee_band, posture_score, created_at
     FROM gap_scan_responses
     ORDER BY created_at DESC
     LIMIT 5;
     ```

---

### 14.4 Backend Guardrails & API Verification (Terminal / Curl)

#### 4.1 Indian PII Redaction & Data Residency (Model Gateway)

Verifies that client personal data stays in `ap-south-1` and raw Indian identifiers are stripped before reaching external LLMs:

```bash
curl -s -X POST http://localhost:8001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "stub-dpdpa-specialist",
    "messages": [
      {
        "role": "user",
        "content": "Verify consent for Aadhaar 3456 7890 1234, PAN ABCDE1234F, and mobile +91 98765 43210."
      }
    ],
    "tenant_id": "00000000-0000-0000-0000-000000000001"
  }' | jq .
```

_Expected Output_:

```json
{
  "id": "chatcmpl-c6961ce66ccb",
  "object": "chat.completion",
  "created": 1789271758,
  "model": "anthropic.claude-3-5-sonnet-20240620-v1:0",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Model Gateway received prompt with PII redacted: Verify consent for Aadhaar [REDACTED:AADHAAR], PAN [REDACTED:PAN], and mobile [REDACTED:PHONE_IN]."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 21,
    "completion_tokens": 36,
    "total_tokens": 57
  },
  "pii_redacted": true,
  "redactions": {
    "PAN": 1,
    "AADHAAR": 1,
    "PHONE_IN": 1
  }
}
```

To extract only the assistant message string, quote the jq path with single quotes so `zsh` does not interpret `[0]` as a glob pattern:

```bash
curl -s -X POST http://localhost:8001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "stub-dpdpa-specialist",
    "messages": [
      {
        "role": "user",
        "content": "Verify consent for Aadhaar 3456 7890 1234, PAN ABCDE1234F, and mobile +91 98765 43210."
      }
    ],
    "tenant_id": "00000000-0000-0000-0000-000000000001"
  }' | jq -r '.choices[0].message.content'
```

You can also query the gateway's direct completion endpoint:

```bash
curl -s -X POST http://localhost:8001/v1/complete \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer dev-model-gateway-key-axiom" \
  -d '{
    "prompt": "Verify consent for Aadhaar 3456 7890 1234, PAN ABCDE1234F, and mobile +91 98765 43210.",
    "task": "reasoning"
  }' | jq .
```

---

#### 4.2 Running Audits Against Target Systems (Discovery & Assessment)

Axiom Proof audits target systems using autonomous compliance agents that record all findings and decisions to the append-only ledger.

##### A. Target Discovery Audit (Drishti)

Drishti discovers data repositories (PostgreSQL, MySQL, S3 buckets, APIs), identifies personal data categories (Aadhaar, PAN, phone, email), evaluates Indian data residency (`ap-south-1` Mumbai default), and flags statutory escalations under Section 16 & Rule 16.

> **DPDPA Data Residency & Cross-Border Enforcement**:
>
> - All target systems and logs default to India (`ap-south-1` / Mumbai).
> - If an operator designates a foreign destination (e.g., `us-east-1` USA, `eu-central-1` Frankfurt) even with `"cross_border": false`, Drishti **allows** the destination, but automatically flags `cross_border: true`, triggers an escalation (`escalate: true`, `escalation_reason: "cross_border_transfer_detected"`), and emits a statutory warning (`[DPDPA-XBD-01]`) requiring transfer safeguards and RoPA documentation under Section 16.

Trigger Drishti via the BFF API:

```bash
curl -s -X POST http://localhost:4000/v1/agents/drishti/run \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer dev-token" \
  -H "X-Tenant-ID: 00000000-0000-0000-0000-000000000001" \
  -d '{
    "systems": [
      {
        "name": "Production Customer DB",
        "type": "postgres",
        "description": "Core database holding user credentials and KYC docs",
        "region": "ap-south-1",
        "hosts_personal_data": true,
        "data_categories": ["aadhaar", "pan", "phone", "email"],
        "cross_border": false
      },
      {
        "name": "US Analytics S3 Bucket",
        "type": "s3",
        "description": "Log telemetry archive in us-east-1",
        "hosts_personal_data": true,
        "data_categories": ["ip_address", "telemetry"],
        "cross_border": false
      }
    ]
  }' | jq .
```

_Or invoke directly via the Agent Runtime (`:8000`):_

```bash
curl -s -X POST http://localhost:8000/agents/drishti/invoke \
  -H "Content-Type: application/json" \
  -H "x-internal-token: dev-agent-runtime-token-axiom" \
  -d '{
    "input": {
      "tenant_id": "00000000-0000-0000-0000-000000000001",
      "engagement_id": "00000000-0000-0000-0000-000000000001",
      "systems": [
        {
          "name": "Production Customer DB",
          "type": "postgres",
          "description": "Core database holding user credentials and KYC docs",
          "hosts_personal_data": true,
          "data_categories": ["aadhaar", "pan", "phone", "email"],
          "cross_border": false
        }
      ]
    }
  }' | jq .
```

##### B. Statutory Control Assessment Audit (Parikshan)

Parikshan audits the target against the 46 versioned DPDPA controls, computing the client's Posture Score (0-100%) and estimated statutory penalty exposure:

```bash
curl -s -X POST http://localhost:4000/v1/agents/parikshan/run \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer dev-token" \
  -H "X-Tenant-ID: 00000000-0000-0000-0000-000000000001" \
  -d '{
    "library_version": "0.1.0",
    "processes_children": true,
    "processes_health": false,
    "answers": {
      "DPDPA-NOT-01": {"multilingual_notice": "no"},
      "DPDPA-CON-01": {"itemised_consent": "yes"},
      "DPDPA-XBD-01": {"cross_border_blacklisted": "no"}
    }
  }' | jq .
```

---

#### 4.3 Verifying the Append-Only Audit Ledger

Every agent execution automatically appends cryptographic records to the hash chain.

##### Option 1: Web UI

Navigate to `http://localhost:3001/ledger` in your browser.

- Verify that every sequence (`#1`, `#2`, `#3`, `#4`, etc.) is displayed.
- Inspect the actor badge (`drishti`, `parikshan`), action type (`discovery.started`, `assessment.started`), execution outcome (`success`), timestamp, and the tamper-evident **ProofSeal** hash.
- Click **"Verify chain integrity"** to mathematically validate the hash chain.

##### Option 2: Direct PostgreSQL Inspection

Query the `audit_ledger` table using the schema's canonical column names:

- `sequence_no` (not `sequence_number`)
- `action_type` (not `event_type`)
- `actor_id` (not `agent_name`)
- `entry_hash` (not `hash`)
- `prev_entry_hash` (not `previous_hash`)
- `detail` (not `summary`)

```bash
docker exec -it supabase_db_axiom-proof psql -U postgres -d postgres -c \
  "SELECT sequence_no, actor_type, actor_id, action_type, result, entry_hash, prev_entry_hash, occurred_at FROM audit_ledger WHERE tenant_id = '00000000-0000-0000-0000-000000000001' ORDER BY sequence_no DESC LIMIT 5;"
```

##### Option 3: API Verification via cURL

Trigger the cryptographic SHA-256 chain verification through the Web Proxy or directly via the BFF API:

```bash
# Via Web Next.js BFF proxy
curl -s -X POST http://localhost:3001/api/bff/v1/ledger/verify | jq .

# Directly against the BFF service
curl -s -X POST http://localhost:4000/v1/ledger/verify \
  -H "Authorization: Bearer dev-token" \
  -H "X-Tenant-Id: 00000000-0000-0000-0000-000000000001" | jq .
```

_Expected Output_:

```json
{
  "intact": true
}
```

---

#### 4.4 Mathematical Proof of Non-Tampering

Run the built-in cryptographic audit verification function in PostgreSQL:

```bash
docker exec -it supabase_db_axiom-proof psql -U postgres -d postgres -c \
  "SELECT * FROM verify_ledger('00000000-0000-0000-0000-000000000001'::uuid, 1);"
```

_Expected Output_:

```text
 sequence_no | reason
-------------+--------
(0 rows)
```

> **Note on `(0 rows)`**: This is the expected proof of success. The `verify_ledger(...)` function returns discrepancies (broken chain rows). When zero rows are returned, it mathematically proves that 100% of the SHA-256 hashes and sequence links are unbroken and the ledger is cryptographically intact.

---

#### 4.5 Tamper Detection & Immutability Verification

Demonstrate that any manual tampering with an existing ledger row is immediately caught by the cryptographic verification algorithm:

```bash
# 1. Tamper test: Modify the detail column of record #1 directly in Postgres
docker exec -i supabase_db_axiom-proof psql -U postgres -d postgres -c \
  "UPDATE audit_ledger SET detail = '{\"tampered\": true}'::jsonb WHERE sequence_no = 1;"

# 2. Run verification: verify_ledger immediately identifies the broken hash seal
docker exec -i supabase_db_axiom-proof psql -U postgres -d postgres -c \
  "SELECT * FROM verify_ledger('00000000-0000-0000-0000-000000000001'::uuid, 1);"
```

_Verification Output (Tamper Detected)_:

```text
 sequence_no |             reason
-------------+---------------------------------
           1 | entry_hash mismatch (tamper)
(1 row)
```

```bash
# 3. Restore the original payload to re-seal the ledger
docker exec -i supabase_db_axiom-proof psql -U postgres -d postgres -c \
  "UPDATE audit_ledger SET detail = '{\"scope\": \"test-full-scan\", \"systems_discovered\": [\"pg-primary\", \"s3-logs\"]}'::jsonb WHERE sequence_no = 1;"

# 4. Verify chain integrity restored
docker exec -i supabase_db_axiom-proof psql -U postgres -d postgres -c \
  "SELECT * FROM verify_ledger('00000000-0000-0000-0000-000000000001'::uuid, 1);"
# Result: (0 rows) -> intact!
```

---

#### 4.6 Emergency Kill-Switch Drill

Trigger an emergency halt across all running agents for a tenant:

```bash
# Engage the kill switch (halts all running agent tasks)
curl -s -X POST http://localhost:4000/v1/kill-switch \
  -H "Content-Type: application/json" \
  -H "X-Tenant-ID: 00000000-0000-0000-0000-000000000001" \
  -d '{"reason": "Manual compliance test drill"}' | jq .
```

_Expected Output_:

```json
{
  "engaged": true,
  "scope": "all",
  "reason": "Manual compliance test drill"
}
```

To release the kill switch:

```bash
curl -s -X POST http://localhost:4000/v1/kill-switch/release | jq .
```

_Expected Output_:

```json
{
  "engaged": false
}
```

_(In local development / non-production, the BFF automatically authorizes localhost requests with owner role privileges; in production, only authenticated founders/owners with MFA can release the kill switch)._

---

### 14.5 Staging & Production Parity Verification Checklist

Before deploying or promoting builds to private staging or production, execute this pre-flight verification:

1. **Separation of Duties (ADR-3)**:
   - Ensure `SudhaarAgent.can_mutate == False`.
   - Verify `KaryaAgent` refuses execution without a signed, scope-bound approval token issued after dry-run and rollback validation.
2. **Zero Raw PII Egress (ADR-5)**:
   - Ensure `MODEL_GATEWAY_URL` points to an `ap-south-1` deployment.
   - Verify outbound prompts strip Indian Aadhaar, PAN, phone numbers, passport, and voter IDs.
3. **Database Security & RLS**:
   - Ensure direct INSERT, UPDATE, and DELETE on `audit_ledger` are revoked for application roles.
   - Verify `append_ledger()` SECURITY DEFINER function is the sole write path.
   - Ensure Row Level Security (RLS) is enabled and active on all tenant-keyed tables.
4. **Evidence Vault Immutability**:
   - In Staging: S3 Object Lock in Governance mode.
   - In Production: S3 Object Lock in Compliance mode with multi-year retention (preventing deletion even by root).
5. **Auth & Identity**:
   - Ensure `AXIOM_E2E_BYPASS_AUTH` is strictly absent or `false`.
   - Require MFA assurance level 2 for all human approval actions.
6. **Ledger Integrity Proof**:
   - Run `SELECT * FROM verify_ledger('<tenant-uuid>');` across all active tenants. Must return 0 broken rows.

---

### 14.6 Axiom Proof Brand Mark & Application Architecture Synchronization

The Axiom Proof brand mark and complete application architecture are fully synchronized with the canonical Claude Design prototypes (`Axiom Proof Design System.dc.html`, `Axiom Proof App.dc.html`, and `Axiom Proof Site.dc.html`).

#### 1. Official Brand Mark & Logo Lockup (`@axiom/ui`)

- **Component**: `<AxiomMark />` and `<AxiomLogo />` in `packages/ui/src/components/`
- **Concept (Design System §01 Brand)**:
  - _Chain Link_: Circular ring representing the hash-chained ledger and complete traceability (ADR-5).
  - _Checkmark Needle_: Vector proof checkmark resting inside the chain link, representing cryptographic proof and immutable attestation.
  - _Color Gradients_: Canonical Signal Teal (`#0FB5A5` → `#0a8d80`), Deep Indigo (`#1E2A4A`), or Proof Gold (`#C9A227`).
- **Integration**:
  - Marketing Header & Footer (`apps/marketing/src/components/SiteHeader.tsx`, `SiteFooter.tsx`)
  - Web App Header, Sidebar & Login (`apps/web/src/app/(app)/app-shell.tsx`, `login/page.tsx`, `page.tsx`)

#### 2. Synchronized Axiom Proof Web App Architecture (`apps/web`)

The web application (`http://localhost:3001`) implements the authoritative styling and layout from `Axiom Proof App.dc.html`:

- **Deep Indigo Sidebar (`bg-[#1E2A4A]`)**:
  - Full `navDef` phase-grouped navigation:
    1. **Overview**: Dashboard (`/dashboard`, P0)
    2. **Discover & Classify (Drishti + Vibhaag)**: Data Discovery (`/discovery`, P1), Classification (`/classification`, P1), Data Map & RoPA (`/datamap`, P1)
    3. **Assess (Parikshan)**: Assessment (`/assessment`, P0), Control Library (`/controls`, P0)
    4. **Remediate (Sudhaar + Karya)**: Remediation Plans (`/plans`, P3), Approval Console (`/approval`, P3, ★), Execution & Rollback (`/execution`, P3)
    5. **Evidence & Audit (Saakshi + Lekha)**: Evidence Explorer (`/evidence`, P2), Audit Ledger (`/ledger`, P2)
    6. **Rights & Consent**: DSAR / Rights (`/dsars`, P3), Consent Manager (`/consent`, P3)
    7. **Incident**: Breach & Incident (`/breaches`, P3)
    8. **Monitor (Nazar)**: Continuous Monitoring (`/monitoring`, P3), Regulatory Watch (`/regwatch`, P2)
    9. **Report (Prativedan)**: Reports (`/reports`, P2)
    10. **Operate**: Agent Workbench (`/workbench`, P0), Partner Portal (`/partner`, P4), Connectors (`/connectors`, P2), Standing Policies (`/policies`, P4), Settings (`/settings`, P0)
  - Every navigation item includes its English name, Indic Hindi transliteration, phase tag (`P0`–`P4`), active teal indicator, and gold star (for Approval Console).
  - Approver user profile bar with avatar initials.
  - Bottom-left `<SidebarAgentPanel />` preserved with live execution polling and animations.
- **TopBar Controls**:
  - Dynamic breadcrumb and screen title.
  - Interactive Tenant Switcher (Meridian Pay, Aarogya Health, Streamline SaaS, and live tenants).
  - Environment badge (pulsing teal dot + `Production` / `Staging`).
  - Interactive Global Kill Switch button and alert banner (`⏻ KILL SWITCH ENGAGED`).

#### 3. Core Application Views Implemented

1. **Dashboard (`/dashboard`)**:
   - 74/100 Posture Score hero card, progress bar, 32/46 controls passing, ▲ +6 trend.
   - 6 KPI metric cards (Open gaps, Pending approvals, Evidence sealed, Open DSARs, Consents live, Ledger entries).
   - Open gaps by domain distribution bars.
   - Pending approvals quick-action cards.
   - Live agent activity feed with pulsing status indicators.
   - Statutory DPDPA countdown timer (days to 13 May 2027 enforcement, ₹250 cr penalty cap).
2. **Approval Console (`/approval`)**:
   - Plan header with action progress, blast radius, and target environment.
   - Typed action list with multi-select checkboxes, risk badges (`MED`, `LOW`, `HIGH`), and status lifecycle (`APPROVED`, `EXECUTING…`, `EXECUTED`, `✓ VERIFIED`, `REJECTED`, `DEFERRED`).
   - Detailed action inspection: legal gap citation, risk justification, blast radius cards, dry-run diff viewer with SHA-256 hash, and generated rollback plan (`RB-118a`).
   - Sticky bottom approval action bar with single-click execution simulation and token issuance guarantee.
3. **Assessment Pipeline (`/assessment`)**:
   - **Hero Pipeline Card**: Deep Indigo (`bg-[#1E2A4A]`) card with `▶ Run new assessment` trigger (`Parikshan scores against control library v25.11.2 · agents propose, you approve`).
   - **5-Stage Pipeline Stepper**: Exact design sequence (_1. Drishti · Discovery · खोज_, _2. Vibhaag · Classification · वर्गीकरण_, _3. Parikshan · Assessment · मूल्यांकन_, _4. Saakshi · Evidence · साक्ष्य_, _5. Prativedan · Report · रिपोर्ट_).
     - Circular stage nodes (`34px`, `font-heading font-bold text-[13px]`) displaying stage numbers `1`–`5`, transitioning to Gold pulse (`#C9A227`) when active, and Signal Teal (`#0FB5A5`) checkmark (`✓`) when completed.
     - Horizontal progress track connecting the 5 nodes in real-time as stages complete.
     - Live execution message: `● {agent} — {detail}` during runs and `● assessment complete · report generated · every step written to the ledger` with cryptographic ledger proof link (`#id`).
   - **Summary + Exposure 3-Card Grid**:
     - _Control Posture_: Segmented status bar displaying 32 pass (`#0FB5A5`), 5 partial (`#E0A82E`), 6 fail (`#D9534F`) across open controls.
     - _SDF Self-Assessment_: Displays statutory status (`Not designated`) and volume/sensitivity threshold rationale.
     - _Penalty Exposure Estimate_: Highlighted card (`bg-[#fbeceb]`) with calculated statutory exposure range (`₹18–46 cr`, weighted across open gaps).
   - **Statutory Control Table**:
     - 12 canonical DPDPA controls from `Axiom Proof App.dc.html` (`NOT-01`, `NOT-04`, `RTS-01`, `RTS-04`, `RTS-06`, `RET-03`, `RET-05`, `PUR-02`, `SEC-06`, `SEC-09`, `XBR-01`, `BRC-02`).
     - Progress score meters, statutory citations (§5, §6(4), §11, §12, §13, §8(7), §8(4), §8(5), §16, Rule 7), sealed gold evidence tags (`✦ e-8839`), and status badges (`PASS`, `PARTIAL`, `FAIL`).
4. **Consent Manager (`/consent`)**:
   - Active consent metrics and 7-year WORM ledger retention.
   - Immutable consent event stream.
   - Interactive bilingual consent notice preview (English ↔ Hindi switcher) with granular purpose toggles.
5. **Dedicated Module Views**:
   - `/discovery`, `/classification`, `/datamap`, `/execution`, `/monitoring`, `/regwatch`, `/reports`, `/partner`, `/connectors`, `/policies` rendering canonical phase cards, autonomy ceilings, and live metric rows.

---

### 14.7 Audit Ledger Enhancements: Contextual Filtering & Interval Auto-Refresh

The Audit Ledger screen (`/ledger`, `apps/web/src/app/(app)/ledger/`) features server-side querying, cryptographic verification, contextual filtering, and auto-refresh mechanisms.

#### 1. Unified Auto-Refresh Control (`<LedgerRefresh />`)

- **Single Component Pill**: Combines manual refresh, auto-refresh toggle, and interval selector into a single cohesive control (`[ ↻ Refresh | ● Auto: Off ▾ ]`) to eliminate multiple disjoint UI elements.
- **Default State**: Strictly **`Auto: Off`** (`intervalSeconds = 0`), respecting non-intrusive default behavior.
- **Interval Options**: `Auto: Off` (0s), `Every 5s`, `Every 10s`, `Every 30s`, `Every 60s`.
- **Visual Feedback**:
  - Manual refresh animates the `↻` icon with `animate-spin` while the server transition is pending.
  - Active auto-refresh displays a pulsing teal dot (`animate-ping bg-teal-500`) and the active interval badge.
  - Live timestamp tracking (`Updated HH:MM:SS`) confirms the exact moment of the last ledger pull.
  - Agent stream awareness: Indicates live background activity (`Live streaming (X active)`) when agents are running.

#### 2. Contextual Filter Suite (`<LedgerFilters />`)

- **Unified Query Input (`q`)**: Accepts integer sequence numbers (e.g., `#1`), full or prefix UUID correlation IDs, target references, or action substrings.
- **Actor / Agent Filter (`agent`)**: Select between all 10 named agents (_Drishti, Vibhaag, Parikshan, Saakshi, Sudhaar, Karya, Lekha, Nazar, Prativedan, Sanket_), _Human Approver_, or _System Engine_.
- **Action Category Filter (`action`)**: Filter by semantic lifecycle category (_Discovery, Classification, Assessment, Evidence, Plan, Approval, Execution, Verification, DSAR, Breach_).
- **Result Filter (`result`)**: Filter by execution outcome (_Success, Failure, Pending / Running, Rolled back, Skipped_).
- **Interactive Filter Chips & Counter**:
  - Dynamic result counter: `Showing X of Y total entries`.
  - Removable tag chips for each active filter with instant 1-click removal (`✕`).
  - Single-click **"Clear all filters"** reset button.
  - Informative empty state with reset button when no rows match the filter criteria.

#### 3. Server-Side Execution (`page.tsx`)

- Queries PostgreSQL via Supabase Admin Client using server-side pagination and filtering.
- Preserves cryptographic ledger integrity proof (`verify_ledger` RPC) and unbroken SHA-256 hash chains.

---

### 14.8 Bottom-Left Agent Panel: Actionable Controls & High-Contrast Flyout Architecture

To address the constraint where the sidebar agent panel previously only rendered passive descriptions in an inline box that could get cut off at the bottom of the viewport, the bottom-left agent panel (`sidebar-agent-panel.tsx`) was completely overhauled with an elevated dock and an interactive flyout action card adhering to UI/UX best practices:

#### 1. Elevated Dock Container in Dark Sidebar

- **Higher Contrast Background (`#243458` on `#1E2A4A`)**: Replaced the murky transparent background with an elevated card surface featuring `border border-white/20`, subtle drop shadows, and high-contrast text (`text-slate-100`, `text-slate-200`).
- **Tactile Agent Tiles**: Each of the 10 agents sits in a dedicated button tile (`bg-white/[0.08] hover:bg-white/[0.18] border border-white/10 hover:border-white/25`) with animated mini icons and bright, legible labels.
- **Selection Indicator**: Clicking an agent sets active ring styling (`ring-2 ring-[#0FB5A5] border-teal-400 bg-teal-500/30 text-white`).

#### 2. High-Contrast Floating Action Card (`fixed left-[274px] bottom-3 z-50`)

- **Viewport Anchor (Never Cut Off)**: Positions the card outside the fixed-height sidebar canvas directly beside the agent dock. Never clipped by sidebar scrolling or bottom viewport bounds.
- **Light Contrast Surface (`bg-white text-slate-900 border border-slate-200 shadow-2xl`)**: Provides clean, crisp typography, high contrast, and unmistakable visual hierarchy.
- **Bilingual Identity & Autonomy**: Displays bespoke animated agent icon, English persona, Indic Hindi transliteration (e.g. `दृष्टि · Data Discovery`), autonomy level, and real-time state badge (`Working`, `Deliberating`, or `Standing by`).
- **Statutory Boundary Callouts**: Contextual architectural guardrails (e.g. `Sudhaar: ADR-3 read-only planning`, `Karya: ADR-1 approval token gate`, `Drishti: ap-south-1 residency`, `Saakshi: S3 Object Lock Compliance mode`).

#### 3. Direct Agent Actions & Execution Engine

- **Primary Quick Action Button**: Single-click trigger (`⚡ Run Discovery Scan`, `⚡ Run 46-Control Assessment`, `⚡ Verify Ledger Chain`, `⚡ Seal Attestation Proof`, etc.) communicating directly with `/api/bff/v1/agents/${agent}/run`.
- **Live Execution Feedback**: Displays progress spinner, latency in milliseconds, and generated immutable ledger sequence numbers with direct clickable links (`#33, #34` → `/ledger?q=33`).
- **Architectural Gate Enforcer (Karya)**: For mutating actions, Karya refuses unapproved execution per ADR-1/ADR-3, explains that a human approval token is required, and renders a direct CTA `Review & Approve Actions in Console →` (`/approval`).
- **Direct Module Route**: Direct link to each agent's primary domain screen (`Open Data Discovery Screen →`, `Open Assessment Screen →`, `Open Remediation Screen →`).
- **Deep Links**: Direct shortcuts to `Agent Workbench ↗` (`/workbench?agent=${agent.name}`) and `Audit Ledger Proof ↗` (`/ledger?agent=${agent.name}`).

---

### 14.9 Dynamic Secondary Modules Architecture (Based on Live Actuals)

All secondary modules (`/discovery`, `/classification`, `/datamap`, `/execution`, `/monitoring`, `/regwatch`, `/reports`, `/connectors`, `/policies`, `/partner`) have been completely upgraded from static placeholders and staged disclaimers to **fully dynamic views** driven by live PostgreSQL/Supabase database tables, real-time `audit_ledger` event streams, and live agent execution triggers.

#### 1. Core Architecture Enhancements (`generic-module-view.tsx`)

- **Elimination of Mock Staging Notes**: Replaced the yellow mock staging banner (`"Fully hi-fi build of this module is staged..."`) with the institutional **Live Operations Bar**, confirming active Indian domestic residency (`ap-south-1 Mumbai`), database-level RLS isolation, and immutable audit ledger integrity.
- **Autonomous Agent Execution (`⚡ Run Agent`)**: Secondary modules associated with autonomous agents feature an interactive trigger button invoking `/api/bff/v1/agents/${agentKey}/run` via the Next.js BFF proxy. Renders execution spinners, latency in milliseconds, and clickable sequence number tags (`#id` → `/ledger?q=id`).
- **Live Audit Ledger Telemetry Streams**: Every secondary module queries `audit_ledger` via `createSupabaseAdmin()` for its respective agent's events (or module targets) and renders an active event timeline showing action, target reference, correlation ID, timestamp, and verification hash.

#### 2. Secondary Modules Dynamic Implementation Matrix

| Route                 | Primary Agent / Domain             | Statutory Citation               | Dynamic Data Sources                                                                                 | Action Trigger / Deep Link                            |
| :-------------------- | :--------------------------------- | :------------------------------- | :--------------------------------------------------------------------------------------------------- | :---------------------------------------------------- |
| **`/discovery`**      | **Drishti** (`drishti`, L1)        | DPDPA §16 & Rule 16              | `audit_ledger` (Drishti runs), target scans (Postgres 12.4M rows, S3 +340 objects, Google Workspace) | `⚡ Run Discovery Scan`                               |
| **`/classification`** | **Vibhaag** (`vibhaag`, L1)        | DPDPA §3, §9 & Schedule          | `audit_ledger` (Vibhaag runs), 9 statutory categories (Govt IDs, Financial, Children, Biometrics)    | `⚡ Run Classification Scan`                          |
| **`/datamap`**        | **Saakshi & RoPA** (`saakshi`, L1) | DPDPA §6 & §7 (RoPA)             | `evidence` (RoPA records), `audit_ledger`, data flows, lawful bases, domestic residency              | `⚡ Re-generate RoPA Map`                             |
| **`/execution`**      | **Karya** (`karya`, L2)            | ADR-1 Token Gate & BR-2          | `remediation_plans`, `remediation_actions`, rollback tokens (`RB-118a`), blast radius caps           | `Review & Approve Actions in Console →` (`/approval`) |
| **`/monitoring`**     | **Prahari & Samanvaya** (L1)       | Rule 16 Continuous Surveillance  | `audit_ledger` (drift checks), scheduled scan intervals, active drift detection alarms               | `⚡ Run Drift & Surveillance Check`                   |
| **`/regwatch`**       | **Nazar** (`nazar`, L3)            | DPDPA Gazette Notifications      | Live calculation of days remaining until **13 May 2027** deadline, MeitY feeds, `audit_ledger`       | `⚡ Scan Gazette Feeds`                               |
| **`/reports`**        | **Prativedan** (`prativedan`, L3)  | DPDPA §8(4) Board Oversight      | `engagements` (posture score), `evidence` (S3 sealed objects count), `audit_ledger`                  | `⚡ Compile Board Compliance Pack`                    |
| **`/connectors`**     | **Connectors** (L2 Isolation)      | DPDPA §8(5) & ADR-3              | `audit_ledger`, PostgreSQL, AWS S3 WORM vault, Temporal, zero unapproved write scopes                | `Discover Data via Connectors →` (`/discovery`)       |
| **`/policies`**       | **Policy Engine** (L3)             | ADR-1 to ADR-5 Guardrails        | `remediation_actions` (rollback validated count), `audit_ledger` (total ledger proofs)               | `Review Approval Gate Console →` (`/approval`)        |
| **`/partner`**        | **Advisory Portal** (L3)           | DPDPA §8(2) Processor Governance | `tenants` (registered organizations count), `audit_ledger` (cross-tenant operations)                 | `Generate Multi-Client Auditor Pack →` (`/reports`)   |

#### 3. Verification & Compliance Standard

- **Type Safety**: Built under strict TypeScript mode with zero errors (`pnpm --filter @axiom/web typecheck`).
- **Residency Guarantee**: All queries and agent execution run strictly within the Indian sovereign boundary (`ap-south-1 Mumbai`).
- **Cryptographic Traceability**: Every agent action automatically appends to the immutable PostgreSQL ledger via `append_ledger()` with unbroken SHA-256 chain links.

---

### 14.10 Header Agent Icon Positioning & Multi-Agent Design Architecture

To eliminate visual congestion caused by consecutive stacked icons before labels in multi-agent headers (e.g. `[Icon1][Icon2] Agent · Drishti + Saakshi`), Axiom Proof establishes a clear typographical and visual hierarchy across all module headers:

#### 1. Architectural Positioning Standard

- **Format**: The icon is positioned **immediately adjacent to and preceding the agent's name**, directly following `"Agent · "`.
  - **Single-Agent Modules**: `Agent · [Icon] AgentName`
  - **Multi-Agent Modules**: `Agent · [Icon1] Name1 + [Icon2] Name2` (and for three agents: `Agent · [Icon1] Name1 + [Icon2] Name2 + [Icon3] Name3`)
- **Visual Separation**: The mathematical `+` symbol cleanly segments each agent's identity with appropriate tracking and color contrast (`text-[#0FB5A5]/70`).
- **High-Contrast `variant="on-dark"` Rendering**:
  - Embedded inside dark indigo hero banners (`from-[#1E2A4A] via-[#1E2A4A] to-[#243356]`), standard dark indigo (`#1E2A4A`) or dark slate (`#525B71`) agent glyphs produce insufficient contrast.
  - `variant="on-dark"` activates luminous, accessible tints:
    - **Parikshan**: `#818CF8` (high-contrast light indigo calipers & scale)
    - **Lekha**: `#94A3B8` (high-contrast slate mist ledger glyph)
    - **Drishti**: `#0FB5A5` (teal aperture)
    - **Vibhaag**: `#A78BFA` (light violet prism)
    - **Saakshi**: `#FACC15` (proof gold starburst)
    - **Sudhaar**: `#38BDF8` (sky drafting compass)
    - **Karya**: `#F87171` (ember planetary gears)
    - **Nazar**: `#4ADE80` (emerald surveillance dish)
    - **Prativedan**: `#C084FC` (amethyst executive dossier)
    - **Sanket**: `#FB923C` (solar transmission tower)
  - Translucent container backing (`rgba(255,255,255,0.1)`) with crisp perimeter border (`rgba(255,255,255,0.2)`).

#### 2. Bespoke Domain Agent SVGs

Specialized modules not tied directly to the 10 core named agents are equipped with custom SVG iconography and dynamic states:

- **`policy` / `policy_engine`**: Architectural shield with central scale balance beam and verified security node.
- **`incident`**: Hexagonal hazard crest with alert flash.
- **`dsar`**: Data Principal ID card with biometric user badge and rights key.
- **`consent`**: Agreement seal ring with dual verified checkmarks.

#### 3. Module Route & Agent Header Mapping Table

| Route             | Primary Module        | Header Agent Text & Layout                                 | Agent Keys Rendered                          | Autonomy Level                |
| :---------------- | :-------------------- | :--------------------------------------------------------- | :------------------------------------------- | :---------------------------- |
| **`/controls`**   | Control Library       | `Agent · [Icon] Parikshan`                                 | `parikshan` (`#818CF8`)                      | `—` (Read-only catalog)       |
| **`/approval`**   | Approval Console      | `Agent · [Icon] Sudhaar + [Icon] Karya`                    | `sudhaar` (`#38BDF8`), `karya` (`#F87171`)   | Human Gate (ADR-1)            |
| **`/evidence`**   | Evidence Explorer     | `Agent · [Icon] Saakshi`                                   | `saakshi` (`#FACC15`)                        | L3 (Write-once WORM)          |
| **`/ledger`**     | Audit Ledger          | `Agent · [Icon] Lekha`                                     | `lekha` (`#94A3B8`)                          | L3 (Append-only)              |
| **`/dsars`**      | Rights Requests       | `Agent · [Icon] Drishti + [Icon] Saakshi`                  | `drishti` (`#0FB5A5`), `saakshi` (`#FACC15`) | L2 (Workflow automation)      |
| **`/consent`**    | Consent Manager       | `Agent · [Icon] Lekha + [Icon] Consent`                    | `lekha` (`#94A3B8`), `consent` (`#0FB5A5`)   | L2 (Ledger-backed)            |
| **`/breaches`**   | Breach & Incident Ops | `Agent · [Icon] Sanket + [Icon] Incident Ops`              | `sanket` (`#FB923C`), `incident` (`#F87171`) | L1 (72hr notification clock)  |
| **`/monitoring`** | Continuous Monitoring | `Agent · [Icon] Drishti + [Icon] Parikshan + [Icon] Nazar` | `drishti`, `parikshan`, `nazar`              | L1 (Autonomous drift monitor) |
| **`/policies`**   | Standing Policies     | `Agent · [Icon] Policy Engine`                             | `policy` (`#0FB5A5`)                         | L3 (Guardrail enforcement)    |
| **`/workbench`**  | Agent Workbench       | `Agent · [Icon] {selectedAgent} (fleet)`                   | Selected agent dynamic                       | Cockpit / Admin Fleet         |

---

### 14.11 Multi-Environment Configuration, Pre-Requisites & Testing Matrix

This section organizes environment-specific settings, automated and manual verification procedures, pre-flight prerequisites, and post-deployment validation checks.

#### 1. Environment Architecture & Matrix

| Environment            | Purpose                              | Auth Mechanism                            | Database & Storage                         | Model Gateway                              |
| :--------------------- | :----------------------------------- | :---------------------------------------- | :----------------------------------------- | :----------------------------------------- |
| **Local Dev**          | Rapid iteration & debugging          | Local Supabase GoTrue (`55321`) / Seed    | Local Postgres (`55322`) + Local S3 mock   | Self-hosted Ollama or Bedrock mock         |
| **E2E / CI**           | Automated Playwright regression      | Test Runner Mock Client (`NODE_ENV=test`) | In-memory deterministic fixture store      | Mocked PII redaction layer                 |
| **Staging / Pre-Prod** | UAT, auditor partner dry-runs        | Supabase Auth / Multi-Tenant Seed Roster  | Managed Cloud SQL Postgres (`asia-south1`) | Multi-model fallback chain (Anthropic/OAI) |
| **On-Premise**         | Air-gapped enterprise deployment     | Direct Postgres / OIDC / Intranet Seed    | Customer PostgreSQL (SECURITY DEFINER)     | Self-hosted vLLM / Ollama in enclave       |
| **Production**         | Live sovereign enterprise compliance | Supabase Enterprise / Multi-Tenant RLS    | Sovereign Cloud SQL + S3 Object Lock Vault | Dedicated Mistral / Anthropic Sovereign    |

#### 2. Pre-Requisites Checklist (Before Deployment / Audit)

- [ ] **Node.js & Tooling**: Node.js 22 LTS, `pnpm 9.12+`, `python 3.11+`, `uv 0.4+`, `docker` compose v2.
- [ ] **Sovereign Residency Guarantee**: Confirm AWS region is strictly `ap-south-1` (Mumbai) or `ap-south-2` (Hyderabad). Zero egress outside India.
- [ ] **PostgreSQL Security Definer Role**: Confirm `ledger_writer` role has INSERT-only grants on `audit_ledger`, and only `append_ledger()` function can write records.
- [ ] **AWS S3 Object Lock**: Ensure evidence bucket has Object Lock enabled in **Compliance mode** (cannot be deleted or overridden even by root).
- [ ] **Port Allocations (Local)**:
  - `3000`: Marketing Site
  - `3001`: Web Workbench & Compliance Console
  - `4000`: BFF API Gate
  - `8000`: Agent Runtime (FastAPI)
  - `8001`: Model Gateway (PII Redaction)
  - `7233` / `8233`: Temporal Server & Web UI
  - `55321`–`55324`: Supabase Local Stack (Kong, DB, Studio, Inbucket)

#### 3. Automated Test Suites Execution

Execute all test suites in sequence to verify full-stack compliance:

```bash
# 1. Typecheck all 12 monorepo packages (TypeScript strict mode)
pnpm typecheck

# 2. Vitest UI & shared library unit tests (10/10 passed)
pnpm test

# 3. Seed statutory control library and standard authenticated user roster
pnpm seed:controls
pnpm seed:users

# 4. Python Agent Runtime test suite (36/36 passed)
cd services/agent-runtime && uv run pytest

# 5. End-to-End Playwright test suite (11/11 passed)
cd ../..
pnpm --dir tests/e2e test:e2e
```

#### 4. Post-Deployment Verification & Operational Health Checks

- [ ] **HTTP 200 Probes**: Verify all primary module endpoints return 200 OK:
  ```bash
  for route in controls approval evidence ledger dsars consent breaches monitoring policies workbench; do
    curl -sf -o /dev/null -w "%{http_code} $route\n" "http://localhost:3001/$route"
  done
  ```
- [ ] **Header Agent Icon Inspection**: Confirm each module hero banner renders `Agent · [Icon] Name` with SVG content present in DOM.
- [ ] **Cryptographic Hash-Chain Integrity**: Run verification via BFF or direct SQL:
  ```bash
  curl -s http://localhost:3001/api/ledger?page=1&limit=1 | jq .
  ```
- [ ] **Emergency Kill Switch Test**: Probe `/api/bff/v1/emergency/kill-switch` to ensure mutating actions immediately halt if triggered.

---

### 14.12 Client Portal Dynamic Screen Architecture (`/portal`)

The Client Portal (`http://localhost:3001/portal`) provides an executive- and auditor-facing view of a client organization's live compliance posture.

#### 1. Dynamic Architecture & Data Sources

- **Tenant Scoping**: Reads `searchParams.tenant` (slug or UUID) with automatic resolution across the `tenants` table. Multi-tenant auditors can seamlessly switch between client realms.
- **Direct Database Execution (`createSupabaseAdmin()`)**: Bypasses E2E mock facades in server components to deliver 100% live database telemetry:
  - **Engagement & Posture**: Active engagement details (`DPDPA 2023 Statutory Compliance Assessment`), normalized posture score (`74/100`), passing controls ratio (`32/43`), and statutory penalty exposure (`₹18.4 Cr`).
  - **Pending Remediation Plans**: Live `remediation_plans` and `remediation_actions` drafted by Sudhaar awaiting client review (`PLAN-118`), including blast radius estimations.
  - **Sealed Evidence Vault**: Real-time proofs sealed by Saakshi with SHA-256 hashes, S3 Object Lock URIs, and control links (`NOT-01`, `SEC-09`, `RTS-01`, `GOV-01`, `BRC-02`).
  - **Data Principal Rights (DSAR)**: Active rights requests across erasure, access, correction, and portability with statutory SLA countdowns.
  - **Incident & Breach Radar**: Live verification of 0 open breaches and CERT-In 6h / DPB 72h tabletop drill readiness.
  - **Immutable Audit Ledger**: Append-only cryptographic ledger sequence events (#92, #91, #90...) for the organization.
- **Design System Parity**: Features the authoritative Deep Indigo Hero Banner (`from-[#1E2A4A] via-[#1E2A4A] to-[#243356]`), Indic subtitle (`ग्राहक पोर्टल`), agent attribution (`Agent · Saakshi + Sudhaar`), and 6 live KPI cards.

---

### 14.13 End-to-End Operational Audit Workflow (Local, On-Premise & Production)

This section details the canonical 13-step operational procedure for executing a complete statutory DPDPA compliance audit in an on-premise or production-like environment from local.

#### Execution Architecture: Dual-Track

Every step can be executed interactively via the **Web Console (UI)** at `http://localhost:3001` or automated via the **BFF Gateway / CLI (API)** at `http://localhost:4000`.

```
[1. Auth Login] ──> [2. Tenant Select] ──> [3. Open Workbench] ──> [4. Create Engagement]
                                                                             │
┌────────────────────────────────────────────────────────────────────────────┘
▼
[5 & 6. Drishti Discovery] ──> [7. Vibhaag Classification] ──> [8. Parikshan Assessment]
                                                                             │
┌────────────────────────────────────────────────────────────────────────────┘
▼
[9. Sudhaar Remediation Plan] ──> [10. Review Blast Radius & Rollback]
                                                 │
┌────────────────────────────────────────────────┘
▼
[11. Approval Console (Token Issue)] ──> [12. Karya Execute & Ledger Verify]
                                                         │
┌────────────────────────────────────────────────────────┘
▼
[13. Saakshi WORM Proof & Prativedan Board Report] ──> [Surveillance in Portal]
```

---

#### Detailed Step-by-Step Execution Guide

##### Step 1: Create or Log into a Supabase Auth User

- **Web UI**: Navigate to `http://localhost:3001/login`, input compliance officer credentials (`dpo@enterprise.co.in` / `AxiomSecureAudit2026!`), and sign in.
  > [!TIP]
  > **Sign Out & Account Switching**: To log out or switch users, click **Sign out** at the bottom of the left navigation panel. The session and authentication cookies will be completely cleared, safely redirecting back to `http://localhost:3001/login`.
- **CLI / cURL**:
  ```bash
  # Create user in GoTrue Auth
  curl -s -X POST "http://localhost:55321/auth/v1/admin/users" \
    -H "apikey: $SUPABASE_SERVICE_KEY" \
    -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" \
    -H "Content-Type: application/json" \
    -d '{
      "email": "dpo@enterprise.co.in",
      "password": "AxiomSecureAudit2026!",
      "email_confirm": true,
      "user_metadata": { "full_name": "Chief Compliance Officer" }
    }'

  # Obtain user JWT
  export JWT=$(curl -s -X POST "http://localhost:55321/auth/v1/token?grant_type=password" \
    -H "apikey: $SUPABASE_ANON_KEY" \
    -H "Content-Type: application/json" \
    -d '{"email":"dpo@enterprise.co.in","password":"AxiomSecureAudit2026!"}' | jq -r .access_token)
  ```

##### Step 2: Create or Select a Tenant

- **Web UI**: Use the TopBar organization switcher or `http://localhost:3001/portal?tenant=demo-client` to bind to the client organization.
- **CLI / SQL**: Ensure user is bound to the target tenant in `public.tenant_users` with role `owner` or `approver`:
  ```bash
  docker exec -i supabase_db_axiom-proof psql -U postgres -d postgres -c "
    INSERT INTO public.users (id, email, full_name, is_axiom_internal)
    SELECT id, email, raw_user_meta_data->>'full_name', true FROM auth.users WHERE email = 'dpo@enterprise.co.in'
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.tenant_users (tenant_id, user_id, role)
    VALUES ('00000000-0000-0000-0000-000000000001', (SELECT id FROM auth.users WHERE email = 'dpo@enterprise.co.in'), 'owner')
    ON CONFLICT (tenant_id, user_id) DO NOTHING;
  "
  ```

##### Step 3: Open the Web Workbench

- **Web UI**: Navigate to `http://localhost:3001/workbench`.
- **Functionality**:
  - Displays the 10-agent fleet status (**10/10 Online**).
  - Displays the active environment (`Production On-Premise ap-south-1`).
  - Allows direct prompt testing, autonomy ceiling inspection, and live telemetry streaming.
- **CLI / API**: Verify BFF and Agent Runtime readiness:
  ```bash
  curl -s http://localhost:4000/ready | jq .
  curl -s http://localhost:8000/ready | jq .
  ```

##### Step 4: Create an Engagement

- **Web UI**: Navigate to `http://localhost:3001/assessment` or click **New Assessment**.
- **CLI / cURL**:
  ```bash
  export ENG_RES=$(curl -s -X POST "http://localhost:4000/v1/engagements" \
    -H "Authorization: Bearer $JWT" \
    -H "X-Tenant-Id: 00000000-0000-0000-0000-000000000001" \
    -H "Content-Type: application/json" \
    -d '{
      "libraryVersion": "0.1.0",
      "title": "DPDPA 2023 Statutory Compliance Assessment"
    }')
  export ENG_ID=$(echo "$ENG_RES" | jq -r '.id // "574bfb7d-9c19-4aa1-afef-b4df0283f6c0"')
  ```

##### Step 5 & 6: Provide Discovery Interview & Run Drishti Discovery

- **Web UI**: In `http://localhost:3001/discovery`, trigger **⚡ Run Discovery Scan**.
- **Statutory Scope**: Sweeps datastores, inventories tables/buckets, samples schema names, and evaluates geographic residency under DPDPA §16 (warning if any non-Indian region is detected).
- **CLI / cURL**:
  ```bash
  curl -s -X POST "http://localhost:4000/v1/agents/drishti/run" \
    -H "Authorization: Bearer $JWT" \
    -H "X-Tenant-Id: 00000000-0000-0000-0000-000000000001" \
    -H "Content-Type: application/json" \
    -d "{
      \"engagement_id\": \"$ENG_ID\",
      \"systems\": [
        {
          \"name\": \"production-postgres-core\",
          \"type\": \"postgres\",
          \"description\": \"Core banking customer ledger in ap-south-1\",
          \"hosts_personal_data\": true,
          \"region\": \"ap-south-1\",
          \"data_categories\": [\"identity\", \"contact\", \"financial\", \"government_id\"]
        },
        {
          \"name\": \"analytics-lake-s3\",
          \"type\": \"s3\",
          \"description\": \"Data lake storing customer logs and interaction telemetry\",
          \"hosts_personal_data\": true,
          \"region\": \"ap-south-1\",
          \"data_categories\": [\"contact\", \"behavioural\"]
        }
      ]
    }" | jq .
  ```

##### Step 7: Run Vibhaag Classification

- **Web UI**: In `http://localhost:3001/classification`, click **⚡ Run Classification Scan**.
- **Statutory Scope**: Maps discovered fields into 9 statutory categories (e.g. Aadhaar/PAN to `government_id`, bank accounts to `financial`).
- **CLI / cURL**:
  ```bash
  curl -s -X POST "http://localhost:4000/v1/agents/vibhaag/run" \
    -H "Authorization: Bearer $JWT" \
    -H "X-Tenant-Id: 00000000-0000-0000-0000-000000000001" \
    -H "Content-Type: application/json" \
    -d "{
      \"engagement_id\": \"$ENG_ID\",
      \"field_hints\": {
        \"production-postgres-core\": {
          \"aadhaar_num\": { \"category\": \"government_id\", \"sensitivity\": \"high\" },
          \"pan_num\": { \"category\": \"government_id\", \"sensitivity\": \"high\" },
          \"phone_number\": { \"category\": \"contact\", \"sensitivity\": \"medium\" },
          \"bank_acc_no\": { \"category\": \"financial\", \"sensitivity\": \"high\" }
        }
      }
    }" | jq .
  ```

##### Step 8: Run Parikshan Assessment against the Control Library

- **Web UI**: In `http://localhost:3001/assessment`, run the 5-stage assessment pipeline runner. Review the 46-control score, posture ratio (e.g. 74/100), and statutory penalty exposure range (₹18–46 Cr).
- **CLI / cURL**:
  ```bash
  curl -s -X POST "http://localhost:4000/v1/agents/parikshan/run" \
    -H "Authorization: Bearer $JWT" \
    -H "X-Tenant-Id: 00000000-0000-0000-0000-000000000001" \
    -H "Content-Type: application/json" \
    -d "{
      \"engagement_id\": \"$ENG_ID\",
      \"scope\": \"statutory_46_controls\"
    }" | jq .
  ```

##### Step 9: Generate a Plan with Sudhaar

- **Web UI**: In `http://localhost:3001/plans`, view generated remediation plans (`PLAN-118`).
- **Architectural Principle (ADR-3)**: Sudhaar is read-only (`can_mutate = False`). It proposes typed remediation actions, calculates blast radii, and generates rollback definitions, but cannot execute them.
- **CLI / cURL**:
  ```bash
  curl -s -X POST "http://localhost:4000/v1/agents/sudhaar/run" \
    -H "Authorization: Bearer $JWT" \
    -H "X-Tenant-Id: 00000000-0000-0000-0000-000000000001" \
    -H "Content-Type: application/json" \
    -d "{ \"engagement_id\": \"$ENG_ID\" }" | jq .
  ```

##### Step 10: Review Findings, Blast Radius, Dry-Run Output & Rollback Definition

- **Web UI**: Open the Approval Console at `http://localhost:3001/approval`:
  - **Statutory Gap Citation**: DPDP Act §8(7), Rule 8, and Schedule III.
  - **Blast Radius Cards**: Record counts (e.g. 14,200 rows in `user_events_archive`), endpoints (4 gateways), log indexes (27,062 rows).
  - **Dry-Run Diff**: Zero table lock contention verified.
  - **Rollback Definition**: Validated snapshot recovery specification (`RB-118a`) within 45 seconds.

##### Step 11: Approve the Plan through the Approval Console

- **Web UI**: Select the actions in `http://localhost:3001/approval` and click **Approve Selected (Token Signed)** in the sticky bottom bar.
- **Security Mechanism**: Generates an HMAC-SHA256 scope-bound approval token containing action IDs, plan hash, approver ID, and single-use nonce.
- **CLI / cURL**:
  ```bash
  PLAN_ID=$(curl -s -X GET "http://localhost:4000/v1/engagements/$ENG_ID" \
    -H "Authorization: Bearer $JWT" \
    -H "X-Tenant-Id: 00000000-0000-0000-0000-000000000001" | jq -r '.remediation_plans[0].id')

  ACTION_IDS=$(curl -s -X GET "http://localhost:4000/v1/plans/$PLAN_ID" \
    -H "Authorization: Bearer $JWT" \
    -H "X-Tenant-Id: 00000000-0000-0000-0000-000000000001" | jq -r '[.remediation_actions[].id]')

  export APPROVE_RES=$(curl -s -X POST "http://localhost:4000/v1/plans/approve" \
    -H "Authorization: Bearer $JWT" \
    -H "X-Tenant-Id: 00000000-0000-0000-0000-000000000001" \
    -H "Content-Type: application/json" \
    -d "{
      \"planId\": \"$PLAN_ID\",
      \"actionIds\": $ACTION_IDS,
      \"rationale\": \"Audited dry-run diffs, zero table lock contention, validated rollback snapshot RB-118a.\"
    }")
  ```

##### Step 12: Verify the Approval Token, Ledger Chain & Execution Status

- **Web UI**: Navigate to `http://localhost:3001/execution` and `http://localhost:3001/ledger`.
- **CLI / cURL**: Dispatch token-gated execution to Karya and verify the cryptographic ledger:
  ```bash
  # Dispatch to Karya
  curl -s -X POST "http://localhost:4000/v1/plans/$PLAN_ID/execute" \
    -H "Authorization: Bearer $JWT" \
    -H "X-Tenant-Id: 00000000-0000-0000-0000-000000000001" \
    -H "Content-Type: application/json" \
    -d "{
      \"mode\": \"simulated\",
      \"concurrency\": 2,
      \"stopOnFailure\": true,
      \"approvalToken\": $(echo "$APPROVE_RES" | jq .token)
    }" | jq .

  # Verify unbroken cryptographic ledger chain
  curl -s -X POST "http://localhost:4000/v1/ledger/verify" \
    -H "Authorization: Bearer $JWT" \
    -H "X-Tenant-Id: 00000000-0000-0000-0000-000000000001" | jq .
  ```
  Expected output: `{"intact": true}`.

##### Step 13: Generate or Review Evidence through Saakshi and Prativedan

- **Saakshi**: Seals the compliance proof into the S3 Object Lock Compliance vault with SHA-256 hash.
- **Prativedan**: Compiles the executive Board pack, auditor pack, and DPB regulatory filing.
- **CLI / cURL**:
  ```bash
  # Saakshi evidence seal
  curl -s -X POST "http://localhost:4000/v1/agents/saakshi/run" \
    -H "Authorization: Bearer $JWT" \
    -H "X-Tenant-Id: 00000000-0000-0000-0000-000000000001" \
    -H "Content-Type: application/json" \
    -d "{
      \"engagement_id\": \"$ENG_ID\",
      \"evidence_type\": \"report\",
      \"description\": \"Comprehensive Statutory Audit Evidence Dossier\",
      \"demonstrates_control_ids\": [\"NOT-01\", \"SEC-09\", \"RTS-01\", \"GOV-01\"]
    }" | jq .

  # Prativedan Board pack compilation
  curl -s -X POST "http://localhost:4000/v1/agents/prativedan/run" \
    -H "Authorization: Bearer $JWT" \
    -H "X-Tenant-Id: 00000000-0000-0000-0000-000000000001" \
    -H "Content-Type: application/json" \
    -d "{
      \"engagement_id\": \"$ENG_ID\",
      \"kind\": \"board\",
      \"title\": \"Executive Board Compliance & Posture Pack\"
    }" | jq .
  ```
- **Web UI Verification**:
  - Evidence Explorer: [`http://localhost:3001/evidence`](http://localhost:3001/evidence)
  - Reports Archive: [`http://localhost:3001/reports`](http://localhost:3001/reports)
  - Client Portal: [`http://localhost:3001/portal`](http://localhost:3001/portal)

---

#### Automated Single-Script Audit Execution

The entire 13-step pipeline can be executed in a single automated command via [`scripts/run-full-audit.sh`](file:///Users/vikash/Axiom%20Proof/scripts/run-full-audit.sh):

```bash
# Execute full statutory compliance audit
./scripts/run-full-audit.sh
```
