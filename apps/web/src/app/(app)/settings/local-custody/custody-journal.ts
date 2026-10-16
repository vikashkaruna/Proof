import { z } from 'zod';
import {
  encodeLocalCustodyEvent,
  encodeLocalCustodyCancellation,
  localCustodyCancellationSchema,
  localCustodyEventRequestSchema,
  parseLocalCustodyPolicyText,
  type LocalCustodyEventRequest,
} from '@axiom/types';
export const custodyIntentSchema = z
  .object({ tenantId: z.uuid(), actorId: z.uuid(), request: localCustodyEventRequestSchema })
  .strict();
export type CustodyIntent = z.infer<typeof custodyIntentSchema>;
const prefix = (t: string, a: string) =>
  `axiom:custody-policy:v1:${z.uuid().parse(t)}:${z.uuid().parse(a)}:`;
const text = (v: CustodyIntent) => JSON.stringify(v);
export function readCustodyIntents(
  storage: Storage,
  tenantId: string,
  actorId: string,
): CustodyIntent[] {
  const p = prefix(tenantId, actorId),
    result: CustodyIntent[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key?.startsWith(p)) continue;
    const raw = storage.getItem(key);
    if (!raw || raw.length > 131072)
      throw new Error('Retained custody storage cannot be verified. Nothing will be sent.');
    const value = custodyIntentSchema.parse(JSON.parse(raw));
    if (
      value.tenantId !== tenantId ||
      value.actorId !== actorId ||
      parseLocalCustodyPolicyText(value.request.policyText).tenantId !== tenantId ||
      key !== p + value.request.operationKey
    )
      throw new Error('Retained custody context mismatch.');
    encodeLocalCustodyEvent(value.request);
    result.push(value);
    if (result.length > 20)
      throw new Error('Too many retained custody requests. Resolve them before continuing.');
  }
  const linkedPrefix = `axiom:custody-policy-resolution:v1:${tenantId}:${actorId}:`;
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key?.startsWith(linkedPrefix)) continue;
    const original = result.find((v) => key === linkedPrefix + v.request.operationKey);
    if (!original)
      throw Error(
        'Orphaned retained cancellation preserved. Restore its original request before proceeding.',
      );
    readCustodyResolution(storage, original);
  }
  return result.sort((a, b) => a.request.operationKey.localeCompare(b.request.operationKey));
}
export function retainCustodyIntent(storage: Storage, input: CustodyIntent) {
  const v = custodyIntentSchema.parse(input),
    existing = readCustodyIntents(storage, v.tenantId, v.actorId),
    own = existing.find((x) => x.request.operationKey === v.request.operationKey);
  if (existing.some((x) => text(x) !== text(v)))
    throw new Error('Resolve the retained custody request first. Nothing was sent.');
  const key = prefix(v.tenantId, v.actorId) + v.request.operationKey;
  if (own) {
    assertCustodyIntent(storage, v, true);
    return;
  }
  if (storage.getItem(key) !== null)
    throw new Error('Another tab retained this operation. Nothing was sent.');
  // LocalStorage offers no atomic cross-tab CAS. Immutable operation keys plus
  // readback/rescan detect observed races; they do not claim exclusive locking.
  storage.setItem(key, text(v));
  if (storage.getItem(key) !== text(v))
    throw new Error('Custody request could not be retained. Nothing was sent.');
  const after = readCustodyIntents(storage, v.tenantId, v.actorId);
  if (!own && after.some((x) => text(x) !== text(v)))
    throw new Error('Another tab retained a different intent. Nothing was sent.');
}
export function assertCustodyIntent(storage: Storage, v: CustodyIntent, exclusive: boolean) {
  const values = readCustodyIntents(storage, v.tenantId, v.actorId);
  if (
    !values.some((x) => text(x) === text(v)) ||
    (exclusive && values.some((x) => text(x) !== text(v)))
  )
    throw new Error('Retained custody request changed. Refresh before continuing.');
}
export function clearCustodyIntent(storage: Storage, v: CustodyIntent) {
  const key = prefix(v.tenantId, v.actorId) + v.request.operationKey,
    raw = storage.getItem(key);
  if (raw === null) return;
  if (text(custodyIntentSchema.parse(JSON.parse(raw))) !== text(v))
    throw new Error('Changed custody request preserved.');
  if (storage.getItem(key) !== raw) throw new Error('Changed custody request preserved.');
  storage.removeItem(key);
  if (storage.getItem(key) !== null)
    throw new Error('Recorded custody receipt confirmed; retained request could not be cleared.');
}
export function intentFor(tenantId: string, actorId: string, request: LocalCustodyEventRequest) {
  return custodyIntentSchema.parse({ tenantId, actorId, request });
}

