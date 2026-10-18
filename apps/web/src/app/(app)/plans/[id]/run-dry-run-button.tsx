'use client';

import { MutationForm } from '../../estate/estate-client';

/**
 * Asks Sudhaar's simulator to record a dry run for this plan's draft and
 * awaiting-approval actions (POST /v1/plans/:id/dry-run). Approval still
 * needs the recorded, successful run and a validated rollback (BR-2); this
 * button only requests the run.
 */
export function RunDryRunButton({ planId, tenantId }: { planId: string; tenantId: string }) {
  return (
    <MutationForm
      tenantId={tenantId}
      path={`/plans/${planId}/dry-run`}
      method="POST"
      body={() => ({})}
      label="Run dry run"
    >
      <p className="text-sm text-slate-600">
        Record a dry run for every action not yet approved. A refused run routes the action to
        manual handling.
      </p>
    </MutationForm>
  );
}
