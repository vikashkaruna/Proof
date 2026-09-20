# Axiom Proof — Multi-Environment Deployment & Operations Guide

This document is the authoritative, end-to-end deployment guide for Axiom Proof. It covers all lifecycle phases from local self-contained developer environments to multi-machine staging networks and AWS production Kubernetes clusters in `ap-south-1`.

---

## 1. Multi-Environment Architecture & Strategy

Axiom Proof strictly segregates deployment artifacts, credentials, data boundaries, and orchestration topologies across four standardized environments:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                               AXIOM PROOF ENVIRONMENTS                                │
├───────────────────┬───────────────────┬───────────────────────┬────────────────────────┤
│ 1. LOCAL          │ 2. STAGING        │ 3. PREPROD            │ 4. PRODUCTION          │
│ Local Dev / Pre-CI│ Internal Network /│ Staging VPC / Parity  │ AWS ap-south-1         │
│ Zero External Deps│ Test Cloud VPC    │ Full Mirror           │ Multi-AZ EKS + WORM    │
└───────────────────┴───────────────────┴───────────────────────┴────────────────────────┘
```

### 1.1 Environment Comparison Matrix

| Dimension           | `local`                           | `staging`                   | `preprod`                     | `production`                              |
| :------------------ | :-------------------------------- | :-------------------------- | :---------------------------- | :---------------------------------------- |
| **Primary Goal**    | Feature dev & pre-CI test         | Functional & QA validation  | Production-parity staging     | Live client compliance ops                |
| **Compute Target**  | Docker Compose (macOS/Linux)      | Local-network Docker / EC2  | AWS EKS (Staging VPC)         | AWS EKS (Production VPC)                  |
| **Database / Auth** | Local Supabase / Postgres         | Dedicated Staging Supabase  | Staging Supabase (VPC Peered) | Supabase Pro/Team (`ap-south-1`)          |
| **Evidence Vault**  | Local filesystem / MinIO mock     | Dedicated Staging S3 bucket | S3 Compliance Object Lock     | S3 WORM Compliance Lock                   |
| **Model Gateway**   | Local mock / Ollama / API         | Self-hosted Model Gateway   | Cloud-hosted Model Gateway    | Self-hosted vLLM / Bedrock (`ap-south-1`) |
| **Temporal Engine** | Local Temporal dev server         | Dedicated Staging Temporal  | Temporal Cloud Staging NS     | Temporal Cloud (`ap-south-1`)             |
| **Secrets Engine**  | `.env.local` / local env          | `.env.staging` / SSM        | AWS Secrets Manager           | AWS Secrets Manager + KMS                 |
| **Auth Bypass**     | Enabled (`AXIOM_E2E_BYPASS_AUTH`) | Disabled                    | Strictly Disabled             | Strictly Prohibited (Hard rejection)      |

---

## 2. Infrastructure & Tooling Prerequisites

### 2.1 Local Development & Pre-CI Prerequisites

- **macOS** or **Linux** workstation
- **Docker Desktop** (or Docker Engine + Compose v2.20+)
- **Node.js** ≥ 22.0.0 (Node 22 LTS is required for native WebSocket support in Supabase Realtime)
- **pnpm** ≥ 9.12.0 (`corepack enable && corepack prepare pnpm@9.12.0 --activate`)
- **uv** ≥ 0.4.0 (Fast Python package manager)
- **Python** ≥ 3.11

### 2.2 Remote, Staging & Production Prerequisites

- **AWS CLI** ≥ 2.13.0 configured with `ap-south-1` default region
- **Terraform** ≥ 1.7.0
- **kubectl** ≥ 1.29.0
- **Helm** ≥ 3.13.0
- **Supabase CLI** ≥ 1.200.0
- Registered domain with DNSSEC (e.g., `axiomproof.ai`, `app.axiomproof.ai`, `axiomminds.ai`)

---

## 3. Automation Scripts & Parameter Reference

Axiom Proof provides high-level developer and deployment scripts located in `scripts/` with convenience links in the repository root and `package.json`.

### 3.1 Master Docker Deployment Script: `scripts/dev-docker.sh` (or `./dev-docker.sh`)

Automates Docker daemon detection, macOS Docker Desktop launching, dependency building, differential container provisioning, and live health checks.

```bash
# Basic syntax
./scripts/dev-docker.sh [OPTIONS]
```

#### Supported CLI Options & Flags:

| Parameter      | Alias | Default | Description                                                                            |
| :------------- | :---- | :------ | :------------------------------------------------------------------------------------- |
| `--env <NAME>` | `-e`  | `local` | Target deployment environment: `local`, `staging`, `preprod`, `production`.            |
| `--status`     | `-s`  | `false` | Run live health verification on all services without modifying running containers.     |
| `--build`      | `-b`  | `false` | Force full container rebuild without Docker cache (`docker compose build --no-cache`). |
| `--down`       | `-d`  | `false` | Gracefully shut down all containers and networks.                                      |
| `--clean`      | `-c`  | `false` | Stop all containers and remove all persistent volumes and local data caches.           |
| `--restart`    | `-r`  | `false` | Restart all stack containers.                                                          |
| `--logs [SVC]` | `-l`  | all     | Follow live Docker container logs (optionally pass service name, e.g. `web`, `bff`).   |
| `--test`       | `-t`  | `false` | Execute full pre-CI testing suite against the running stack.                           |
| `--help`       | `-h`  | —       | Display script help and parameter guide.                                               |

#### Example Invocations:

```bash
# 1. Start local stack (auto-launches Docker Desktop if closed)
./scripts/dev-docker.sh