const resolutionSchema = z
  .object({ tenantId: z.uuid(), actorId: z.uuid(), resolution: localCustodyCancellationSchema })
  .strict();
export type CustodyResolutionIntent = z.infer<typeof resolutionSchema>;
const resolutionKey = (v: CustodyIntent) =>
  `axiom:custody-policy-resolution:v1:${v.tenantId}:${v.actorId}:${v.request.operationKey}`;
export function readCustodyResolution(
  storage: Storage,
  original: CustodyIntent,
): CustodyResolutionIntent | null {
  const raw = storage.getItem(resolutionKey(original));
  if (raw === null) return null;
  if (raw.length > 262144) throw Error('Retained resolution cannot be verified.');
  const v = resolutionSchema.parse(JSON.parse(raw));
  if (
    v.tenantId !== original.tenantId ||
    v.actorId !== original.actorId ||
    v.resolution.originalRequestText !== encodeLocalCustodyEvent(original.request)
  )
    throw Error('Retained resolution context changed.');
  encodeLocalCustodyCancellation(v.resolution);
  return v;
}
export function retainCustodyResolution(
  storage: Storage,
  original: CustodyIntent,
  input: CustodyResolutionIntent,
) {
  assertCustodyIntent(storage, original, true);
  const v = resolutionSchema.parse(input);
  if (
    v.tenantId !== original.tenantId ||
    v.actorId !== original.actorId ||
    v.resolution.originalRequestText !== encodeLocalCustodyEvent(original.request)
  )
    throw Error('Resolution context refused.');
  encodeLocalCustodyCancellation(v.resolution);
  if (
    new TextEncoder().encode(
      JSON.stringify({
        resolution: v.resolution,
        challengeId: '00000000-0000-4000-8000-000000000000',
        code: '0'.repeat(256),
      }),
    ).length > 65536
  )
    throw Error('Cancellation envelope exceeds its bound.');
  const key = resolutionKey(original),
    raw = JSON.stringify(v),
    old = storage.getItem(key);
  if (old !== null && old !== raw) throw Error('Existing resolution preserved.');
  if (old === null) storage.setItem(key, raw);
  if (storage.getItem(key) !== raw) throw Error('Resolution could not be retained.');
  assertCustodyIntent(storage, original, true);
  return v;
}
export function assertCustodyResolution(
  storage: Storage,
  original: CustodyIntent,
  v: CustodyResolutionIntent,
) {
  assertCustodyIntent(storage, original, true);
  if (JSON.stringify(readCustodyResolution(storage, original)) !== JSON.stringify(v))
    throw Error('Retained resolution changed.');
}
export function clearCustodyResolution(
  storage: Storage,
  original: CustodyIntent,
  v: CustodyResolutionIntent,
) {
  const key = resolutionKey(original),
    raw = storage.getItem(key);
  if (raw === null) return;
  if (
    JSON.stringify(readCustodyResolution(storage, original)) !== JSON.stringify(v) ||
    storage.getItem(key) !== raw
  )
    throw Error('Changed resolution preserved.');
  storage.removeItem(key);
  if (storage.getItem(key) !== null)
    throw Error('Resolution receipt confirmed; retained storage could not be cleared.');
}
