# Revision 79 — C-W3-5 resumable onboarding wizard

## Scope and assumptions

This delivers C-W3-5, the next open code item in plan order after C-W1-3. The operator was available only for merge and budget decisions; the design choices below are the recommended options, recorded as assumptions:

1. The wizard runs inside an existing tenant. Organisation creation remains the audited `POST /v1/organizations/onboard` flow.
2. The wizard records progress and confirmations only. Inventory and connector registration reuse the existing audited estate and connector APIs. The wizard **never** issues connector grants or credentials, because W4.4 grant enforcement is not built. A registered connector is reported as a registration, not as a live connection.
3. A system with no connector can be marked as assessed with manual evidence, so onboarding does not depend on W4 runtime work.
4. The DPO contact is a tenant attribute (`tenants.dpo_name`, `tenants.dpo_email`). Ledger entries record only whether it is set, never the address.

## Change

- **Migration 0054** adds the ledger actions `onboarding.wizard.started`, `.step_completed` and `.completed`, the DPO columns, and `tenant_onboarding_wizards`:
  - one open run per tenant;
  - no deletion;
  - a completed run is immutable;
  - completion requires every step, an estate and a readiness snapshot;
  - members can read it; only the backend can write it.
- **Functions:**
  - `onboarding_wizard_readiness` computes a live checklist: company profile, active estate, declared systems, declared data categories, a connection path per system, and grants reviewed.
  - `start_onboarding_wizard` resumes the open run or starts one, under an advisory lock.
  - `advance_onboarding_wizard` applies one step, atomically with its ledger entry. It checks:
    - owner/admin/founder membership;
    - optimistic version;
    - that steps are completed in order, while completed steps may be revisited;
    - that changing the estate clears the later steps.

    Readiness is re-evaluated from live data at confirmation. A failed confirmation rolls back and writes nothing to the ledger.
- **BFF:**
  - `GET /v1/onboarding/wizard` requires posture read. It returns live readiness for an open run and the stored snapshot for a completed one.
  - `POST /v1/onboarding/wizard` and `POST /v1/onboarding/wizard/:id/steps` require estate management, plus tenant settings for steps.
  - Request bodies are strict per-step Zod schemas.
- **Web:** `/estate/setup` is a resumable checklist, linked from `/estate`. Each step's form is keyed to that step, so a retry key or message never carries over to the next step.
- The client `LedgerActionType` declares the three new actions.

## Verification

| Check                                                                                               | Result                                                                                      |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `onboarding-wizard.test.sql`, run on a fresh apply of 55 migrations with `service_role nobypassrls` | pass. A deliberately broken assertion fails, confirming the assertions execute.             |
| BFF `onboarding-wizard.test.ts`                                                                     | 8/8                                                                                         |
| types / web / BFF typecheck, lint, test                                                             | pass                                                                                        |
| Playwright `onboarding-setup.spec.ts` (2 journeys)                                                  | runs in CI's persona-journey job. The local parity stack was not rebuilt in this container. |

## Limits

- C-W3-6 (drift detection, re-attestation) and the W3.5 graph remain open.
- Grants are reviewed, not issued; W4.4 still owns grant creation and enforcement.
- Readiness means the declarations are complete. It does not mean the systems were verified.