# 2. Check health matrix and response latencies
./scripts/dev-docker.sh --status

# 3. Deploy to a local-network staging machine using staging configuration
./scripts/dev-docker.sh --env staging

# 4. Force rebuild and deploy
./scripts/dev-docker.sh --build

# 5. Tail logs for the Agent Runtime
./scripts/dev-docker.sh --logs agent-runtime

# 6. Stop local containers
./scripts/dev-docker.sh --down
```

### 3.2 Pre-CI Verification Script: `scripts/test-local-stack.sh` (or `pnpm pre-ci`)

Executes a self-contained 5-stage verification pipeline before committing or pushing changes:

```bash
./scripts/test-local-stack.sh
# or: pnpm pre-ci
```

#### Pipeline Stages:

1. **TypeScript Workspace Unit Tests**: Runs `pnpm test` via Turborepo across all 10 packages (`@axiom/config`, `@axiom/types`, `@axiom/evidence`, `@axiom/ledger`, `@axiom/approval-engine`, `@axiom/control-library`, `@axiom/ui`, `@axiom/supabase`, `@axiom/bff`, `@axiom/web`).
2. **Agent Runtime Pytest Suite**: Runs `uv run pytest` inside `services/agent-runtime` (32 tests verifying all 10 named agents, PII redaction, canonicalization, and approval tokens).
3. **Model Gateway Pytest Suite**: Runs `uv run pytest` inside `services/model-gateway` (14 tests verifying PII redactors, ap-south-1 residency checks, and token budgets).
4. **Live HTTP Smoke Tests**: Issues HTTP probes to verify all 6 active container endpoints.
5. **Playwright E2E Browser Suite**: Runs `cd tests/e2e && pnpm test:e2e` against the live Web Workbench (`:3001`) and Marketing (`:3000`) applications (10 browser tests).

### 3.3 Root Package.json Convenience Scripts

| npm Script           | CLI Command Equivalent                                          |
| :------------------- | :-------------------------------------------------------------- |
| `pnpm docker:deploy` | `./scripts/dev-docker.sh`                                       |
| `pnpm docker:status` | `./scripts/dev-docker.sh --status`                              |
| `pnpm docker:up`     | `./scripts/dev-docker.sh`                                       |
| `pnpm docker:down`   | `./scripts/dev-docker.sh --down`                                |
| `pnpm docker:build`  | `./scripts/dev-docker.sh --build`                               |
| `pnpm docker:test`   | `./scripts/dev-docker.sh --test`                                |
| `pnpm pre-ci`        | `./scripts/test-local-stack.sh`                                 |
| `pnpm build`         | `turbo build` (builds all TS packages and Next.js applications) |
| `pnpm test`          | `turbo test` (runs all package unit tests)                      |

---

## 4. Environment Variables & Configuration Dictionary

Environment templates live in `infra/docker/environments/`:

- `infra/docker/environments/.env.local.example` (copy to `.env.local` for local development)
- `infra/docker/environments/.env.staging.example` (for staging clusters)
- `infra/docker/environments/.env.preprod.example` (for preprod mirrors)
- `infra/docker/environments/.env.production.example` (for AWS production reference)

### 4.1 Master Environment Variable Reference

| Variable Name                     | Module              | Required In  | Description / Default                                                                            |
| :-------------------------------- | :------------------ | :----------- | :----------------------------------------------------------------------------------------------- |
| `ENVIRONMENT`                     | All                 | All          | Deployment tier: `local`, `development`, `staging`, `preprod`, `production`.                     |
| `NODE_ENV`                        | Web, Marketing, BFF | All          | Node runtime mode: `development` or `production`.                                                |
| `PORT`                            | All                 | All          | Service bind port (`3000`, `3001`, `4000`, `8000`, `8001`).                                      |
| `NEXT_PUBLIC_APP_URL`             | Web                 | All          | Public Web Workbench URL (`http://localhost:3001` or `https://app.axiomproof.ai`).               |
| `NEXT_PUBLIC_MARKETING_URL`       | Web, Marketing      | All          | Public marketing website URL (`http://localhost:3000` or `https://axiomproof.ai`).               |
| `NEXT_PUBLIC_SUPABASE_URL`        | Web, Marketing      | All          | Supabase HTTP gateway (`http://localhost:55321` or Supabase project URL).                        |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY`   | Web, Marketing      | All          | Supabase public anon token.                                                                      |
| `SUPABASE_SERVICE_KEY`            | BFF, Worker         | All          | Supabase service-role key (SECURITY DEFINER operations).                                         |
| `DATABASE_URL`                    | BFF                 | Staging/Prod | Postgres connection string for direct pooled SQL execution.                                      |
| `BFF_URL`                         | Web, Marketing      | All          | BFF API internal base URL (`http://localhost:4000` or `http://bff:4000`).                        |
| `AGENT_RUNTIME_URL`               | BFF, Workers        | All          | Agent runtime FastAPI URL (`http://localhost:8000` or `http://agent-runtime:8000`).              |
| `MODEL_GATEWAY_URL`               | Agents, BFF         | All          | Model Gateway FastAPI URL (`http://localhost:8001` or `http://model-gateway:8001`).              |
| `APPROVAL_SIGNING_KEY`            | BFF, Runtime        | All          | 32-byte hex key for HMAC-SHA256 signing of human approval tokens.                                |
| `LEDGER_ENCRYPTION_KEY`           | Ledger, BFF         | Staging/Prod | 32-byte hex key for encrypting sensitive fields in append-only audit ledger.                     |
| `AXIOM_REGION`                    | All                 | All          | Sovereign region (`ap-south-1` or `asia-south1`) for DPDPA data residency compliance.            |
| `AXIOM_EVIDENCE_BUCKET`           | Evidence, BFF       | All          | Sovereign WORM bucket name configured with Compliance Object Lock.                               |
| `AXIOM_STORAGE_ENDPOINT`          | Evidence, BFF       | All          | S3-compatible storage endpoint URL (e.g. `https://storage.googleapis.com` or MinIO).             |
| `AXIOM_STORAGE_ACCESS_KEY_ID`     | Evidence, BFF       | All          | Storage credentials / GCS HMAC access key.                                                       |
| `AXIOM_STORAGE_SECRET_ACCESS_KEY` | Evidence, BFF       | All          | Storage credentials / GCS HMAC secret key.                                                       |
| `TEMPORAL_HOST_PORT`              | Worker, BFF         | All          | Temporal frontend host:port (`localhost:7233` or Temporal Cloud endpoint).                       |
| `TEMPORAL_NAMESPACE`              | Worker, BFF         | All          | Temporal namespace (`default` or `axiom-proof`).                                                 |
| `AXIOM_E2E_BYPASS_AUTH`           | Web, Supabase       | Local Only   | Bypasses Supabase auth session during automated test execution. Must be `false` in staging/prod. |

