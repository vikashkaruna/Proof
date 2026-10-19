import { z } from 'zod';
import { canonicalLocalCustody as canonicalJson } from './local-custody-policy';
const uuid = z.uuid().transform((s) => s.toLowerCase());
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const receipt = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine((s) => /^[1-9][0-9]{0,18}$/.test(s) && BigInt(s) <= 9223372036854775807n);
const reason = z
  .string()
  .trim()
  .min(20)
  .max(2000)
  .refine((s) => !/[\u0000\uD800-\uDFFF]/u.test(s));
export const monitoringReadScopeRequest = z
  .object({
    schemaVersion: z.literal(1),
    operationKey: uuid,
    scheduleId: uuid,
    estateId: uuid,
    engagementId: uuid,
    connectorId: uuid,
    grantId: uuid,
    configurationSha256: hash,
    cadence: z
      .string()
      .max(100)
      .regex(/^[0-9*,/-]+ [0-9*,/-]+ [0-9*,/-]+ [0-9*,/-]+ [0-9*,/-]+$/),
    preflightRequestId: uuid,
    previousScopeId: uuid.nullable(),
    expiresAt: z.iso.datetime({ offset: true }),
    reason,
  })
  .strict();
export const monitoringReadScopeRevocation = z
  .object({
    schemaVersion: z.literal(1),
    operationKey: uuid,
    scopeId: uuid,
    reason,
  })
  .strict();
export const monitoringReadScopeIntent = z.discriminatedUnion('phase', [
  z.object({ phase: z.literal('authorize'), request: monitoringReadScopeRequest }).strict(),
  z.object({ phase: z.literal('revoke'), request: monitoringReadScopeRevocation }).strict(),
]);
export type MonitoringReadScopeIntent = z.infer<typeof monitoringReadScopeIntent>;
export const monitoringReadScopeOperation = z.discriminatedUnion('recorded', [
  z
    .object({
      recorded: z.literal(false),
      requestSha256: hash,
      challengeExpiresAt: z.iso.datetime({ offset: true }).nullable(),
      fenced: z.boolean(),
      fenceReceiptId: receipt.nullable(),
    })
    .strict()
    .superRefine((v, c) => {
      if (v.fenced !== Boolean(v.fenceReceiptId))
        c.addIssue({ code: 'custom', message: 'Retained fence receipt required' });
    }),
  z
    .object({
      recorded: z.literal(true),
      requestSha256: hash,
      scopeId: uuid,
      receiptId: receipt,
      revoked: z.boolean(),
    })
    .strict(),
]);
export function encodeMonitoringReadScope(value: MonitoringReadScopeIntent) {
  return canonicalJson(monitoringReadScopeIntent.parse(value).request);
}

export const monitoringReadScopeContext = z
  .object({
    tenantId: uuid,
    actorId: uuid,
    scheduleId: uuid,
    estateId: uuid,
    kind: z.enum(['rediscovery', 'reassessment', 'drift_check']),
    cadence: z.string().max(100),
    status: z.enum(['active', 'paused', 'retired']),
    scopeId: uuid.nullable(),
    scopes: z
      .array(
        z
          .object({
            scopeId: uuid,
            expiresAt: z.iso.datetime({ offset: true }),
            receiptId: receipt,
            reason: z.string().max(2000),
            active: z.boolean(),
            revoked: z.boolean(),
          })
          .strict(),
      )
      .max(20),
    fires: z
      .array(
        z
          .object({
            fireId: uuid,
            dueAt: z.iso.datetime({ offset: true }),
            expiresAt: z.iso.datetime({ offset: true }),
            state: z.enum(['queued', 'handed_off', 'confirmed', 'unconfirmed', 'refused']),
            cleanupConfirmed: z.boolean().nullable(),
            requestId: uuid.nullable(),
            receiptId: receipt.nullable(),
          })
          .strict(),
      )
      .max(20),
    targets: z
      .array(
        z
          .object({
            connectorId: uuid,
            name: z.string().min(1).max(1000),
            configurationSha256: hash,
            grantId: uuid,
            maxExpiresAt: z.iso.datetime({ offset: true }),
          })
          .strict(),
      )
      .max(20),
    preflights: z
      .array(
        z
          .object({
            requestId: uuid,
            connectorId: uuid,
            engagementId: uuid,
            configurationSha256: hash,
            grantId: uuid,
            completedAt: z.iso.datetime({ offset: true }),
          })
          .strict(),
      )
      .max(20),
    engagements: z.array(z.object({ id: uuid, title: z.string().max(1000) }).strict()).max(20),
  })
  .strict();
export type MonitoringReadScopeContext = z.infer<typeof monitoringReadScopeContext>;
