import { canonicalJson } from '@axiom/ledger';
import { prativedanAssessmentDraftRequestSchema } from '@axiom/types';
import { z } from 'zod';
const uuid = z.uuid().refine((v) => v === v.toLowerCase());
const requestText = z
  .string()
  .min(1)
  .max(4096)
  .superRefine((v, ctx) => {
    try {
      const body = prativedanAssessmentDraftRequestSchema.parse(JSON.parse(v));
      if (canonicalJson(body) !== v) throw new Error();
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Exact canonical reviewed request required' });
    }
  });
const scope = { version: z.literal(1), tenantId: uuid, actorId: uuid };
export const draftRequestIntentSchema = z.strictObject({
  ...scope,
  kind: z.literal('request'),
  reviewedRequestText: requestText,
});
export const draftReviewIntentSchema = z.strictObject({
  ...scope,
  kind: z.literal('review'),
  reviewedRequestText: requestText,
  reviewKey: uuid,
  expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.enum(['accepted', 'rejected']),
  reason: z
    .string()
    .min(20)
    .max(2000)
    .refine((v) => v === v.trim()),
});
export type DraftRequestIntent = z.infer<typeof draftRequestIntentSchema>;
export type DraftReviewIntent = z.infer<typeof draftReviewIntentSchema>;
export const draftJournalPrefix = (tenantId: string, actorId: string) =>
  `axiom.accounted-draft.v1:${uuid.parse(tenantId)}:${uuid.parse(actorId)}:`;
export function intentKey(value: DraftRequestIntent | DraftReviewIntent) {
  const operation = prativedanAssessmentDraftRequestSchema.parse(
    JSON.parse(value.reviewedRequestText),
  ).operationKey;
  return draftJournalPrefix(value.tenantId, value.actorId) + value.kind + ':' + operation;
}
export function readDraftJournal(
  storage: Storage,
  tenantId: string,
  actorId: string,
): { request: DraftRequestIntent | null; review: DraftReviewIntent | null } {
  const prefix = draftJournalPrefix(tenantId, actorId);
  // Preserve an old unstructured intent; never overwrite or silently erase it.
  if (storage.getItem(`axiom:accounted-draft:${tenantId}:${actorId}`) !== null)
    throw new Error(
      'An earlier original request is retained. Reconcile it before changing the browser journal.',
    );
  if (storage.length > 10000)
    throw new Error('Browser request storage cannot be inspected safely.');
  let request: DraftRequestIntent | null = null,
    review: DraftReviewIntent | null = null;
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key?.startsWith(prefix)) continue;
    const raw = storage.getItem(key);
    if (raw === null) continue;
    if (new TextEncoder().encode(raw).byteLength > 12288)
      throw new Error('Retained intent exceeds supported bounds.');
    const value = z
      .discriminatedUnion('kind', [draftRequestIntentSchema, draftReviewIntentSchema])
      .parse(JSON.parse(raw));
    if (
      value.tenantId !== tenantId ||
      value.actorId !== actorId ||
      intentKey(value) !== key ||
      canonicalJson(value) !== raw
    )
      throw new Error('Retained intent has changed scope or exact content.');
    if (value.kind === 'request') {
      if (request)
        throw new Error('Concurrent original requests are retained. Reconcile them first.');
      request = value;
    } else {
      if (review)
        throw new Error('Concurrent review decisions are retained. Reconcile them first.');
      review = value;
    }
  }
  if (review && (!request || review.reviewedRequestText !== request.reviewedRequestText))
    throw new Error('Retained review does not match its original request.');
  return { request, review };
}
export function assertDraftIntent(storage: Storage, value: DraftRequestIntent | DraftReviewIntent) {
  const state = readDraftJournal(storage, value.tenantId, value.actorId);
  if (storage.getItem(intentKey(value)) !== canonicalJson(value))
    throw new Error('The retained original intent changed. Reload before continuing.');
  return state;
}
export function retainDraftRequest(storage: Storage, raw: DraftRequestIntent) {
  const value = draftRequestIntentSchema.parse(raw);
  if (readDraftJournal(storage, value.tenantId, value.actorId).request)
    throw new Error('An original request is already retained. Reconcile it first.');
  const text = canonicalJson(value),
    key = intentKey(value);
  if (storage.getItem(key) !== null) throw new Error('Another tab owns this original operation.');
  storage.setItem(key, text);
  if (storage.getItem(key) !== text)
    throw new Error('Request could not be retained. Nothing was sent.');
  assertDraftIntent(storage, value);
  return value;
}
export function retainDraftReview(
  storage: Storage,
  request: DraftRequestIntent,
  raw: DraftReviewIntent,
) {
  const value = draftReviewIntentSchema.parse(raw),
    state = assertDraftIntent(storage, request);
  if (
    state.review ||
    value.tenantId !== request.tenantId ||
    value.actorId !== request.actorId ||
    value.reviewedRequestText !== request.reviewedRequestText
  )
    throw new Error(
      'A review decision is already retained or belongs to another request. Reconcile it first.',
    );
  const text = canonicalJson(value),
    key = intentKey(value);
  if (storage.getItem(key) !== null) throw new Error('Another tab owns this review decision.');
  storage.setItem(key, text);
  if (storage.getItem(key) !== text)
    throw new Error('Review decision could not be retained. Nothing was sent.');
  assertDraftIntent(storage, value);
  return value;
}
export async function withDraftJournalLock<T>(
  tenantId: string,
  actorId: string,
  run: () => Promise<T>,
) {
  if (!navigator.locks?.request)
    throw new Error(
      'This browser cannot safely coordinate retained draft decisions across tabs. Use a supported browser.',
    );
  return navigator.locks.request(draftJournalPrefix(tenantId, actorId), { mode: 'exclusive' }, run);
}
