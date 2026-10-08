import { z } from 'zod';
import {
  reviewedWorkflowInputSchema,
  reviewedWorkflowRequestSchema,
  reviewedWorkflowOutputSchema,
  reviewedWorkflowAcknowledgementSchema,
  reviewedWorkflowAcknowledgementProofSchema,
  validateReviewedWorkflowOutput,
} from '@axiom/types';

export class DraftRequestError extends Error {}
export const DRAFT_CHANGED = 'axiom-reviewed-workflow-journal-changed';
export function draftKey(tenantId: string, actorId: string) {
  return `axiom:reviewed-workflows:v1:${tenantId}:${actorId}`;
}
export const draftJournalSchema = z
  .object({
    version: z.literal(1),
    tenantId: z.uuid(),
    actorId: z.uuid(),
    input: reviewedWorkflowInputSchema,
    request: reviewedWorkflowRequestSchema,
    acknowledgement: z
      .object({ operationKey: z.uuid(), body: reviewedWorkflowAcknowledgementSchema })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((v, c) => {
    if (
      v.tenantId !== v.input.tenant_id ||
      v.request.engagementId !== v.input.engagement_id ||
      v.request.sourceDigest !== v.input.source_records_sha256 ||
      v.request.recordIds.length !== v.input.records.length ||
      v.request.recordIds.some((id, index) => id !== v.input.records[index]?.id)
    )
      c.addIssue({ code: 'custom', message: 'Retained declaration source mismatch' });
  });
export type DraftJournal = z.infer<typeof draftJournalSchema>;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const fields = value as Record<string, unknown>;
    return `{${Object.keys(fields)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(fields[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
async function hash(value: unknown) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
  return Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, '0')).join('');
}
function notify() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(DRAFT_CHANGED));
}
export function readDraftJournal(
  storage: Pick<Storage, 'getItem'>,
  tenantId: string,
  actorId: string,
) {
  const raw = storage.getItem(draftKey(tenantId, actorId));
  if (raw === null) return null;
  if (new TextEncoder().encode(raw).byteLength > 600000)
    throw new DraftRequestError('The retained request is unreadable. Preserve it for review.');
  const parsed: unknown = JSON.parse(raw),
    v = draftJournalSchema.parse(parsed);
  if (v.tenantId !== tenantId || v.actorId !== actorId || canonical(parsed) !== canonical(v))
    throw new DraftRequestError('The retained request does not match this account and source.');
  return v;
}
export function retainDraftJournal(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  journal: DraftJournal,
) {
  const value = draftJournalSchema.parse(journal),
    old = readDraftJournal(storage, value.tenantId, value.actorId);
  if (old && canonical(old) !== canonical(value))
    throw new DraftRequestError('Resolve the retained request before creating another.');
  const raw = JSON.stringify(value);
  if (new TextEncoder().encode(raw).byteLength > 600000)
    throw new DraftRequestError('The source exceeds the browser request bound.');
  storage.setItem(draftKey(value.tenantId, value.actorId), raw);
  if (storage.getItem(draftKey(value.tenantId, value.actorId)) !== raw)
    throw new DraftRequestError('The request could not be retained. Nothing was submitted.');
  notify();
}
export function retainDraftAcknowledgement(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  journal: DraftJournal,
  acknowledgement: NonNullable<DraftJournal['acknowledgement']>,
) {
  const live = readDraftJournal(storage, journal.tenantId, journal.actorId);
  if (!live || canonical(live) !== canonical(journal))
    throw new DraftRequestError('The retained request changed. No acknowledgement was submitted.');
  if (live.acknowledgement && canonical(live.acknowledgement) !== canonical(acknowledgement))
    throw new DraftRequestError('Check the retained acknowledgement before requesting another.');
  const value = draftJournalSchema.parse({ ...live, acknowledgement });
  const text = JSON.stringify(value);
  if (new TextEncoder().encode(text).byteLength > 600000)
    throw new DraftRequestError(
      'The acknowledgement exceeds the browser request bound. Nothing was submitted.',
    );
  storage.setItem(draftKey(value.tenantId, value.actorId), text);
  if (storage.getItem(draftKey(value.tenantId, value.actorId)) !== text)
    throw new DraftRequestError(
      'The acknowledgement could not be retained. Nothing was submitted.',
    );
  notify();
  return value;
}
async function readResponse(response: Response) {
  const body: unknown = await response.json();
  if (!response.ok) {
    const code = z
      .object({ error: z.object({ code: z.string().regex(/^[a-z0-9_]{1,100}$/) }) })
      .safeParse(body);
    throw new DraftRequestError(
      code.success
        ? `The outcome is unconfirmed (${code.data.error.code}). Keep the retained request.`
        : 'The outcome is unconfirmed. Keep the retained request.',
    );
  }
  return body;
}
function headers(journal: Pick<DraftJournal, 'tenantId' | 'actorId'>, key?: string) {
  return {
    'X-Tenant-Id': journal.tenantId,
    'X-Expected-Actor-Id': journal.actorId,
    ...(key ? { 'Content-Type': 'application/json', 'Idempotency-Key': key } : {}),
  };
}
function selection(journal: DraftJournal) {
  return new URLSearchParams({
    engagementId: journal.request.engagementId,
    recordIds: journal.request.recordIds.join(','),
    sourceDigest: journal.request.sourceDigest,
  });
}
export async function readDraftSource(
  tenantId: string,
  actorId: string,
  engagementId: string,
  recordIds: string[],
) {
  const response = await fetch(
    '/api/bff/v1/reviewed-workflows/source?' +
      new URLSearchParams({ engagementId, recordIds: recordIds.join(',') }),
    {
      cache: 'no-store',
      signal: AbortSignal.timeout(20000),
      headers: headers({ tenantId, actorId }),
    },
  );
  const responseBody = await readResponse(response),
    raw = z.object({ input: reviewedWorkflowInputSchema }).strict().parse(responseBody);
  const input = raw.input;
  if (canonical(responseBody) !== canonical(raw))
    throw new DraftRequestError('The human source response changed during validation.');
  if (
    input.tenant_id !== tenantId ||
    input.engagement_id !== engagementId ||
    input.records.length !== recordIds.length ||
    input.records.some((r, index) => r.id !== recordIds[index]) ||
    (await hash(input.records)) !== input.source_records_sha256
  )
    throw new DraftRequestError('The retained human source could not be verified.');
  return input;
}
const receipt = z
    .string()
    .regex(/^[1-9][0-9]{0,18}$/)
    .refine((v) => BigInt(v) <= 9223372036854775807n),
  digest = z.string().regex(/^[a-f0-9]{64}$/);
const confirmedSchema = z
  .object({
    data: reviewedWorkflowOutputSchema,
    invocation: z
      .object({
        runId: z.uuid(),
        correlationId: z.uuid(),
        requestHash: digest,
        responseHash: digest,
      })
      .strict(),
    outputProof: z
      .object({
        kind: z.literal('settled_output_recorded'),
        tenantId: z.uuid(),
        actorId: z.uuid(),
        operationKey: z.uuid(),
        runId: z.uuid(),
        requestHash: digest,
        responseHash: digest,
        requestedReceipt: receipt,
        startedReceipt: receipt,
        completedReceipt: receipt,
        settledReceipt: receipt,
      })
      .strict(),
  })
  .strict();
export type ConfirmedDraft = z.infer<typeof confirmedSchema>;
const confirmedOutputs = new WeakMap<object, string>();
export function draftMatchesJournal(confirmed: ConfirmedDraft, journal: DraftJournal) {
  return confirmedOutputs.get(confirmed) === canonical({ journal, value: confirmed });
}
async function validateConfirmed(raw: unknown, journal: DraftJournal) {
  const value = confirmedSchema.parse(raw),
    p = value.outputProof,
    i = value.invocation;
  validateReviewedWorkflowOutput(journal.input, value.data);
  if (
    (await hash(journal.input.records)) !== journal.input.source_records_sha256 ||
    p.tenantId !== journal.tenantId ||
    p.actorId !== journal.actorId ||
    p.operationKey !== journal.request.operationKey ||
    i.correlationId !== journal.request.operationKey ||
    p.runId !== i.runId ||
    p.requestHash !== i.requestHash ||
    p.responseHash !== i.responseHash ||
    p.requestHash !== (await hash(journal.input)) ||
    p.responseHash !== (await hash(value.data)) ||
    !(
      BigInt(p.requestedReceipt) < BigInt(p.startedReceipt) &&
      BigInt(p.startedReceipt) < BigInt(p.completedReceipt) &&
      BigInt(p.completedReceipt) < BigInt(p.settledReceipt)
    )
  )
    throw new DraftRequestError('The saved draft proof does not match the retained request.');
  confirmedOutputs.set(value, canonical({ journal, value }));
  return value;
}
export async function submitDraft(journal: DraftJournal) {
  const value = draftJournalSchema.parse(journal);
  if ((await hash(value.input.records)) !== value.input.source_records_sha256)
    throw new DraftRequestError('The retained source checksum changed. Nothing was submitted.');
  const response = await fetch('/api/bff/v1/reviewed-workflows/runs', {
    method: 'POST',
    cache: 'no-store',
    signal: AbortSignal.timeout(130000),
    headers: headers(value, value.request.operationKey),
    body: JSON.stringify(value.request),
  });
  return validateConfirmed(await readResponse(response), value);
}
export async function recoverDraft(journal: DraftJournal) {
  const value = draftJournalSchema.parse(journal),
    response = await fetch(
      `/api/bff/v1/reviewed-workflows/runs/${value.request.operationKey}?${selection(value)}`,
      { cache: 'no-store', signal: AbortSignal.timeout(20000), headers: headers(value) },
    );
  return validateConfirmed(await readResponse(response), value);
}
const ackSchema = z
  .object({
    data: z
      .object({
        acknowledgement_id: z.uuid(),
        receipt_id: receipt,
        policy_draft_id: z.uuid().nullable(),
        replayed: z.boolean(),
        manifest: reviewedWorkflowAcknowledgementProofSchema,
      })
      .strict(),
  })
  .strict();
export type ConfirmedAcknowledgement = z.infer<typeof ackSchema>;
const confirmedAcks = new WeakMap<object, string>();
export function acknowledgementMatchesJournal(
  confirmed: ConfirmedAcknowledgement,
  journal: DraftJournal,
) {
  return confirmedAcks.get(confirmed) === canonical({ journal, confirmed });
}
export async function resolveDraftAcknowledgement(journal: DraftJournal, readOnly: boolean) {
  const value = draftJournalSchema.parse(journal),
    ack = value.acknowledgement;
  if (!ack) throw new DraftRequestError('No acknowledgement request is retained.');
  const response = await fetch('/api/bff/v1/reviewed-workflows/acknowledgements', {
    method: 'POST',
    cache: 'no-store',
    signal: AbortSignal.timeout(20000),
    headers: headers(value, ack.operationKey),
    body: JSON.stringify({
      engagementId: value.request.engagementId,
      recordIds: value.request.recordIds,
      sourceDigest: value.request.sourceDigest,
      originalOperationKey: value.request.operationKey,
      operationKey: ack.operationKey,
      acknowledgement: ack.body,
      ...(readOnly ? { readOnly: true } : {}),
    }),
  });
  const confirmed = ackSchema.parse(await readResponse(response)),
    p = confirmed.data.manifest;
  if (
    p.tenantId !== value.tenantId ||
    p.actorId !== value.actorId ||
    p.operationKey !== ack.operationKey ||
    p.originalOperationKey !== value.request.operationKey ||
    p.runId !== ack.body.runId ||
    p.inputHash !== (await hash(value.input)) ||
    p.outputHash !== ack.body.outputHash ||
    p.sourceDigest !== value.input.source_records_sha256 ||
    p.bodyHash !== (await hash(ack.body)) ||
    p.policyIndex !== ack.body.policyIndex ||
    p.policyDraftId !== confirmed.data.policy_draft_id ||
    p.receiptId !== confirmed.data.receipt_id ||
    p.acknowledgementId !== confirmed.data.acknowledgement_id
  )
    throw new DraftRequestError('The acknowledgement proof does not match the retained request.');
  confirmedAcks.set(confirmed, canonical({ journal: value, confirmed }));
  return confirmed;
}
export function archiveDraftReference(
  storage: Pick<Storage, 'getItem' | 'removeItem'>,
  journal: DraftJournal,
  confirmed: ConfirmedDraft,
  ack?: ConfirmedAcknowledgement,
) {
  if (
    confirmedOutputs.get(confirmed) !== canonical({ journal, value: confirmed }) ||
    canonical(readDraftJournal(storage, journal.tenantId, journal.actorId)) !==
      canonical(journal) ||
    (journal.acknowledgement &&
      (!ack || confirmedAcks.get(ack) !== canonical({ journal, confirmed: ack }))) ||
    (ack &&
      ['requestedReceipt', 'startedReceipt', 'completedReceipt', 'settledReceipt'].some(
        (field) =>
          ack.data.manifest[field as 'requestedReceipt'] !==
          confirmed.outputProof[field as 'requestedReceipt'],
      ))
  )
    throw new DraftRequestError(
      'Matching saved output and acknowledgement have not been confirmed. Nothing was archived.',
    );
  storage.removeItem(draftKey(journal.tenantId, journal.actorId));
  if (storage.getItem(draftKey(journal.tenantId, journal.actorId)) !== null)
    throw new DraftRequestError('The browser reference could not be archived.');
  notify();
}
