import { canonicalJson, sha256 } from '@axiom/ledger';
import { z } from 'zod';
import { uploadMetadataSchema } from './evidence-contract';
import { evidenceUploadBytes } from './evidence-workflow';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const receipt = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine((value) => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n);
export const stagedRetentionConfiguration = z
  .object({
    provider: z.enum(['s3', 's3-compatible']),
    bucket: z.string().min(3).max(255),
    lockMode: z.literal('COMPLIANCE'),
    retentionPolicy: z.literal('seven_years'),
    encryption: z.enum(['AES256', 'aws:kms']),
    legalHold: z.boolean(),
  })
  .strict();
export const stagedApproval = stagedRetentionConfiguration.extend({
  acknowledgesImmutableRetention: z.literal(true),
});
export const stagedEvidenceJournal = z
  .object({
    version: z.literal(1),
    tenantId: z.uuid(),
    actorId: z.uuid(),
    operationKey: z.uuid(),
    metadata: uploadMetadataSchema.strict(),
    retentionApproval: stagedApproval,
    byteSize: z
      .number()
      .int()
      .min(1)
      .max(8 * 1024 * 1024),
    contentHash: digest,
    bodyHash: digest,
  })
  .strict();
export type StagedEvidenceJournal = z.infer<typeof stagedEvidenceJournal>;
export async function prepareStagedEvidenceJournal(
  tenantId: string,
  actorId: string,
  operationKey: string,
  metadataValue: unknown,
  approvalValue: unknown,
  file: File,
) {
  const metadata = uploadMetadataSchema.strict().parse(metadataValue);
  const retentionApproval = stagedApproval.parse(approvalValue);
  const upload = await evidenceUploadBytes(file);
  const { engagementId, ...values } = metadata;
  const body = {
    ...values,
    ...(engagementId === null ? {} : { engagementId }),
    operationKey,
    contentBase64: upload.contentBase64,
    retentionApproval,
  };
  return stagedEvidenceJournal.parse({
    version: 1,
    tenantId,
    actorId,
    operationKey,
    metadata,
    retentionApproval,
    byteSize: file.size,
    contentHash: upload.fingerprint,
    bodyHash: await sha256(canonicalJson(body)),
  });
}
const resultSchema = z
  .object({
    kind: z.literal('accepted_staged_evidence'),
    accepted: z.literal(true),
    runId: z.uuid(),
    evidenceId: z.uuid(),
    objectVersionId: z.uuid(),
    storageVersionId: z
      .string()
      .min(1)
      .max(1024)
      .refine((value) => Boolean(value.trim()) && value !== 'null'),
    operationKey: z.uuid(),
    contentHash: digest,
    sourceRequestHash: digest,
    stageOutputHash: digest,
    receipts: z
      .object({
        requested: receipt,
        started: receipt,
        completed: receipt,
        settled: receipt,
      })
      .strict(),
  })
  .strict();
export type AcceptedStagedResult = z.infer<typeof resultSchema>;
export class StagedEvidenceRequestError extends Error {}
export const STAGED_EVIDENCE_CHANGED = 'axiom-staged-evidence-changed';
export const stagedEvidenceJournalKey = (tenant: string, actor: string) =>
  `axiom:staged-evidence:v1:${tenant}:${actor}`;
