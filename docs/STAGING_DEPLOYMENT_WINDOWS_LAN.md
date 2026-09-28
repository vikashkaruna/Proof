# Axiom Proof — Windows 11 Home & Docker Hub Staging Deployment Guide

This guide provides end-to-end instructions for deploying the **Axiom Proof** staging environment on a Windows 11 Home machine running Docker Desktop (WSL2 backend), making all modules accessible across the local network (LAN) and supporting Docker Hub image integration.

---

## 1. System Architecture Overview

The staging environment deploys the complete Axiom Proof microservices topology in Docker:

| Module / Service                                    | Internal Port |  Host / LAN Port  | Function                                                          |
| :-------------------------------------------------- | :-----------: | :---------------: | :---------------------------------------------------------------- |
| **Web Workbench** (`axiom-web`)                     |     3001      |     **3001**      | Next.js operator workbench, approval console, and customer portal |
| **Marketing Site** (`axiom-marketing`)              |     3000      |     **3000**      | Public portal, interactive gap-scan tool, and statutory landing   |
| **BFF API Engine** (`axiom-bff`)                    |     4000      |     **4000**      | Hono API, execution gate, cryptographic HMAC token issuer         |
| **Agent Runtime** (`axiom-agent-runtime`)           |     8000      |     **8000**      | FastAPI runtime orchestrating all 10 DPDPA agents                 |
| **Model Gateway** (`axiom-model-gateway`)           |     8001      |     **8001**      | Domestic PII redaction and sovereign model proxy in ap-south-1    |
| **Temporal Server** (`axiom-temporal`)              |     7233      |     **7233**      | Durable compliance workflow orchestration engine                  |
| **Temporal UI** (`axiom-temporal-ui`)               |     8080      |     **8233**      | Temporal web visualizer for workflow execution graphs             |
| **Temporal Worker** (`axiom-temporal-worker`)       |       —       |         —         | Python background execution workers for asynchronous audits       |
| **Temporal DB** (`axiom-temporal-db`)               |     5432      |     internal      | PostgreSQL 17 for Temporal state and persistence                  |
| **Supabase Gateway** (`axiom-supabase-db / gotrue`) |   8000/5432   | **55321 / 55322** | Relational state, auth JWTs, and append-only audit ledger         |
| **Supabase Studio** (`axiom-supabase-studio`)       |     3000      |     **55323**     | Database visual administration console                            |

---

## 2. Windows 11 Home Prerequisites

1. **WSL2 (Windows Subsystem for Linux 2)**:
   - Ensure virtualization is enabled in BIOS (VT-x / AMD-V).
   - Install or update WSL in PowerShell (Run as Administrator):
     ```powershell
     wsl --update
     wsl --status
     ```
