import { z } from 'zod';
import {
  encodeCoverageScopeIntent,
  coverageScopeIntent,
  coverageScopeOperation,
} from '@axiom/types';
const uuid = z.uuid().refine((v) => v === v.toLowerCase());
export const journalSchema = z
  .object({
    version: z.literal(1),
    tenantId: uuid,
    actorId: uuid,
    intent: coverageScopeIntent,
    challengeId: uuid.nullable(),
    challengeExpiresAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict()
  .superRefine((v, c) => {
    if (
      Boolean(v.challengeId) !== Boolean(v.challengeExpiresAt) ||
      (v.intent.phase === 'authorize' &&
        (v.intent.request.tenantId !== v.tenantId || v.intent.request.ownerId !== v.actorId))
    )
      c.addIssue({ code: 'custom', message: 'Exact actor and organization bound intent required' });
  });
export type CoverageJournal = z.infer<typeof journalSchema>;
export const journalKey = (tenantId: string, actorId: string) =>
  `axiom.scheduled-coverage.v1:${uuid.parse(tenantId)}:${uuid.parse(actorId)}`;
export const journalText = (v: CoverageJournal) => JSON.stringify(journalSchema.parse(v));
export function readJournal(
  storage: Storage,
  tenantId: string,
  actorId: string,
): CoverageJournal | null {
  const raw = storage.getItem(journalKey(tenantId, actorId));
  if (raw === null) return null;
  if (new TextEncoder().encode(raw).length > 20000)
    throw new Error('Retained request exceeds supported bounds. Preserve it for review.');
  const value = journalSchema.parse(JSON.parse(raw));
  if (value.tenantId !== tenantId || value.actorId !== actorId || journalText(value) !== raw)
    throw new Error('Retained request changed scope or exact content. Preserve it for review.');
  return value;
}
export function assertJournal(storage: Storage, v: CoverageJournal) {
  const read = readJournal(storage, v.tenantId, v.actorId);
  if (!read || journalText(read) !== journalText(v))
    throw new Error('Another tab changed the original request. Reload before continuing.');
  return read;
}
export function writeJournal(
  storage: Storage,
  v: CoverageJournal,
  previous: CoverageJournal | null,
) {
  const current = readJournal(storage, v.tenantId, v.actorId);
  if ((current ? journalText(current) : null) !== (previous ? journalText(previous) : null))
    throw new Error('Another tab retained a different original request. Reload first.');
  if (
    previous &&
    encodeCoverageScopeIntent(previous.intent) !== encodeCoverageScopeIntent(v.intent)
  )
    throw new Error('The original operation cannot be replaced.');
  if (
    previous?.challengeId &&
    (v.challengeId !== previous.challengeId || v.challengeExpiresAt !== previous.challengeExpiresAt)
  )
    throw new Error(
      'The original authenticator challenge cannot be replaced. Recover or fence this request.',
    );
  const text = journalText(v);
  if (new TextEncoder().encode(text).byteLength > 20000)
    throw new Error('Retained request exceeds supported bounds. Nothing was sent.');
  storage.setItem(journalKey(v.tenantId, v.actorId), text);
  if (storage.getItem(journalKey(v.tenantId, v.actorId)) !== text)
    throw new Error('Browser storage could not retain this request. Nothing was sent.');
  return assertJournal(storage, v);
}
export async function intentHash(v: CoverageJournal) {
  const data = new TextEncoder().encode(encodeCoverageScopeIntent(v.intent));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}
export async function validateOperation(v: CoverageJournal, raw: unknown) {
  const proof = coverageScopeOperation.parse(raw);
  if (
    proof.tenantId !== v.tenantId ||
    proof.actorId !== v.actorId ||
    proof.phase !== v.intent.phase ||
    proof.operationKey !== v.intent.request.operationKey ||
    proof.requestSha256 !== (await intentHash(v)) ||
    (proof.recorded && v.intent.phase === 'revoke' && !proof.revoked) ||
    (proof.recorded &&
      proof.scopeId !==
        (v.intent.phase === 'authorize' ? v.intent.request.operationKey : v.intent.request.scopeId))
  )
    throw new Error('Original request has no matching recorded or fenced receipt. Preserve it.');
  return proof;
}
export async function archiveConfirmed(storage: Storage, v: CoverageJournal, raw: unknown) {
  assertJournal(storage, v);
  const proof = await validateOperation(v, raw);
  if (!proof.recorded && !proof.fenced)
    throw new Error('Original request has no matching recorded or fenced receipt. Preserve it.');
  const archive = journalKey(v.tenantId, v.actorId) + ':archive:' + v.intent.request.operationKey;
  const text = JSON.stringify({ original: v, proof });
  const existing = storage.getItem(archive);
  if (existing !== null && existing !== text)
    throw new Error('Archived original receipt differs. Preserve both for review.');
  storage.setItem(archive, text);
  if (storage.getItem(archive) !== text)
    throw new Error('Original receipt could not be archived. Preserve this request.');
  assertJournal(storage, v);
  storage.removeItem(journalKey(v.tenantId, v.actorId));
  if (storage.getItem(journalKey(v.tenantId, v.actorId)) !== null)
    throw new Error('Original request remains retained. Reload first.');
}
export async function locked<T>(t: string, a: string, run: () => Promise<T>) {
  if (!navigator.locks?.request)
    throw new Error(
      'A browser with Web Locks is required to protect original approval requests across tabs.',
    );
  return navigator.locks.request(journalKey(t, a), { mode: 'exclusive' }, run);
}
