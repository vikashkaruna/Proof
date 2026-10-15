import { z } from 'zod';

const uuid = z.uuid();
const schema = z
  .object({
    tenantId: uuid,
    actorId: uuid,
    contextId: z.string().min(1).max(512),
    key: uuid,
    url: z
      .string()
      .max(2048)
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          ['http:', 'https:'].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash
        );
      }),
    body: z.string().max(4096),
  })
  .strict()
  .refine((value) => value.body === JSON.stringify({ url: value.url }));
export type ContextualCaptureJournal = z.infer<typeof schema>;
export function contextualCaptureStorageKey(tenantId: string, actorId: string) {
  return `axiom:public-recapture:v1:${uuid.parse(tenantId)}:${uuid.parse(actorId)}`;
}
function entries(storage: Storage, tenantId: string, actorId: string) {
  const prefix = contextualCaptureStorageKey(tenantId, actorId) + ':';
  const records: ContextualCaptureJournal[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key?.startsWith(prefix)) continue;
    const raw = storage.getItem(key);
    if (!raw || raw.length > 8192) throw new Error('capture_journal_refused');
    const parsed = schema.safeParse(JSON.parse(raw));
    if (
      !parsed.success ||
      parsed.data.tenantId !== tenantId ||
      parsed.data.actorId !== actorId ||
      key !== prefix + parsed.data.key
    )
      throw new Error('capture_journal_refused');
    records.push(parsed.data);
  }
  return records.sort((a, b) => a.key.localeCompare(b.key));
}
export function loadContextualCapture(
  storage: Storage,
  tenantId: string,
  actorId: string,
): ContextualCaptureJournal | null {
  return entries(storage, tenantId, actorId)[0] ?? null;
}
export function retainContextualCapture(storage: Storage, value: ContextualCaptureJournal) {
  const record = schema.parse(value);
  const existing = entries(storage, record.tenantId, record.actorId);
  if (existing.some((item) => JSON.stringify(item) !== JSON.stringify(record)))
    throw new Error('capture_journal_conflict');
  // Separate operation entries prevent concurrent tabs from overwriting an
  // uncertain key. This is not a claim of cross-tab atomic exclusion.
  const key = contextualCaptureStorageKey(record.tenantId, record.actorId) + ':' + record.key;
  const text = JSON.stringify(record);
  storage.setItem(key, text);
  if (storage.getItem(key) !== text) throw new Error('capture_journal_unconfirmed');
}
export function clearContextualCapture(
  storage: Storage,
  value: ContextualCaptureJournal,
  allowMissing = false,
) {
  const record = schema.parse(value);
  const key = contextualCaptureStorageKey(record.tenantId, record.actorId) + ':' + record.key;
  const raw = storage.getItem(key);
  if (raw === null && allowMissing) return;
  if (!raw || JSON.stringify(schema.parse(JSON.parse(raw))) !== JSON.stringify(record))
    throw new Error('capture_journal_conflict');
  storage.removeItem(key);
}
