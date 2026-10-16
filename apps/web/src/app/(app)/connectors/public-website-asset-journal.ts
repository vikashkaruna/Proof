import { z } from 'zod';
import { canonicalJson } from '@axiom/ledger';
import {
  parsePublicWebsiteAssetRequestText,
  publicWebsiteAssetCancellationRequestSchema,
  PUBLIC_WEBSITE_ASSET_MAX_BYTES,
} from '@axiom/types';
const uuid = z.uuid().transform((v) => v.toLowerCase());
export const websiteAssetIntentSchema = z
  .object({
    version: z.literal(1),
    tenantId: uuid,
    actorId: uuid,
    requestText: z.string().min(2).max(PUBLIC_WEBSITE_ASSET_MAX_BYTES),
  })
  .strict()
  .superRefine((v, ctx) => {
    try {
      parsePublicWebsiteAssetRequestText(v.requestText);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Retained public website request is invalid' });
    }
  });
export type WebsiteAssetIntent = z.infer<typeof websiteAssetIntentSchema>;
const cancellationSchema = publicWebsiteAssetCancellationRequestSchema
  .safeExtend({ version: z.literal(1), tenantId: uuid, actorId: uuid })
  .strict();
export type WebsiteAssetCancellationIntent = z.infer<typeof cancellationSchema>;
const prefix = (tenantId: string, actorId: string) =>
  `axiom.public-website-asset.operation.v1:${uuid.parse(actorId)}:${uuid.parse(tenantId)}:`;
const operationKey = (v: WebsiteAssetIntent) =>
  prefix(v.tenantId, v.actorId) + parsePublicWebsiteAssetRequestText(v.requestText).operationKey;
const cancelKey = (v: WebsiteAssetIntent) => operationKey(v) + ':cancel';
export function readWebsiteAssetIntents(
  storage: Storage,
  tenantId: string,
  actorId: string,
): { intent: WebsiteAssetIntent; cancellation: WebsiteAssetCancellationIntent | null }[] {
  if (storage.length > 10000) throw Error('Browser request storage cannot be inspected safely.');
  const entries = new Map<string, WebsiteAssetIntent>();
  const cancellations = new Map<string, WebsiteAssetCancellationIntent>();
  for (let i = 0; i < storage.length; i++) {
    const name = storage.key(i);
    if (!name?.startsWith(prefix(tenantId, actorId))) continue;
    const raw = storage.getItem(name);
    if (raw === null) continue;
    if (new TextEncoder().encode(raw).byteLength > PUBLIC_WEBSITE_ASSET_MAX_BYTES * 2 + 4096)
      throw Error('Retained website request is too large.');
    const cancelled = name.endsWith(':cancel');
    const value = cancelled
      ? cancellationSchema.parse(JSON.parse(raw))
      : websiteAssetIntentSchema.parse(JSON.parse(raw));
    if (
      value.actorId !== actorId.toLowerCase() ||
      value.tenantId !== tenantId.toLowerCase() ||
      canonicalJson(value) !== raw ||
      (cancelled ? cancelKey(value) : operationKey(value)) !== name
    )
      throw Error('Retained website request does not match its actor, tenant or exact content.');
    if (cancelled) cancellations.set(name.slice(0, -7), value as WebsiteAssetCancellationIntent);
    else entries.set(name, value);
    if (entries.size + cancellations.size > 256)
      throw Error('Reconcile retained website operations before continuing.');
  }
  for (const [name, cancel] of cancellations) {
    const own = entries.get(name);
    if (!own || own.requestText !== cancel.requestText || own.tenantId !== cancel.tenantId)
      throw Error('Retained cancellation lost its exact original request.');
  }
  return [...entries]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, intent]) => ({ intent, cancellation: cancellations.get(name) ?? null }));
}
/** Per-operation entries/readback/CAS do not claim atomic cross-tab exclusion. */
export function retainWebsiteAssetIntent(storage: Storage, input: WebsiteAssetIntent) {
  const value = websiteAssetIntentSchema.parse(input);
  if (readWebsiteAssetIntents(storage, value.tenantId, value.actorId).length)
    throw Error('Resolve retained website operations before starting another. Nothing was sent.');
  const name = operationKey(value),
    text = canonicalJson(value);
  if (storage.getItem(name) !== null) throw Error('Another operation owns this request key.');
  storage.setItem(name, text);
  if (storage.getItem(name) !== text)
    throw Error('Website request could not be retained. Nothing was sent.');
  const after = readWebsiteAssetIntents(storage, value.tenantId, value.actorId);
  if (after.length !== 1 || canonicalJson(after[0]?.intent) !== text)
    throw Error('Concurrent website requests are retained. Reconcile them before sending.');
  return value;
}
export function assertWebsiteAssetIntent(storage: Storage, value: WebsiteAssetIntent) {
  readWebsiteAssetIntents(storage, value.tenantId, value.actorId);
  if (storage.getItem(operationKey(value)) !== canonicalJson(value))
    throw Error('Retained website request changed. Reload and reconcile.');
}
export function retainWebsiteAssetCancellation(
  storage: Storage,
  intent: WebsiteAssetIntent,
  reason: string,
) {
  assertWebsiteAssetIntent(storage, intent);
  const value = cancellationSchema.parse({ ...intent, reason, confirmed: true });
  const name = cancelKey(intent),
    text = canonicalJson(value),
    prior = storage.getItem(name);
  if (prior !== null && prior !== text)
    throw Error('The original cancellation reason is retained. Reconcile that exact cancellation.');
  if (prior === null) storage.setItem(name, text);
  if (storage.getItem(name) !== text)
    throw Error('Cancellation could not be retained. Nothing was sent.');
  readWebsiteAssetIntents(storage, intent.tenantId, intent.actorId);
  return value;
}
/** Call only after a strictly validated exact recorded/cancelled positive receipt. */
export function clearConfirmedWebsiteAssetIntent(
  storage: Storage,
  intent: WebsiteAssetIntent,
  cancellation: WebsiteAssetCancellationIntent | null,
) {
  assertWebsiteAssetIntent(storage, intent);
  const name = cancelKey(intent),
    raw = storage.getItem(name);
  if (raw !== (cancellation ? canonicalJson(cancellation) : null))
    throw Error('Another cancellation owns the retained request.');
  if (raw !== null) {
    storage.removeItem(name);
    if (storage.getItem(name) !== null)
      throw Error('Confirmed cancellation remains in this browser.');
  }
  if (storage.getItem(operationKey(intent)) !== canonicalJson(intent))
    throw Error('Retained website request changed before clearing.');
  storage.removeItem(operationKey(intent));
  if (storage.getItem(operationKey(intent)) !== null)
    throw Error('Confirmed website request remains in this browser.');
}
