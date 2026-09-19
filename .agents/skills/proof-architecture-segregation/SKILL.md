---
name: proof-architecture-segregation
description: Strict architectural segregation of duties among Statics (Firebase Hosting), Container Apps (Cloud Run SSR/Next.js), APIs (Cloud Run BFF/Microservices), and Databases (Cloud SQL PostgreSQL/Redis) for Axiom Proof.
---

# Axiom Proof — Architectural Segregation of Duties

This skill governs the architectural separation of concerns and technical boundaries across the Axiom Proof platform, aligning with the `VK-WebPlusMobileApp-TechChoice` architectural framework.

## Core Architectural Layers & Segregation of Duties

```
┌────────────────────────────────────────────────────────────────────────┐
│                        1. STATICS LAYER                                │
│  Firebase Static Hosting / CDN Edge (axiom-proof.web.app / CDN)        │
│  - Serves static assets, pre-rendered marketing pages, images, JS/CSS  │
│  - NO business logic, NO direct database access, NO private secrets    │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │ Firebase Rewrites (/api/**, /report/**)
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│                     2. CONTAINER APPS LAYER                            │
│  Cloud Run (axiom-marketing-preprod / axiom-web-preprod on Port 3000)  │
│  - Dockerized Next.js standalone container                             │
│  - Handles SSR, dynamic routing, session cookies, input validation     │
│  - Calls internal API layer or executes scoped server workflows        │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │ Authenticated / Internal HTTP Calls
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        3. API / LOGIC LAYER                            │
│  Cloud Run BFF & Agent Runtime (Port 4000 / 8000)                      │
│  - The ONLY authoritative business logic and calculation engine        │
│  - Validates scopes, evaluates DPDPA controls, enforces dry-runs       │
│  - Coordinates external integrations (Resend emails, Model Gateway)    │
│  - The ONLY layer that writes to databases and appends to ledgers      │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │ SECURITY DEFINER / Service Role Connections
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│                       4. DATABASE LAYER                                │
│  Cloud SQL PostgreSQL (Mumbai asia-south1) & Upstash Redis Cache       │
│  - Append-only cryptographic ledger (append_ledger() function)         │
│  - Row Level Security (RLS) and strict role segregation                │
│  - Direct access strictly forbidden from client apps & static sites    │
└────────────────────────────────────────────────────────────────────────┘
```

---

## Strict Architectural Rules

### 1. Statics Layer (Firebase Hosting CDN)

- **Role**: Pure CDN edge distribution and static asset caching.
- **Rules**:
  - Never place database connection strings, service keys, or private API keys (e.g. `RESEND_API_KEY`) into static client bundles.
  - Client-side code must NEVER communicate directly with PostgreSQL or execute raw database queries.
  - All dynamic routes (`/api/**`, `/gap-scan/report/**`) must be routed to Cloud Run container services via `firebase.json` rewrites.

### 2. Container Apps Layer (Cloud Run SSR Containers)

- **Role**: Server-Side Rendering (SSR), route orchestration, and frontend application hosting.
- **Rules**:
  - Packaged using multi-stage Dockerfiles (`infra/docker/Dockerfile.marketing`, `infra/docker/Dockerfile.web`) running standalone Node.js on `$PORT`.
  - Holds only scoped runtime credentials necessary for session verification and routing.
  - Form submissions must pass validation schemas (`Zod`) before triggering backend workflows.

### 3. API & Backend Logic Layer (BFF & Microservices)

- **Role**: Sole custodian of business rules, scoring computations, approval engine, and database writes.
- **Rules**:
  - All statutory scoring (such as the DPDPA gap-scan engine and Quarterly Readiness Index) must be computed on the server.
  - Email delivery (Resend API) must execute solely in the server runtime using `AXIOM_FROM_EMAIL` (`platform@axiomproof.ai`) with CC to `AXIOM_SALES_EMAIL` (`sales@axiomproof.ai`) and BCC to `AXIOM_FOUNDER_EMAIL` (`founder@axiomminds.ai`).
  - The planning agent (Sudhaar) holds no write credentials (`can_mutate = False`).
  - No mutating action may execute without a recorded human approval and validated rollback.

### 4. Database & Storage Layer (PostgreSQL, Redis & GCS Vault)

- **Role**: State persistence and cryptographic evidence.
- **Rules**:
  - The audit ledger is append-only. Sanctioned write path is `append_ledger()`.
  - Evidence vault uses Object Lock Compliance mode.
  - All client personal data stays in `asia-south1` (Mumbai). Raw PII is redacted before model egress.

---

## Validation Checklist for Changes

1. [ ] Did any static file add direct database calls or unredacted keys? -> **Reject**.
2. [ ] Are API endpoints and dynamic SSR pages proxied via Firebase rewrites to Cloud Run? -> **Required**.
3. [ ] Are emails sent from a verified domain address (`platform@axiomproof.ai`) with sales CC and founder BCC? -> **Required**.
4. [ ] Are environment variables documented in all `.env.*.example` files? -> **Required**.
