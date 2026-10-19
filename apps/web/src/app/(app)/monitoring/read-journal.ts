import { z } from 'zod';
import {
  monitoringReadScopeIntent,
  monitoringReadScopeOperation,
  encodeMonitoringReadScope,
} from '@axiom/types';
const base = { tenantId: z.uuid(), actorId: z.uuid(), scheduleId: z.uuid() };
export const readJournal = z.discriminatedUnion('kind', [
  z
    .object({
      ...base,
      kind: z.literal('preflight'),
      operationKey: z.uuid(),
      connectorId: z.uuid(),
      engagementId: z.uuid(),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal('scope'),
      intent: monitoringReadScopeIntent,
      challengeId: z.uuid().optional(),
    })
    .strict(),
]);
export type ReadJournal = z.infer<typeof readJournal>;
const serialize = (v: ReadJournal | null) =>
  v === null ? 'null' : JSON.stringify(readJournal.parse(v));
const key = (t: string, a: string) =>
  `axiom:scheduled-read:v1:${z.uuid().parse(t)}:${z.uuid().parse(a)}`;
export function loadReadJournal(storage: Storage, t: string, a: string): ReadJournal | null {
  const raw = storage.getItem(key(t, a));
  if (raw === null) return null;
  if (raw.length > 20000) throw Error('Retained request cannot be verified. Nothing was sent.');
  const v = readJournal.parse(JSON.parse(raw));
  if (
    v.tenantId !== t ||
    v.actorId !== a ||
    (v.kind === 'scope' &&
      v.intent.phase === 'authorize' &&
      v.intent.request.scheduleId !== v.scheduleId)
  )
    throw Error('Retained request belongs to another context.');
  return v;
}
export function saveReadJournal(
  storage: Storage,
  value: ReadJournal,
  previous: ReadJournal | null = null,
) {
  const v = readJournal.parse(value),
    old = loadReadJournal(storage, v.tenantId, v.actorId);
  if (serialize(old) !== serialize(previous))
    throw Error('Another tab changed the retained request. Nothing was sent.');
  storage.setItem(key(v.tenantId, v.actorId), JSON.stringify(v));
  if (serialize(loadReadJournal(storage, v.tenantId, v.actorId)) !== serialize(v))
    throw Error('Request could not be retained. Nothing was sent.');
}
export function assertReadJournal(storage: Storage, v: ReadJournal) {
  if (serialize(loadReadJournal(storage, v.tenantId, v.actorId)) !== serialize(v))
    throw Error('Retained request changed. Nothing was sent.');
}
export async function confirmReadScope(storage: Storage, v: ReadJournal, raw: unknown) {
  if (v.kind !== 'scope') throw Error('Scope request required');
  const proof = monitoringReadScopeOperation.parse(raw);
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(encodeMonitoringReadScope(v.intent)),
  );
  const sha = Array.from(new Uint8Array(bytes), (n) => n.toString(16).padStart(2, '0')).join('');
  if (proof.requestSha256 !== sha || (!proof.recorded && !proof.fenced)) return false;
  if (
    proof.recorded &&
    (proof.revoked !== (v.intent.phase === 'revoke') ||
      proof.scopeId !==
        (v.intent.phase === 'authorize' ? v.intent.request.operationKey : v.intent.request.scopeId))
  )
    throw Error('Receipt does not match the retained scope.');
  assertReadJournal(storage, v);
  storage.removeItem(key(v.tenantId, v.actorId));
  if (loadReadJournal(storage, v.tenantId, v.actorId) !== null)
    throw Error('Recorded receipt confirmed; local request could not be cleared.');
  return true;
}
export function confirmReadPreflight(storage: Storage, v: ReadJournal, raw: unknown) {
  if (v.kind !== 'preflight') throw Error('Preflight required');
  const p = z
    .object({
      id: z.literal(v.operationKey),
      connector_id: z.literal(v.connectorId),
      engagement_id: z.literal(v.engagementId),
      status: z.literal('completed'),
      cleanup_confirmed: z.literal(true),
      expires_at: z.iso.datetime({ offset: true }),
    })
    .strict()
    .parse(raw);
  if (!p) return;
  assertReadJournal(storage, v);
  storage.removeItem(key(v.tenantId, v.actorId));
  if (loadReadJournal(storage, v.tenantId, v.actorId) !== null)
    throw Error('Completed check confirmed; local request could not be cleared.');
}
export async function withReadJournalLock<T>(
  t: string,
  a: string,
  work: () => Promise<T>,
): Promise<T> {
  if (!navigator.locks?.request)
    throw Error('Exclusive browser request locking is unavailable. No request was sent.');
  return navigator.locks.request(key(t, a), { mode: 'exclusive', ifAvailable: true }, (lock) => {
    if (!lock) throw Error('Another tab is processing this request.');
    return work();
  });
}