2. **Docker Desktop for Windows**:
   - Install Docker Desktop from [docker.com](https://docs.docker.com/desktop/setup/install/windows-install/).
   - In Docker Desktop Settings:
     - **General**: Enable _Use the WSL 2 based engine_.
     - **Resources > WSL Integration**: Enable integration with your default distro.
     - Optional RAM limit (`%USERPROFILE%\.wslconfig`):
       ```ini
       [wsl2]
       memory=8GB
       processors=4
       ```
3. **PowerShell Execution Policy**:
   - Allow script execution for local scripts:
     ```powershell
     Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
     ```

---

## 3. Network & Windows Firewall Configuration

To access the staging environment from other laptops, tablets, or phones on the same local Wi-Fi or LAN:

### Step 3.1: Discover your Local LAN IPv4 Address

In PowerShell:

```powershell
Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -notmatch "Loopback|vEthernet|WSL" } | Select-Object IPAddress, InterfaceAlias
```

_(Example: `192.168.1.11`)_

### Step 3.2: Open Inbound Firewall Ports

Run PowerShell as **Administrator** and execute the provided helper:

```powershell
.\scripts\setup-windows-staging.ps1
```

This automatically registers inbound rules for ports: `3000, 3001, 4000, 8000, 8001, 8233, 55321, 55322, 55323` and writes your LAN IP to `infra/docker/environments/.env.staging`.

---

## 4. Docker Hub Registry Workflow (Optional)

If pulling or pushing pre-built images from Docker Hub (e.g. `vikashkaruna/axiom-*`):

### Step 4.1: Log in to Docker Hub

```powershell
docker login -u <your-dockerhub-username>
```

### Step 4.2: Build and Push Images to Docker Hub

From the repository root on your build machine:

```bash
# Set your registry username
export DOCKER_REGISTRY="vikashkaruna"
export IMAGE_TAG="staging"

# Build all images
docker compose -f docker-compose.yml -f infra/docker/docker-compose.staging.yml build

# Push images to Docker Hub
docker push ${DOCKER_REGISTRY}/axiom-model-gateway:${IMAGE_TAG}
docker push ${DOCKER_REGISTRY}/axiom-agent-runtime:${IMAGE_TAG}
docker push ${DOCKER_REGISTRY}/axiom-bff:${IMAGE_TAG}
docker push ${DOCKER_REGISTRY}/axiom-temporal-worker:${IMAGE_TAG}
docker push ${DOCKER_REGISTRY}/axiom-web:${IMAGE_TAG}
docker push ${DOCKER_REGISTRY}/axiom-marketing:${IMAGE_TAG}
```

---

## 5. Deployment Step-by-Step

### Option A: Turnkey PowerShell Launcher (Recommended on Windows)

In PowerShell:

```powershell
# To build locally and start:
.\scripts\deploy-staging.ps1 -Build

# OR to pull from Docker Hub:
.\scripts\deploy-staging.ps1 -Registry "vikashkaruna"

# To check live health status:
.\scripts\deploy-staging.ps1 -Status

# To stop the staging stack:
.\scripts\deploy-staging.ps1 -Down
```

### Option B: Direct Docker Compose CLI

In PowerShell or Git Bash:

```bash
# 1. Ensure configuration exists
cp infra/docker/environments/.env.staging.example infra/docker/environments/.env.staging

# 2. Start the stack (automatically attaches containerized Supabase if not on host)
docker compose -f docker-compose.yml \
  -f infra/docker/docker-compose.staging.yml \
  -f infra/docker/docker-compose.supabase.yml \
  --env-file infra/docker/environments/.env.staging up -d
```

---

## 6. Access Matrix (Local & LAN)

Once deployed, access points are available at both `localhost` and your LAN IP:

| Interface                  | Localhost URL                      | LAN Network URL                    | Description                                    |
| :------------------------- | :--------------------------------- | :--------------------------------- | :--------------------------------------------- |
| **Web Workbench**          | `http://localhost:3001`            | `http://<HOST_IP>:3001`            | Main operator dashboard & compliance center    |
| **Onboarding Wizard**      | `http://localhost:3001/onboarding` | `http://<HOST_IP>:3001/onboarding` | Onboard dynamic organizations live             |
| **Human Approval Console** | `http://localhost:3001/approval`   | `http://<HOST_IP>:3001/approval`   | Token issuance and blast radius dry-run review |
| **Agent Fleet Cockpit**    | `http://localhost:3001/workbench`  | `http://<HOST_IP>:3001/workbench`  | Live execution cockpit for all 12 agents       |
| **Audit Ledger**           | `http://localhost:3001/ledger`     | `http://<HOST_IP>:3001/ledger`     | Append-only Merkle hash chain viewer           |
| **Evidence Explorer**      | `http://localhost:3001/evidence`   | `http://<HOST_IP>:3001/evidence`   | Cryptographically sealed S3 evidence vault     |
| **Marketing Site**         | `http://localhost:3000`            | `http://<HOST_IP>:3000`            | Public gap-scan assessment tool                |
| **Temporal UI**            | `http://localhost:8233`            | `http://<HOST_IP>:8233`            | Durable workflow visualizer                    |
| **Supabase Studio**        | `http://localhost:55323`           | `http://<HOST_IP>:55323`           | Database administration                        |

---

## 7. Troubleshooting & FAQs

### Q1: `host.docker.internal` not resolving inside containers

- In Docker Desktop Settings > **General**, ensure **Use the WSL 2 based engine** is checked.
- All services in `docker-compose.yml` include `extra_hosts: ['host.docker.internal:host-gateway']` to guarantee resolution.

### Q2: Cannot connect from other machines on Wi-Fi

- Verify your Windows network profile is set to **Private** (not Public):
  ```powershell
  Get-NetConnectionProfile
  ```
- If Public, switch to Private:
  ```powershell
  Set-NetConnectionProfile -Name "<NetworkName>" -NetworkCategory Private
  ```
- Re-run `.\scripts\setup-windows-staging.ps1` as Administrator to apply inbound firewall allowances.

### Q3: Port conflict on port 5432 or 3000

- Supabase in Axiom Proof uses port offset `55321` (API) and `55322` (DB) precisely to avoid clashing with existing PostgreSQL or standard Supabase installs on `5432` and `54321`.
- If another app uses `3000` or `3001`, edit `MARKETING_PORT` or `WEB_PORT` in `.env.staging`.

### Q4: High memory consumption in WSL2

- Create or edit `%USERPROFILE%\.wslconfig`:
  ```ini
  [wsl2]
  memory=6GB
  swap=2GB
  ```
- Restart WSL: `wsl --shutdown` and restart Docker Desktop.