export function readStagedEvidenceJournal(
  storage: Pick<Storage, 'getItem'>,
  tenant: string,
  actor: string,
) {
  const raw = storage.getItem(stagedEvidenceJournalKey(tenant, actor));
  if (raw === null) return null;
  if (raw.length > 16000)
    throw new StagedEvidenceRequestError(
      'The retained request is unreadable. Preserve it for review.',
    );
  const saved = stagedEvidenceJournal.parse(JSON.parse(raw));
  if (saved.tenantId !== tenant || saved.actorId !== actor)
    throw new StagedEvidenceRequestError('The retained request belongs to another session.');
  return saved;
}
export function retainStagedEvidenceJournal(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  raw: StagedEvidenceJournal,
) {
  const journal = stagedEvidenceJournal.parse(raw),
    old = readStagedEvidenceJournal(storage, journal.tenantId, journal.actorId);
  if (old && canonicalJson(old) !== canonicalJson(journal))
    throw new StagedEvidenceRequestError('Resolve the retained request before preparing another.');
  const text = JSON.stringify(journal),
    key = stagedEvidenceJournalKey(journal.tenantId, journal.actorId);
  storage.setItem(key, text);
  if (storage.getItem(key) !== text)
    throw new StagedEvidenceRequestError(
      'The request could not be retained. Nothing was submitted.',
    );
  window.dispatchEvent(new Event(STAGED_EVIDENCE_CHANGED));
  return journal;
}
const uncertain = () =>
  new StagedEvidenceRequestError(
    'Evidence acceptance is unconfirmed. Preserve the retained request and check its result.',
  );
function verifyContext(
  storage: Pick<Storage, 'getItem'>,
  journal: StagedEvidenceJournal,
  current: () => { tenantId: string; actorId: string },
) {
  const context = current();
  if (
    context.tenantId !== journal.tenantId ||
    context.actorId !== journal.actorId ||
    canonicalJson(readStagedEvidenceJournal(storage, journal.tenantId, journal.actorId)) !==
      canonicalJson(journal)
  )
    throw uncertain();
}
export async function retainedBody(journal: StagedEvidenceJournal, file: File) {
  if (file.size !== journal.byteSize || file.size > 8 * 1024 * 1024)
    throw new StagedEvidenceRequestError('Reselect the original file with identical bytes.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const contentHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  if (contentHash !== journal.contentHash)
    throw new StagedEvidenceRequestError('Reselect the original file with identical bytes.');
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32768)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  const { engagementId, ...metadata } = journal.metadata;
  const body = {
    ...metadata,
    ...(engagementId === null ? {} : { engagementId }),
    operationKey: journal.operationKey,
    contentBase64: btoa(binary),
    retentionApproval: journal.retentionApproval,
  };
  if ((await sha256(canonicalJson(body))) !== journal.bodyHash) throw uncertain();
  return body;
}
const verifiedResults = new WeakMap<object, string>();
export async function readAcceptedStagedResult(
  storage: Pick<Storage, 'getItem'>,
  journal: StagedEvidenceJournal,
  current: () => { tenantId: string; actorId: string },
  signal: AbortSignal,
) {
  verifyContext(storage, journal, current);
  try {
    const response = await fetch(
      `/api/bff/v1/evidence/staged-ingestions/${journal.operationKey}/result?bodyHash=${journal.bodyHash}`,
      {
        cache: 'no-store',
        signal,
        headers: { 'X-Tenant-Id': journal.tenantId, 'X-Expected-Actor-Id': journal.actorId },
      },
    );
    if (response.status !== 200) throw uncertain();
    const result = resultSchema.parse(await response.json());
    verifyContext(storage, journal, current);
    if (
      result.operationKey !== journal.operationKey ||
      result.contentHash !== journal.contentHash ||
      result.sourceRequestHash !== journal.bodyHash ||
      new Set(Object.values(result.receipts)).size !== 4
    )
      throw uncertain();
    verifiedResults.set(result, canonicalJson(journal));
    return result;
  } catch {
    throw uncertain();
  }
}
/** Called under a browser lock; verify exact durable journal before and after awaited byte hashing. */
export async function submitStagedEvidence(
  storage: Pick<Storage, 'getItem'>,
  journal: StagedEvidenceJournal,
  file: File,
  current: () => { tenantId: string; actorId: string },
  signal: AbortSignal,
) {
  verifyContext(storage, journal, current);
  const body = await retainedBody(journal, file);
  verifyContext(storage, journal, current);
  try {
    const response = await fetch('/api/bff/v1/evidence/staged-ingestions', {
      method: 'POST',
      cache: 'no-store',
      signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-Id': journal.tenantId,
        'X-Expected-Actor-Id': journal.actorId,
        'Idempotency-Key': journal.operationKey,
      },
      body: JSON.stringify(body),
    });
    if (response.status !== 200) throw uncertain();
    // Do not treat runtime JSON or an unaccepted observation as a confirmed evidence receipt.
    const result = resultSchema.parse(await response.json());
    verifyContext(storage, journal, current);
    if (
      result.operationKey !== journal.operationKey ||
      result.contentHash !== journal.contentHash ||
      result.sourceRequestHash !== journal.bodyHash ||
      new Set(Object.values(result.receipts)).size !== 4
    )
      throw uncertain();
    verifiedResults.set(result, canonicalJson(journal));
    return result;
  } catch {
    throw uncertain();
  }
}
/** Renew current server proof under the caller's lock before removing the original reference. */
export async function archiveAcceptedStagedRequest(
  storage: Pick<Storage, 'getItem' | 'removeItem'>,
  journal: StagedEvidenceJournal,
  result: AcceptedStagedResult,
  current: () => { tenantId: string; actorId: string },
  signal: AbortSignal,
) {
  verifyContext(storage, journal, current);
  if (verifiedResults.get(result) !== canonicalJson(journal)) throw uncertain();
  const fresh = await readAcceptedStagedResult(storage, journal, current, signal);
  if (canonicalJson(fresh) !== canonicalJson(result)) throw uncertain();
  verifyContext(storage, journal, current);
  storage.removeItem(stagedEvidenceJournalKey(journal.tenantId, journal.actorId));
  if (storage.getItem(stagedEvidenceJournalKey(journal.tenantId, journal.actorId)) !== null)
    throw uncertain();
  verifiedResults.delete(result);
  window.dispatchEvent(new Event(STAGED_EVIDENCE_CHANGED));
}
const statusSource = z
  .object({
    purpose: z.literal('saakshi_owned_resource_stage_v1'),
    tenant_id: z.uuid(),
    actor_id: z.uuid(),
    engagement_id: z.uuid().nullable(),
    operation_id: z.uuid(),
    operation_key: z.uuid(),
    owned_resource_id: z.uuid(),
    human_request_hash: digest,
    provider: z.enum(['s3', 's3-compatible']),
    bucket: z.string().min(3).max(255),
    object_key: z.string().min(1).max(1024),
    content_hash: digest,
    byte_size: z
      .number()
      .int()
      .min(1)
      .max(8 * 1024 * 1024),
    retain_until: z.string().datetime({ offset: true }),
    legal_hold: z.boolean(),
    encryption: z.enum(['AES256', 'aws:kms']),
  })
  .strict();
