import { z } from 'zod';
import {
  workflowRequestSchema,
  workflowRecordSchema,
  type WorkflowRequest,
  type WorkflowRecord,
} from '@axiom/types';

export class WorkflowError extends Error {}
export const JOURNAL_CHANGED = 'axiom:operator-workflow-journal-changed';
export const JOURNAL_SAVED = 'axiom:operator-workflow-journal-saved';
function notifyJournal() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(JOURNAL_CHANGED));
}
export const journalSchema = z
  .object({
    tenantId: z.uuid(),
    actorId: z.uuid(),
    request: workflowRequestSchema,
  })
  .strict();
export type Journal = z.infer<typeof journalSchema>;
export function notifySavedJournal(journal: Journal) {
  const detail = journalSchema.parse(journal);
  if (typeof window !== 'undefined')
    window.dispatchEvent(new CustomEvent(JOURNAL_SAVED, { detail }));
}
export function journalKey(tenant: string, actor: string) {
  return `axiom.operator-workflow.v1:${tenant}:${actor}`;
}
export function readJournal(storage: Storage, tenant: string, actor: string): Journal | null {
  const text = storage.getItem(journalKey(tenant, actor));
  if (text === null) return null;
  const value = journalSchema.parse(JSON.parse(text));
  if (value.tenantId !== tenant || value.actorId !== actor)
    throw new WorkflowError('Retained request belongs to another account or organisation.');
  return value;
}
export function retainJournal(storage: Storage, journal: Journal) {
  const value = journalSchema.parse(journal);
  const old = readJournal(storage, value.tenantId, value.actorId);
  if (old && JSON.stringify(old) !== JSON.stringify(value))
    throw new WorkflowError('Resolve the retained request before recording another.');
  const text = JSON.stringify(value);
  storage.setItem(journalKey(value.tenantId, value.actorId), text);
  if (storage.getItem(journalKey(value.tenantId, value.actorId)) !== text)
    throw new WorkflowError('Request could not be retained. Nothing was submitted.');
  notifyJournal();
}
export function clearJournal(storage: Storage, journal: Journal) {
  const old = readJournal(storage, journal.tenantId, journal.actorId);
  if (old?.request.operationKey !== journal.request.operationKey)
    throw new WorkflowError('Retained request changed. Reload before continuing.');
  storage.removeItem(journalKey(journal.tenantId, journal.actorId));
  notifyJournal();
}
export async function workflowFetch(
  tenant: string,
  path: string,
  request?: WorkflowRequest,
  expectedActor?: string,
) {
  if (request && !z.uuid().safeParse(expectedActor).success)
    throw new WorkflowError(
      'The signed-in account must match the retained request. Reload before submitting.',
    );
  if (!path.startsWith('/operator-workflows/') || path.includes('..'))
    throw new WorkflowError('Invalid workflow path.');
  let response: Response;
  try {
    response = await fetch(`/api/bff/v1${path}`, {
      method: request ? 'POST' : 'GET',
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
      headers: {
        'X-Tenant-Id': tenant,
        ...(request
          ? {
              'Content-Type': 'application/json',
              'Idempotency-Key': request.operationKey,
              'X-Expected-Actor-Id': expectedActor!,
            }
          : {}),
      },
      ...(request ? { body: JSON.stringify(workflowRequestSchema.parse(request)) } : {}),
    });
  } catch {
    throw new WorkflowError(
      'The response was interrupted. Check the retained request before retrying.',
    );
  }
  if (!response.ok) {
    const value: unknown = await response.json().catch(() => null);
    const code = z.object({ error: z.object({ code: z.string() }) }).safeParse(value);
    throw new WorkflowError(
      code.success
        ? `The request was refused (${code.data.error.code}). Check its outcome before continuing.`
        : 'Recorded state is unavailable. Check the retained request before retrying.',
    );
  }
  return response.json() as Promise<unknown>;
}
export function validateRecorded(
  value: unknown,
  tenant: string,
  request?: WorkflowRequest,
  actor?: string,
): WorkflowRecord {
  const row = workflowRecordSchema.parse(value);
  if (
    row.tenant_id !== tenant ||
    (request &&
      (row.kind !== request.kind ||
        row.operation_key !== request.operationKey ||
        JSON.stringify(row.payload) !== JSON.stringify(request.payload))) ||
    (actor && row.created_by !== actor)
  )
    throw new WorkflowError('Recorded result does not match this request. Check its outcome.');
  return row;
}
