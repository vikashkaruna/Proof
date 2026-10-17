import { z } from 'zod';
import { localCustodyEventReceiptSchema } from './local-custody-policy';
const id = z.uuid();
export const localCustodyContextRowSchema = z
  .object({
    policyId: id,
    policyText: z.string().max(16384),
    policySha256: z.string().regex(/^[a-f0-9]{64}$/),
    keyPolicySha256: z.string().regex(/^[a-f0-9]{64}$/),
    head: z
      .object({
        eventId: id,
        state: z.enum(['requested', 'approved', 'active', 'revoked']),
        activationEpoch: z.number().int().safe().nonnegative(),
        reviewDueAt: z.number().int().safe().positive(),
      })
      .strict(),
    reviewOverdue: z.boolean(),
    actions: z.array(z.enum(['approve', 'activate', 'revoke', 'review'])).max(4),
  })
  .strict();
export const localCustodyContextSchema = z
  .object({
    version: z.literal(1),
    tenantId: id,
    actorId: id,
    isDemo: z.boolean(),
    canRequest: z.boolean(),
    requestModes: z.array(z.enum(['operator_managed', 'local_demo'])).max(2),
    selectedPolicyId: id.nullable(),
    rows: z.array(localCustodyContextRowSchema).max(20),
    nextCursor: id.nullable(),
    history: z.array(localCustodyEventReceiptSchema).max(20),
    nextHistoryCursor: z
      .string()
      .regex(/^[1-9][0-9]{0,18}$/)
      .nullable(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      v.canRequest !== v.requestModes.length > 0 ||
      new Set(v.requestModes).size !== v.requestModes.length
    )
      ctx.addIssue({ code: 'custom', message: 'Current request mode context refused' });
  });
export type LocalCustodyContext = z.infer<typeof localCustodyContextSchema>;
export type LocalCustodyContextRow = z.infer<typeof localCustodyContextRowSchema>;