const unconfirmedStatusSchema = z
  .object({
    kind: z.literal('unconfirmed_staged_evidence'),
    accepted: z.literal(false),
    operationKey: z.uuid(),
    bodyHash: digest,
    runId: z.uuid(),
    source: statusSource,
    payloadExpiresAt: z
      .string()
      .refine((value) => Number.isFinite(Date.parse(value)))
      .nullable(),
    payloadPurged: z.boolean(),
    terminalReason: z.enum(['expired_unconfirmed', 'expired_runtime_failure']).nullable(),
    runtimeOutcome: z.enum(['unconfirmed', 'runtime_reported_failure']),
    providerObservation: z.enum(['not_attempted', 'outcome_unknown', 'observed_unaccepted']),
    observedVersion: z.string().min(1).nullable(),
    observedOutputHash: digest.nullable(),
    newApprovedKeyAllowed: z.boolean(),
    requestedReceipt: receipt,
  })
  .strict();
export type UnconfirmedStagedStatus = z.infer<typeof unconfirmedStatusSchema>;
const verifiedStatuses = new WeakMap<object, string>();
export async function readUnconfirmedStagedStatus(
  storage: Pick<Storage, 'getItem'>,
  journal: StagedEvidenceJournal,
  current: () => { tenantId: string; actorId: string },
  signal: AbortSignal,
  expire = false,
) {
  verifyContext(storage, journal, current);
  try {
    const response = await fetch(
      `/api/bff/v1/evidence/staged-ingestions/${journal.operationKey}/${expire ? 'expire' : 'status'}${expire ? '' : `?bodyHash=${journal.bodyHash}`}`,
      {
        method: expire ? 'POST' : 'GET',
        cache: 'no-store',
        signal,
        headers: {
          'X-Tenant-Id': journal.tenantId,
          'X-Expected-Actor-Id': journal.actorId,
          ...(expire
            ? { 'Content-Type': 'application/json', 'Idempotency-Key': journal.operationKey }
            : {}),
        },
        ...(expire
          ? {
              body: JSON.stringify({
                bodyHash: journal.bodyHash,
                acknowledgeUnconfirmedPreservation: true,
              }),
            }
          : {}),
      },
    );
    if (response.status !== 200) throw uncertain();
    const status = unconfirmedStatusSchema.parse(await response.json());
    verifyContext(storage, journal, current);
    const source = status.source;
    if (
      status.operationKey !== journal.operationKey ||
      status.bodyHash !== journal.bodyHash ||
      source.tenant_id !== journal.tenantId ||
      source.actor_id !== journal.actorId ||
      source.operation_key !== journal.operationKey ||
      source.human_request_hash !== journal.bodyHash ||
      source.content_hash !== journal.contentHash ||
      source.byte_size !== journal.byteSize ||
      source.engagement_id !== journal.metadata.engagementId ||
      source.object_key !==
        `tenants/${journal.tenantId}/evidence-ingestions/${journal.operationKey}/${journal.contentHash}` ||
      source.provider !== journal.retentionApproval.provider ||
      source.bucket !== journal.retentionApproval.bucket ||
      source.encryption !== journal.retentionApproval.encryption ||
      source.legal_hold !== journal.retentionApproval.legalHold ||
      status.newApprovedKeyAllowed !== Boolean(status.terminalReason) ||
      (status.terminalReason !== null &&
        (!status.payloadPurged || status.payloadExpiresAt !== null)) ||
      (status.terminalReason === 'expired_runtime_failure' &&
        status.runtimeOutcome !== 'runtime_reported_failure') ||
      (status.terminalReason === 'expired_unconfirmed' &&
        status.runtimeOutcome !== 'unconfirmed') ||
      Boolean(status.observedVersion) !== Boolean(status.observedOutputHash) ||
      (status.providerObservation === 'observed_unaccepted') !== Boolean(status.observedVersion)
    )
      throw uncertain();
    verifiedStatuses.set(status, canonicalJson(journal));
    return status;
  } catch {
    throw uncertain();
  }
}
/** Archive only an expired terminal reference, preserving target/version/history and renewing current proof. */
export async function archiveExpiredStagedRequest(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
  journal: StagedEvidenceJournal,
  status: UnconfirmedStagedStatus,
  current: () => { tenantId: string; actorId: string },
  signal: AbortSignal,
) {
  verifyContext(storage, journal, current);
  if (
    verifiedStatuses.get(status) !== canonicalJson(journal) ||
    !status.newApprovedKeyAllowed ||
    !status.terminalReason
  )
    throw uncertain();
  const fresh = await readUnconfirmedStagedStatus(storage, journal, current, signal);
  if (canonicalJson(fresh) !== canonicalJson(status)) throw uncertain();
  const key = `axiom:staged-evidence:expired:v1:${journal.tenantId}:${journal.actorId}:${journal.operationKey}`;
  const reference = JSON.stringify({ journal, status: fresh }),
    old = storage.getItem(key);
  if (reference.length > 24000 || (old !== null && old !== reference)) throw uncertain();
  storage.setItem(key, reference);
  if (storage.getItem(key) !== reference) throw uncertain();
  verifyContext(storage, journal, current);
  storage.removeItem(stagedEvidenceJournalKey(journal.tenantId, journal.actorId));
  if (storage.getItem(stagedEvidenceJournalKey(journal.tenantId, journal.actorId)) !== null)
    throw uncertain();
  verifiedStatuses.delete(status);
  window.dispatchEvent(new Event(STAGED_EVIDENCE_CHANGED));
}
