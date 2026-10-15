import { z } from 'zod';

export const intakeJournalSchema = z
  .object({
    tenantId: z.uuid(),
    actorId: z.uuid(),
    libraryVersion: z.string().min(1).max(200),
    requestKey: z.uuid(),
    title: z.string().min(3).max(200),
    estateId: z.union([z.uuid(), z.literal('')]),
  })
  .strict();
export type IntakeIntent = z.infer<typeof intakeJournalSchema>;
export const intakeJournalKey = (actorId: string) =>
  `axiom:engagement-intake:v1:${z.uuid().parse(actorId)}:`;
const equal = (a: IntakeIntent, b: IntakeIntent) => JSON.stringify(a) === JSON.stringify(b);
function entries(storage: Storage, actorId: string): IntakeIntent[] {
  const prefix = intakeJournalKey(actorId);
  const result: IntakeIntent[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key?.startsWith(prefix)) continue;
    const raw = storage.getItem(key);
    if (!raw || raw.length > 4096)
      throw new Error('The retained intake request cannot be verified.');
    const parsed = intakeJournalSchema.parse(JSON.parse(raw));
    if (parsed.actorId !== actorId || key !== prefix + parsed.tenantId + ':' + parsed.requestKey)
      throw new Error('The retained request belongs to another context.');
    result.push(parsed);
    if (result.length > 100)
      throw new Error(
        'Too many unresolved intake requests. Resolve the retained requests before continuing.',
      );
  }
  return result.sort((a, b) => a.requestKey.localeCompare(b.requestKey));
}
export function readIntakeJournal(storage: Storage, actorId: string): IntakeIntent | null {
  return entries(storage, actorId)[0] ?? null;
}
export function retainIntakeJournal(storage: Storage, value: IntakeIntent): void {
  const parsed = intakeJournalSchema.parse(value);
  const existing = entries(storage, parsed.actorId);
  const own = existing.find(
    (item) => item.tenantId === parsed.tenantId && item.requestKey === parsed.requestKey,
  );
  if ((own && !equal(own, parsed)) || (!own && existing.length))
    throw new Error(
      'Resolve the retained intake request before creating another assessment. Nothing was sent.',
    );
  const key = intakeJournalKey(parsed.actorId) + parsed.tenantId + ':' + parsed.requestKey;
  const text = JSON.stringify(parsed);
  // Immutable per-operation entries never overwrite a different tab's key.
  // Readback/rescan detects observed races; this is not atomic cross-tab exclusion.
  storage.setItem(key, text);
  if (storage.getItem(key) !== text)
    throw new Error('The intake request could not be retained. Nothing was sent.');
  const after = entries(storage, parsed.actorId);
  if (!own && after.some((item) => !equal(item, parsed)))
    throw new Error(
      'Another intake was retained. Resolve the retained requests before continuing. Nothing was sent.',
    );
}
export function clearIntakeJournal(storage: Storage, value: IntakeIntent): void {
  const parsed = intakeJournalSchema.parse(value);
  const key = intakeJournalKey(parsed.actorId) + parsed.tenantId + ':' + parsed.requestKey;
  const raw = storage.getItem(key);
  if (raw === null) return; // Another tab may already have confirmed this exact operation.
  if (!equal(intakeJournalSchema.parse(JSON.parse(raw)), parsed))
    throw new Error('The retained intake changed. Refresh its recorded state before continuing.');
  storage.removeItem(key);
  if (storage.getItem(key) !== null) throw new Error('The retained intake could not be cleared.');
}
