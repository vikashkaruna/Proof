'use client';

import { z } from 'zod';
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
      successMessage="Dry-run request completed. Review the recorded results and any refusals below before approval."
      validateResult={(result) =>
        z
          .object({
            data: z.array(
              z.object({
                actionId: z.string().min(1),
                status: z.enum(['recorded', 'refused', 'unavailable']),
              }),
            ),
            summary: z.object({
              requested: z.number().int().nonnegative(),
              recorded: z.number().int().nonnegative(),
              refused: z.number().int().nonnegative(),
              unavailable: z.number().int().nonnegative(),
            }),
          })
          .safeParse(result).success
      }
    >
      <p className="text-sm text-slate-600">
        Record a dry run for every action not yet approved. A refused run routes the action to
        manual handling.
      </p>
    </MutationForm>
  );
}
