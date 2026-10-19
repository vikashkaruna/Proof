import { z } from 'zod';
import { encodeDataFlowIntent, dataFlowIntent, dataFlowOperation } from '@axiom/types';
const uuid = z.uuid();
export const journalSchema = z
  .object({
    version: z.literal(1),
    tenantId: uuid,
    actorId: uuid,
    intent: dataFlowIntent,
    challengeId: uuid.nullable(),
    challengeExpiresAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict()
  .superRefine((v, c) => {
    if (Boolean(v.challengeId) !== Boolean(v.challengeExpiresAt))
      c.addIssue({ code: 'custom', message: 'Exact actor and organization bound intent required' });
  });
export type DataFlowJournal = z.infer<typeof journalSchema>;
export const journalKey = (tenantId: string, actorId: string) =>
  `axiom.data-flow.v1:${uuid.parse(tenantId)}:${uuid.parse(actorId)}`;
export const journalText = (v: DataFlowJournal) => JSON.stringify(journalSchema.parse(v));
export function readJournal(
  storage: Storage,
  tenantId: string,
  actorId: string,
): DataFlowJournal | null {
  const raw = storage.getItem(journalKey(tenantId, actorId));
  if (raw === null) return null;
  if (new TextEncoder().encode(raw).length > 24000)
    throw new Error('Retained request exceeds supported bounds. Preserve it for review.');
  let value: DataFlowJournal;
  try {
    value = journalSchema.parse(JSON.parse(raw));
  } catch {
    throw new Error(
      'The retained declaration is malformed. Preserve it for review; no replacement was sent.',
    );
  }
  if (value.tenantId !== tenantId || value.actorId !== actorId || journalText(value) !== raw)
    throw new Error('Retained request changed scope or exact content. Preserve it for review.');
  return value;
}
export function assertJournal(storage: Storage, v: DataFlowJournal) {
  const read = readJournal(storage, v.tenantId, v.actorId);
  if (!read || journalText(read) !== journalText(v))
    throw new Error('Another tab changed the original request. Reload before continuing.');
  return read;
}
export function writeJournal(
  storage: Storage,
  v: DataFlowJournal,
  previous: DataFlowJournal | null,
) {
  const current = readJournal(storage, v.tenantId, v.actorId);
  if ((current ? journalText(current) : null) !== (previous ? journalText(previous) : null))
    throw new Error('Another tab retained a different original request. Reload first.');
  if (previous && encodeDataFlowIntent(previous.intent) !== encodeDataFlowIntent(v.intent))
    throw new Error('The original operation cannot be replaced.');
  const text = journalText(v);
  storage.setItem(journalKey(v.tenantId, v.actorId), text);
  if (storage.getItem(journalKey(v.tenantId, v.actorId)) !== text)
    throw new Error('Browser storage could not retain this request. Nothing was sent.');
  return assertJournal(storage, v);
}
export async function intentHash(v: DataFlowJournal) {
  const data = new TextEncoder().encode(encodeDataFlowIntent(v.intent));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}
export async function validateOperation(v: DataFlowJournal, raw: unknown) {
  const parsed = dataFlowOperation
    .and(
      z.object({
        tenantId: z.uuid(),
        actorId: z.uuid(),
        phase: z.enum(['declare', 'approve', 'reject', 'withdraw']),
        operationKey: z.uuid(),
      }),
    )
    .safeParse(raw);
  if (!parsed.success)
    throw new Error('Original request has no matching recorded or fenced receipt. Preserve it.');
  const proof = parsed.data;
  if (
    proof.tenantId !== v.tenantId ||
    proof.actorId !== v.actorId ||
    proof.phase !== v.intent.phase ||
    proof.operationKey !== v.intent.request.operationKey ||
    proof.requestSha256 !== (await intentHash(v)) ||
    (proof.recorded &&
      proof.revisionId !==
        (v.intent.phase === 'declare'
          ? v.intent.request.operationKey
          : v.intent.request.revisionId))
  )
    throw new Error('Original request has no matching recorded or fenced receipt. Preserve it.');
  return proof;
}
export async function archiveConfirmed(storage: Storage, v: DataFlowJournal, raw: unknown) {
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