### 4.1 Getting and Updating Evidence Storage Credentials (`AXIOM_STORAGE_ACCESS_KEY_ID` & `AXIOM_STORAGE_SECRET_ACCESS_KEY`)

The Evidence Vault client (`@axiom/evidence` and `axiom.evidence_client`) seals immutable audit evidence to S3-compatible object storage across clouds and on-prem deployments.

#### A. Google Cloud Platform (Preprod & Prod)

In GCP, access is provided via Google Cloud Storage S3-interoperability HMAC keys attached to the storage service account (`axiom-<env>-storage-sa`).

- **How to GET the values**:
  - From Terraform outputs:
    ```bash
    cd infra/terraform/envs/preprod
    terraform output -raw gcs_hmac_access_id
    terraform output -raw gcs_hmac_secret
    ```
  - From Google Secret Manager:
    ```bash
    gcloud secrets versions access latest --secret="axiom-preprod-gcs-hmac-access-key" --project="axiom-proof"
    gcloud secrets versions access latest --secret="axiom-preprod-gcs-hmac-secret-key" --project="axiom-proof"
    ```
  - Using the `gcloud storage hmac` CLI:
    ```bash
    gcloud storage hmac list --service-account=axiom-preprod-storage-sa@axiom-proof.iam.gserviceaccount.com --project=axiom-proof
    ```
