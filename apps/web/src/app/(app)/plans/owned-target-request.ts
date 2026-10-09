/** Unmounted owned synthetic source journal. No automatic dispatch or approval authority. */
import { z } from 'zod';
import { canonicalJson, sha256 } from '@axiom/ledger';
const uuid = z.uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const receipt = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine((value) => value.length < 19 || (value.length === 19 && value <= '9223372036854775807'));
export const ownedHumanRequestSchema = z
  .object({
    operationKey: uuid,
    bindingId: uuid,
    engagementId: uuid,
    expectedSnapshotHash: hash,
    reason: z.string().trim().min(20).max(2000),
    acknowledgeOwnedSynthetic: z.literal(true),
    actionType: z.literal('config.audit_log_enable'),
    desiredEnabled: z.literal(true),
  })
  .strict();
const cancellation = z
  .object({ cancellationKey: uuid, reason: z.string().trim().min(20).max(2000) })
  .strict();
export const ownedJournalSchema = z
  .object({
    version: z.literal(1),
    tenantId: uuid,
    actorId: uuid,
    request: ownedHumanRequestSchema,
    cancellation: cancellation.optional(),
  })
  .strict();
export type OwnedRequestJournal = z.infer<typeof ownedJournalSchema>;
const planReceipt = z
  .object({
    tenantId: uuid,
    actorId: uuid,
    operationKey: uuid,
    requestHash: hash,
    bindingId: uuid,
    engagementId: uuid,
    planId: uuid,
    actionId: uuid,
    purpose: z.literal('remediation'),
    generatedBy: z.literal('human'),
    status: z.literal('review'),
    actionCount: z.literal(1),
    closesFindingCount: z.literal(0),
    approvalTokenId: z.null(),
    executionAllowed: z.literal(false),
    humanReceipt: receipt,
    snapshotHash: hash,
    validationHash: hash,
  })
  .strict();
const cancelledReceipt = z
  .object({
    tenantId: uuid,
    actorId: uuid,
    operationKey: uuid,
    requestHash: hash,
    cancellationKey: uuid,
    reason: z.string().min(20).max(2000),
    state: z.literal('cancelled'),
    humanReceipt: receipt,
    planId: z.null(),
    executionAllowed: z.literal(false),
  })
  .strict();
export const OWNED_REQUEST_CHANGED = 'axiom-owned-request-changed';
export class OwnedRequestError extends Error {}
export function ownedRequestJournalKey(tenantId: string, actorId: string) {
  return `axiom:owned-synthetic-request:v1:${tenantId}:${actorId}`;
}
function notify() {
  window.dispatchEvent(new Event(OWNED_REQUEST_CHANGED));
}
export function readOwnedRequestJournal(
  storage: Pick<Storage, 'getItem'>,
  tenantId: string,
  actorId: string,
) {
  const raw = storage.getItem(ownedRequestJournalKey(tenantId, actorId));
  if (raw === null) return null;
  if (raw.length > 16000)
    throw new OwnedRequestError('The original request is unreadable. Preserve it for review.');
  const value = ownedJournalSchema.parse(JSON.parse(raw));
  if (value.tenantId !== tenantId || value.actorId !== actorId)
    throw new OwnedRequestError('The original request belongs to another session.');
  return value;
}
/** Caller must hold withOwnedRequestLock for all journal mutations and manual submit. */
export function retainOwnedRequestJournal(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  input: OwnedRequestJournal,
) {
  const value = ownedJournalSchema.parse(input);
  const old = readOwnedRequestJournal(storage, value.tenantId, value.actorId);
  if (old && canonicalJson(old) !== canonicalJson(value))
    throw new OwnedRequestError('Resolve the original request before creating another.');
  const key = ownedRequestJournalKey(value.tenantId, value.actorId),
    raw = JSON.stringify(value);
  storage.setItem(key, raw);
  if (storage.getItem(key) !== raw)
    throw new OwnedRequestError(
      'The original request could not be retained. Nothing was submitted.',
    );
  notify();
  return value;
}
export function retainOwnedCancellation(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  input: OwnedRequestJournal,
  stop: z.infer<typeof cancellation>,
) {
  const original = ownedJournalSchema.parse(input),
    current = readOwnedRequestJournal(storage, original.tenantId, original.actorId);
  if (!current || canonicalJson(current) !== canonicalJson(original))
    throw new OwnedRequestError('The retained original changed. Nothing was submitted.');
  const next = ownedJournalSchema.parse({ ...original, cancellation: cancellation.parse(stop) });
  if (original.cancellation && canonicalJson(original) !== canonicalJson(next))
    throw new OwnedRequestError('Retry the exact original cancellation.');
  const key = ownedRequestJournalKey(next.tenantId, next.actorId),
    raw = JSON.stringify(next);
  storage.setItem(key, raw);
  if (storage.getItem(key) !== raw)
    throw new OwnedRequestError('The cancellation could not be retained. Nothing was submitted.');
  notify();
  return next;
}
export async function withOwnedRequestLock<T>(
  tenantId: string,
  actorId: string,
  work: () => Promise<T>,
): Promise<T> {
  if (!navigator.locks?.request)
    throw new OwnedRequestError('Safe request coordination is unavailable in this browser.');
  return navigator.locks.request(
    ownedRequestJournalKey(tenantId, actorId),
    { mode: 'exclusive', ifAvailable: true },
    async (lock) => {
      if (!lock) throw new OwnedRequestError('Another tab is handling this original request.');
      return work();
    },
  );
}
const verified = new WeakMap<object, string>();
export type ConfirmedOwnedOutcome =
  | { kind: 'recorded'; receipt: z.infer<typeof planReceipt> }
  | { kind: 'cancelled'; receipt: z.infer<typeof cancelledReceipt> };
