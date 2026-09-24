# Revision 80 — C-W3-6 estate sustenance and access re-attestation

## Scope and assumptions

This delivers C-W3-6, the next plan item after C-W3-5. Operator input on design was not received. The recommended options are recorded here as assumptions:

1. **Drift baseline.** Drift is measured against the last _completed_ onboarding run of an estate. Completion now writes an immutable snapshot of each attested system:
   - its version;
   - its declared categories;
   - whether it was marked manual;
   - whether a connector was registered.

   Runs completed before migration 0055 have no snapshot, and the drift report says "no baseline" rather than guessing.

2. **Re-onboarding.** Re-onboarding reuses the C-W3-5 wizard. The drift card asks the owner to start a new run.
3. **Review cadence.** Agent access is reviewed every 90 days. A grant never reviewed is due 90 days after it was issued. A "keep" decision schedules the next review 90 days later. "Revoke" revokes the grant immediately.
4. **Who reviews.** Only owners and admins (connector managers) may decide.
5. **No grant issuance.** Nothing in this change issues or extends a grant. W4.4 still owns issuance and enforcement.

## Change

- **Migration 0055** adds:
  - ledger actions `connector.grant.attested` and `connector.grant.revoked`;
  - `onboarding_attested_systems`, written only by a trigger when a run completes, read-only for everyone;
  - `onboarding_estate_drift`, which reports systems added, archived or moved, changed, and those that lost their connection path (a manual system is never reported as lost);
  - `connector_grant_attestations`, append-only;
  - `connector_grant_review_queue`;
  - `attest_connector_grant`, which checks role, grant activity and the decision, and records the decision, any revocation and the ledger entry atomically.
- **BFF:**
  - `GET /v1/estates/:id/drift` and `GET /v1/connector-grants/review` require posture read.
  - `POST /v1/connector-grants/:id/attestations` requires connector management and a strict body.
- **Web:** `/estate/setup` shows a "Changes since onboarding" card for the completed run's estate and an "Agent access review" list with keep and revoke actions.
- The client `LedgerActionType` declares both new actions.

## Verification

| Check                                                                                                                                        | Result                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `estate-sustenance.test.sql` plus the wizard, estate and connector suites, on a fresh apply of 56 migrations with `service_role nobypassrls` | pass. A deliberately broken assertion fails, confirming the assertions execute.                                                                                       |
| BFF `sustenance.test.ts`                                                                                                                     | 5/5                                                                                                                                                                   |
| Types, web and BFF typecheck, lint and test                                                                                                  | pass                                                                                                                                                                  |
| Playwright                                                                                                                                   | The drift journey is added to the onboarding journey. A new access-review journey seeds a grant directly, since grant issuance is W4.4. Both run in CI's persona job. |

## Limits

- Drift is computed on request, not on a schedule, and nothing notifies anyone. Scheduled checks and notification belong with W6 monitoring.
- The review cadence is fixed at 90 days, not configurable per tenant.