- **How to UPDATE the values**:
  - In `.env.preprod`: Set `AXIOM_STORAGE_ACCESS_KEY_ID=<access_id>` and `AXIOM_STORAGE_SECRET_ACCESS_KEY=<secret>`.
  - In Cloud Run: **No manual update required.** `cloudrun.tf` dynamically mounts both keys from Secret Manager.
  - To rotate: Run `terraform taint google_storage_hmac_key.s3_compat_key && terraform apply`.

#### B. Local Development & On-Premise (MinIO)

In local and on-premise environments, MinIO provides S3-compatible storage with default development credentials.

- **How to GET the values**:
  - Pre-configured defaults in `docker-compose.yml`:
    - `AXIOM_STORAGE_ACCESS_KEY_ID=minioadmin`
    - `AXIOM_STORAGE_SECRET_ACCESS_KEY=minioadmin`
    - `AXIOM_STORAGE_ENDPOINT=http://localhost:9000` (or `http://minio:9000` inside Docker)
  - Custom MinIO setup: Navigate to MinIO Console (`http://localhost:9001`) > **Identity > Service Accounts / Access Keys** to create or view keys.
- **How to UPDATE the values**:
  - Edit `.env.local` or `.env.staging` (or `.env.onprem`) with the desired Access Key and Secret.

#### C. Amazon Web Services (AWS S3)

In AWS deployments, standard IAM User or Role credentials with S3 Object Lock permissions are used.

- **How to GET the values**:
  - Generate an IAM access key pair:
    ```bash
    aws iam create-access-key --user-name axiom-evidence-vault-sa
    ```
- **How to UPDATE the values**:
  - In `.env.production`:
    ```dotenv
    AXIOM_STORAGE_ENDPOINT=https://s3.ap-south-1.amazonaws.com
    AXIOM_STORAGE_ACCESS_KEY_ID=AKIA...
    AXIOM_STORAGE_SECRET_ACCESS_KEY=...
    ```

---

## 5. Deployment Procedures by Environment

### 5.1 Local Developer Environment (`local`)

1. **Clone and Install Dependencies**:

   ```bash
   git clone git@github.com:axiomminds/axiom-proof.git
   cd axiom-proof
   pnpm install
   ```

2. **Generate Controls & Artifacts**:

   ```bash
   pnpm seed:controls
   pnpm tsx scripts/build-controls-json.mjs
   ```