/** Validates either the original write response or a read-only original-source recovery response. */
async function confirmOwnedOutcome(
  input: OwnedRequestJournal,
  kind: 'recorded' | 'cancelled',
  raw: unknown,
): Promise<ConfirmedOwnedOutcome> {
  const value = ownedJournalSchema.parse(input);
  const requestHash = await sha256(
    canonicalJson({ tenantId: value.tenantId, actorId: value.actorId, request: value.request }),
  );
  const outcome: ConfirmedOwnedOutcome =
    kind === 'recorded'
      ? { kind, receipt: planReceipt.parse(raw) }
      : { kind, receipt: cancelledReceipt.parse(raw) };
  const r = outcome.receipt;
  if (
    r.tenantId !== value.tenantId ||
    r.actorId !== value.actorId ||
    r.operationKey !== value.request.operationKey ||
    r.requestHash !== requestHash
  )
    throw new OwnedRequestError('The outcome does not match the original human request.');
  if (
    outcome.kind === 'recorded' &&
    (outcome.receipt.bindingId !== value.request.bindingId ||
      outcome.receipt.engagementId !== value.request.engagementId ||
      outcome.receipt.snapshotHash !== value.request.expectedSnapshotHash)
  )
    throw new OwnedRequestError('The plan source changed. Preserve the original request.');
  if (
    outcome.kind === 'cancelled' &&
    (!value.cancellation ||
      outcome.receipt.cancellationKey !== value.cancellation.cancellationKey ||
      outcome.receipt.reason !== value.cancellation.reason)
  )
    throw new OwnedRequestError('The cancellation does not match the retained request.');
  verified.set(outcome, canonicalJson({ journal: value, outcome }));
  return outcome;
}
export function archiveConfirmedOwnedRequest(
  storage: Pick<Storage, 'getItem' | 'removeItem'>,
  input: OwnedRequestJournal,
  outcome: ConfirmedOwnedOutcome,
) {
  const value = ownedJournalSchema.parse(input);
  if (
    verified.get(outcome) !== canonicalJson({ journal: value, outcome }) ||
    canonicalJson(readOwnedRequestJournal(storage, value.tenantId, value.actorId)) !==
      canonicalJson(value)
  )
    throw new OwnedRequestError('The outcome or original request changed. Nothing was archived.');
  const key = ownedRequestJournalKey(value.tenantId, value.actorId);
  storage.removeItem(key);
  if (storage.getItem(key) !== null)
    throw new OwnedRequestError('The original browser reference could not be archived.');
  notify();
}
/** One manual write, using a trusted mounted transport. Interrupted replies keep the durable journal. */
export async function submitOwnedOriginal(
  storage: Pick<Storage, 'getItem'>,
  input: OwnedRequestJournal,
  write: (request: z.infer<typeof ownedHumanRequestSchema>) => Promise<unknown>,
) {
  const value = ownedJournalSchema.parse(input);
  if (
    value.cancellation ||
    canonicalJson(readOwnedRequestJournal(storage, value.tenantId, value.actorId)) !==
      canonicalJson(value)
  )
    throw new OwnedRequestError('Resolve the retained cancellation or changed original first.');
  return confirmOwnedOutcome(value, 'recorded', await write(value.request));
}
export async function submitOwnedCancellation(
  storage: Pick<Storage, 'getItem'>,
  input: OwnedRequestJournal,
  write: (body: {
    request: z.infer<typeof ownedHumanRequestSchema>;
    cancellationKey: string;
    reason: string;
  }) => Promise<unknown>,
) {
  const value = ownedJournalSchema.parse(input);
  if (
    !value.cancellation ||
    canonicalJson(readOwnedRequestJournal(storage, value.tenantId, value.actorId)) !==
      canonicalJson(value)
  )
    throw new OwnedRequestError('Retain the exact cancellation before submitting.');
  return confirmOwnedOutcome(
    value,
    'cancelled',
    await write({ request: value.request, ...value.cancellation }),
  );
}

/** Read-only source recovery never turns an uncertain pending stop into a new plan write. */
export async function recoverOwnedOriginalOutcome(
  storage: Pick<Storage, 'getItem'>,
  input: OwnedRequestJournal,
  readOriginal: (request: z.infer<typeof ownedHumanRequestSchema>) => Promise<unknown>,
): Promise<ConfirmedOwnedOutcome> {
  const value = ownedJournalSchema.parse(input);
  if (
    canonicalJson(readOwnedRequestJournal(storage, value.tenantId, value.actorId)) !==
    canonicalJson(value)
  )
    throw new OwnedRequestError('The retained original changed. Nothing was submitted.');
  const result = z
    .object({ state: z.enum(['recorded', 'cancelled']), receipt: z.unknown() })
    .strict()
    .parse(await readOriginal(value.request));
  return confirmOwnedOutcome(value, result.state, result.receipt);
}
