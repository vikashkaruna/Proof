/** Explicit human approval contract, unwired until dedicated 0119 intake/UI exists. */
import { canonicalJson } from '@axiom/ledger';
import { z } from 'zod';
import { StageUnconfirmed } from './saakshi-staging-port.js';
export const humanRetentionApprovalSchema = z
  .object({
    provider: z.enum(['s3', 's3-compatible']),
    bucket: z.string().min(3).max(255),
    lockMode: z.literal('COMPLIANCE'),
    retentionPolicy: z.literal('seven_years'),
    encryption: z.enum(['AES256', 'aws:kms']),
    legalHold: z.boolean(),
    acknowledgesImmutableRetention: z.literal(true),
  })
  .strict();
const configurationSchema = humanRetentionApprovalSchema.omit({
  acknowledgesImmutableRetention: true,
});
export type HumanRetentionApproval = z.infer<typeof humanRetentionApprovalSchema>;
export function assertConfiguredHumanRetentionApproval(
  input: unknown,
  configured: unknown,
): HumanRetentionApproval {
  const approval = humanRetentionApprovalSchema.safeParse(input);
  const config = configurationSchema.safeParse(configured);
  if (!approval.success || !config.success) throw new StageUnconfirmed();
  const { acknowledgesImmutableRetention: acknowledged, ...values } = approval.data;
  if (acknowledged !== true || canonicalJson(values) !== canonicalJson(config.data))
    throw new StageUnconfirmed();
  return approval.data;
}