3. **Deploy Local Docker Stack**:

   ```bash
   ./dev-docker.sh
   ```

   _The script automatically verifies Docker Desktop, provisions network bridges, builds any modified containers, and validates health._

4. **Verify Deployment**:

   ```bash
   ./dev-docker.sh --status
   ```

   Open `http://localhost:3001` for the Web Workbench and `http://localhost:3000` for Marketing.

5. **Run Pre-CI Test Validation**:
   ```bash
   pnpm pre-ci
   ```

---

### 5.2 Local-Network & Staging Deployment (`staging`)

For running in a staging machine on a local network or a dedicated staging VM:

1. **Prepare Staging Environment Configuration**:

   ```bash
   # Create .env.staging, or bring an existing one up to the template.
   # Only missing keys are appended; values already set are kept.
   ./scripts/sync-env.sh staging scaffold

   # Generate the secrets that must be generated. The Supabase JWT secret and
   # its anon/service keys come from ONE minting — those two are JWTs signed
   # with that secret, and mixing runs leaves GoTrue issuing tokens PostgREST
   # rejects.
   ./scripts/sync-env.sh staging mint

   # Fill in what a machine cannot generate (hostnames, provider keys), then
   # confirm. `verify` is a gate: missing or placeholder values exit non-zero.
   $EDITOR infra/docker/environments/.env.staging
   ./scripts/sync-env.sh staging verify --allow-simulated
   ```

   > `--allow-simulated` accepts the LLM, email and Temporal credentials that
   > staging deliberately runs without. It is refused for preprod and
   > production.

2. **Deploy with Staging Overlay**:

   ```bash
   ./scripts/dev-docker.sh --env staging
   ```

   _This automatically merges `docker-compose.yml` with `infra/docker/docker-compose.staging.yml` and tags images as `axiom-<service>:staging`._

3. **Run Staging Health Check**:
   ```bash
   ./scripts/dev-docker.sh --env staging --status
   ```

---

### 5.3 Production AWS Kubernetes Deployment (`production`)

Target Architecture: AWS `ap-south-1` (Mumbai) multi-AZ EKS cluster + Supabase Pro + S3 Compliance Lock.

#### Step 1: AWS Infrastructure Provisioning (Terraform)

```bash
cd infra/terraform/envs/prod

# 1. Initialize backend
terraform init

# 2. Plan and inspect resource graphs
terraform plan -out=prod.tfplan

# 3. Apply infrastructure
terraform apply prod.tfplan
```

_Provisions VPC (3 AZs), EKS cluster, S3 Evidence Vault with Compliance Object Lock, KMS keys, Secrets Manager, and ElastiCache Valkey._

#### Step 2: Supabase Schema Migration

```bash
# Apply the migration series to the deployed database.
#
# NOT `pnpm db:migrate`, which runs `supabase db push`. That cannot succeed
# here: migration 0000 creates roles and writes to the Auth-owned schema,
# which the CLI's restricted migration role may not do. It also has no
# checksum history, so it cannot tell an unapplied migration from a changed
# one.
#
# This runner records a checksum per migration, refuses changed history,
# wraps each file in its own transaction, serialises concurrent runners on an
# advisory lock, and exits non-zero when anything fails.
./scripts/migrate-cloudsql.sh "postgresql://<user>:<password>@<host>:5432/<database>"
```

