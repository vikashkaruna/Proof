/** Exact human onboarding intent; not a subscription or compliance claim. */
import { z } from 'zod';
import { canonicalLocalCustody } from './local-custody-policy';
const uuid = z.uuid().transform((v) => v.toLowerCase());
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const text = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((v) => !/[\u0000\uD800-\uDFFF]/u.test(v));
export const onboardingRequest = z
  .object({
    name: text(2, 100),
    slug: text(2, 60).nullable(),
    tier: z.enum(['essential', 'growth', 'enterprise']),
    is_sdf: z.boolean(),
    processes_health_data: z.boolean(),
    processes_children_data: z.boolean(),
    dpo_name: text(1, 200).nullable(),
    dpo_email: z.string().email().max(320).nullable(),
    systems: z
      .array(
        z
          .object({
            name: text(1, 200),
            type: text(1, 100),
            description: text(0, 2000).nullable(),
            hosts_personal_data: z.boolean(),
            region: text(1, 100),
            data_categories: z.array(text(1, 100)).max(50),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export type OnboardingRequest = z.infer<typeof onboardingRequest>;
export const onboardingCreate = z
  .object({ operationKey: uuid, request: onboardingRequest })
  .strict();
export const onboardingIntent = onboardingCreate
  .extend({ schemaVersion: z.literal(1), actorId: uuid, requestSha256: sha })
  .strict();
export type OnboardingIntent = z.infer<typeof onboardingIntent>;
export const onboardingLookup = z.object({ operationKey: uuid, requestSha256: sha }).strict();
const basis = { actorId: uuid, operationKey: uuid, requestSha256: sha };
export const onboardingOperation = z.discriminatedUnion('state', [
  z
    .object({
      ...basis,
      state: z.literal('recorded'),
      tenantId: uuid,
      engagementId: uuid,
      intakeTenantId: uuid,
      libraryVersion: z.string().min(1).max(200),
      ledgerId: z.string().regex(/^[1-9][0-9]{0,18}$/),
      ledgerSha256: sha,
      createdAt: z.iso.datetime({ offset: true }),
    })
    .strict(),
  z
    .object({ ...basis, state: z.enum(['unconfirmed', 'fenced', 'recorded_access_withdrawn']) })
    .strict(),
]);
export type OnboardingOperation = z.infer<typeof onboardingOperation>;
export const encodeOnboardingRequest = (request: OnboardingRequest): string =>
  canonicalLocalCustody(onboardingRequest.parse(request));
export function verifyOnboardingOperation(
  value: unknown,
  intent: Pick<OnboardingIntent, 'actorId' | 'operationKey' | 'requestSha256'>,
): OnboardingOperation {
  const op = onboardingOperation.parse(value);
  if (
    op.actorId !== intent.actorId ||
    op.operationKey !== intent.operationKey ||
    op.requestSha256 !== intent.requestSha256
  )
    throw Error('Original onboarding proof does not match this request.');
  if (op.state === 'recorded' && op.tenantId !== op.intakeTenantId)
    throw Error('Onboarding intake proof refused.');
  return op;
}
