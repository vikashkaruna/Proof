---
classification: shared
---

# Axiom Proof overview

Axiom Proof is an agentic DPDPA (India's Digital Personal Data Protection Act)
compliance platform. Agents do the work, a human approves, and the proof is
recorded automatically.

## Operating principles

- No mutating agent action runs without a recorded human approval. Approval
  needs a completed dry-run and a validated rollback plan.
- The planning agent holds no write credentials (separation of duties).
- The audit ledger is append-only; evidence is sealed with retention locks.
- Client personal data stays in the `ap-south-1` region; the model gateway
  redacts personal data before any egress.

## Repository layout

| Path                        | Contents                                                             |
| --------------------------- | -------------------------------------------------------------------- |
| `apps/web`                  | Product application (Workbench)                                      |
| `apps/marketing`            | Public website                                                       |
| `services/bff`              | API and execution gate (Hono)                                        |
| `services/agent-runtime`    | Named agents (FastAPI)                                               |
| `services/model-gateway`    | Model routing and redaction (FastAPI)                                |
| `services/temporal-workers` | Durable orchestration                                                |
| `packages/*`                | Shared types, UI, control library, ledger, evidence, approval engine |
| `infra/*`                   | Database migrations, containers, Helm, Terraform                     |
| `tests/*`                   | End-to-end and script tests                                          |

Product, architecture, operations and test documentation is operator-internal
and is not stored in Git; see [`../README.md`](../README.md) for the
confidentiality policy.