> [!IMPORTANT]
> Higher environments self-host Supabase Auth and PostgREST against their own
> Postgres rather than linking a Supabase Cloud project, so there is no
> `supabase link` step. The bootstrap, GoTrue and migration ordering is
> load-bearing and documented in
> [the GCP preprod guide](GCP_PREPROD_DEPLOYMENT_GUIDE.md#self-hosted-supabase-and-why-the-order-matters).

#### Step 3: Container Image Build & Push

```bash
# Authenticate with AWS ECR or GitHub Container Registry (ghcr.io)
aws ecr get-login-password --region ap-south-1 | docker login --username AWS --password-stdin <aws-account-id>.dkr.ecr.ap-south-1.amazonaws.com

# Build and push images
TAG="prod-$(git rev-parse --short HEAD)"
docker build -f infra/docker/Dockerfile.bff -t <ecr-repo>/axiom-bff:$TAG .
docker build -f infra/docker/Dockerfile.agent-runtime -t <ecr-repo>/axiom-agent-runtime:$TAG .
docker build -f infra/docker/Dockerfile.model-gateway -t <ecr-repo>/axiom-model-gateway:$TAG .
docker build -f infra/docker/Dockerfile.web -t <ecr-repo>/axiom-web:$TAG .
docker build -f infra/docker/Dockerfile.marketing -t <ecr-repo>/axiom-marketing:$TAG .
docker build -f infra/docker/Dockerfile.temporal-worker -t <ecr-repo>/axiom-temporal-worker:$TAG .

docker push <ecr-repo>/axiom-bff:$TAG
docker push <ecr-repo>/axiom-agent-runtime:$TAG
docker push <ecr-repo>/axiom-model-gateway:$TAG
docker push <ecr-repo>/axiom-web:$TAG
docker push <ecr-repo>/axiom-marketing:$TAG
docker push <ecr-repo>/axiom-temporal-worker:$TAG
```

#### Step 4: Helm Release Deployment

```bash
# Update kubeconfig
aws eks update-kubeconfig --name axiom-proof-prod --region ap-south-1

# Deploy Helm chart
helm upgrade --install axiom-proof ./infra/helm/axiom-proof \
  --namespace axiom-proof \
  --create-namespace \
  --values ./infra/helm/axiom-proof/values-prod.yaml \
  --set image.tag=$TAG
```

---

## 6. Pre-Flight & Post-Deployment Checks

### 6.1 Pre-Flight Verification Checklist

- [x] **Controls Library Sync**: `controls.json` built and packaged in `services/agent-runtime/src/axiom/`.
- [x] **Node.js 22 LTS**: Verified container base image is `node:22-alpine` for global WebSocket support.
- [x] **Hard Rule Invariants**:
  - `SudhaarAgent.can_mutate = False`
  - Signed HMAC approval tokens required for `KaryaAgent` mutation.
  - Append-only audit ledger function `append_ledger()` verified.
  - S3 Evidence vault retention lock verified in compliance mode.
  - All LLM egress routed through Model Gateway with PII redaction.

### 6.2 Post-Deployment Health Probes

```bash
# 1. Model Gateway Health Probe
curl -fsS http://<model-gateway-host>:8001/health
# Expected: {"status":"ok","residency":"ap-south-1","redaction":"active"}

# 2. Agent Runtime Health Probe
curl -fsS http://<agent-runtime-host>:8000/health
# Expected: {"status":"ok","agents_loaded":10,"version":"0.1.0"}

# 3. BFF API Engine Health Probe
curl -fsS http://<bff-host>:4000/health
# Expected: {"status":"healthy","database":"connected","ledger":"append_only"}

# 4. Web Product App HTTP Response
curl -fsS -I http://<web-host>:3001/
# Expected: HTTP/1.1 200 OK

# 5. Marketing Site HTTP Response
curl -fsS -I http://<marketing-host>:3000/
# Expected: HTTP/1.1 200 OK
```

---

## 7. Operational Runbook & Troubleshooting

### 7.1 Docker Desktop Fails to Start on macOS

- **Symptom**: `dev-docker.sh` reports `Waiting for Docker daemon to become responsive...` and times out.
- **Resolution**:
  1. Verify Docker Desktop is installed in `/Applications/Docker.app`.
  2. Open Docker Desktop manually once to approve macOS Security & Privileges.
  3. Reset the Docker socket link:
     ```bash
     sudo ln -sf ~/.docker/run/docker.sock /var/run/docker.sock
     ```

### 7.2 Native WebSocket Error in Supabase Realtime

- **Symptom**: Next.js or BFF logs throw `Error: Node.js detected but native WebSocket not found. Suggested solution: Ensure you are running Node.js 22+`.
- **Resolution**:
  - Ensure all Dockerfiles use `node:22-alpine` as base.
  - Node 22 includes standard global `WebSocket`. Do not downgrade base images to Node 20.

### 7.3 Next.js Standalone Authentication Redirects in Local Testing

- **Symptom**: Playwright or local tests get redirected to `/login` when requesting `/workbench` or `/plans`.
- **Resolution**:
  - Next.js standalone mode sets internal `NODE_ENV=production`.
  - In `packages/config/src/index.ts` and `packages/supabase/src/e2e.ts`, ensure `ENVIRONMENT === 'development'` or `ENVIRONMENT === 'local'` is checked alongside `AXIOM_E2E_BYPASS_AUTH === 'true'`.

### 7.4 Engaging the Emergency Platform Kill Switch

To halt all in-flight agent remediation executions immediately:

1. **Via Web Approval Console**:
   Navigate to any active remediation plan (e.g. `/plans/:id`) and click **"Engage kill switch"**.

2. **Via BFF Direct API Call**:
   ```bash
   curl -X POST https://app.axiomproof.ai/api/bff/v1/kill-switch/engage \
     -H "Authorization: Bearer $ADMIN_TOKEN" \
     -H "X-Tenant-Id: $TENANT_ID" \
     -H "Content-Type: application/json" \
     -d '{"scope": "global", "reason": "Operational intervention"}'
   ```
   _Instantly revokes all active approval tokens and logs an emergency termination event in the immutable audit ledger._

### 7.5 Verifying Audit Ledger Cryptographic Integrity

```sql
-- Connect to Postgres / Supabase
SELECT * FROM verify_ledger('<tenant-uuid>');
-- Returns 0 rows if all hash chains are intact. Returns broken sequence index if tampered.
```

### 7.6 Rotating Approval Signing Key

```bash
# 1. Generate new 256-bit secret key
NEW_KEY=$(openssl rand -hex 32)

# 2. Update in AWS Secrets Manager
aws secretsmanager update-secret \
  --secret-id axiom-proof/internal \
  --secret-string "{\"approval-key\":\"$NEW_KEY\"}" \
  --region ap-south-1

# 3. Roll out restart to BFF & Agent Runtime
kubectl -n axiom-proof rollout restart deployment/axiom-proof-bff
kubectl -n axiom-proof rollout restart deployment/axiom-proof-agent-runtime
```

_Instantly invalidates all pre-existing unsigned or stale tokens._

---

## 8. Summary of Key Files

| File Path                                                                                                               | Description                                           |
| :---------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------- |
| [`scripts/dev-docker.sh`](file:///Users/vikash/Axiom%20Proof/scripts/dev-docker.sh)                                     | Master Docker automation & multi-environment manager. |
| [`scripts/test-local-stack.sh`](file:///Users/vikash/Axiom%20Proof/scripts/test-local-stack.sh)                         | Self-contained 5-stage pre-CI test pipeline.          |
| [`docker-compose.yml`](file:///Users/vikash/Axiom%20Proof/docker-compose.yml)                                           | Base & local Docker Compose stack definition.         |
| [`infra/docker/docker-compose.staging.yml`](file:///Users/vikash/Axiom%20Proof/infra/docker/docker-compose.staging.yml) | Staging compose overlay.                              |
| [`infra/docker/docker-compose.preprod.yml`](file:///Users/vikash/Axiom%20Proof/infra/docker/docker-compose.preprod.yml) | Preprod compose overlay.                              |
| [`infra/docker/docker-compose.prod.yml`](file:///Users/vikash/Axiom%20Proof/infra/docker/docker-compose.prod.yml)       | Production reference compose overlay.                 |
| [`infra/docker/environments/`](file:///Users/vikash/Axiom%20Proof/infra/docker/environments/)                           | Environment `.env.*.example` configuration templates. |
| [`docs/08_DEPLOYMENT_GUIDE.md`](file:///Users/vikash/Axiom%20Proof/docs/08_DEPLOYMENT_GUIDE.md)                         | This master deployment and operations guide.          |
