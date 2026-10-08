/** Unwired controller port. A SQL-backed claim and immutable resource reader are mandatory. */
import { createHash } from 'node:crypto';
import type { EvidenceVault, EvidenceReadOptions } from '@axiom/evidence';
import { z } from 'zod';

const uuid = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.string().datetime({ offset: true });
export const retainedStageSource = z
  .object({
    purpose: z.literal('saakshi_owned_resource_stage_v1'),
    tenant_id: uuid,
    actor_id: uuid,
    engagement_id: uuid.nullable(),
    operation_id: uuid,
    operation_key: uuid,
    owned_resource_id: uuid,
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
    retain_until: instant,
    legal_hold: z.boolean(),
    encryption: z.enum(['AES256', 'aws:kms']),
  })
  .strict()
  .refine(
    (s) =>
      s.object_key ===
      `tenants/${s.tenant_id}/evidence-ingestions/${s.operation_key}/${s.content_hash}`,
  );
export const stageBindingSchema = z
  .object({
    source: retainedStageSource,
    runId: uuid,
    correlationId: uuid,
    requestedReceipt: z.string().regex(/^[1-9][0-9]{0,19}$/),
  })
  .strict();
export type StageBinding = z.infer<typeof stageBindingSchema>;
export interface RetainedHumanResource {
  /** Exact immutable human receipt/run/intent projection, read by a trusted server port. */
  binding: StageBinding;
  contentType: string;
  byteSize: number;
  open(signal: AbortSignal): AsyncIterable<Uint8Array>;
}
export interface RetainedResourceReader {
  read(binding: StageBinding, signal: AbortSignal): Promise<RetainedHumanResource>;
}
export interface StageClaim {
  /** Must atomically recheck authority/source and consume ONE upload lease in SQL.
   * A recorded consumed lease can only authorize readback, never another PUT.
   */
  consume(binding: StageBinding, signal: AbortSignal): Promise<'upload_once' | 'recover_only'>;
}
export type ScopedEvidenceVault = Pick<
  EvidenceVault,
  'seal' | 'verifyReceipt' | 'retrieve' | 'findEvidenceVersion'
>;
export class StageUnconfirmed extends Error {
  constructor() {
    super('Evidence staging is unconfirmed');
  }
}
function same(a: StageBinding, b: StageBinding) {
  return (
    JSON.stringify(stageBindingSchema.parse(a)) === JSON.stringify(stageBindingSchema.parse(b))
  );
}
async function interrupt<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void pending.catch(() => undefined);
    throw new StageUnconfirmed();
  }
  return new Promise((resolve, reject) => {
    const abort = () => reject(new StageUnconfirmed());
    signal.addEventListener('abort', abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
export async function resolveRetainedHumanBytes(
  input: StageBinding,
  reader: RetainedResourceReader,
  signal: AbortSignal,
): Promise<{ body: Buffer; contentType: string }> {
  const binding = stageBindingSchema.parse(input);
  const resource = await interrupt(reader.read(binding, signal), signal);
  if (
    !same(resource.binding, binding) ||
    resource.byteSize !== binding.source.byte_size ||
    !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(resource.contentType) ||
    resource.contentType.length > 120
  )
    throw new StageUnconfirmed();
  const chunks: Buffer[] = [];
  let size = 0;
  const iterator = resource.open(signal)[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = await interrupt(iterator.next(), signal);
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) throw new StageUnconfirmed();
      size += next.value.byteLength;
      if (size > resource.byteSize) throw new StageUnconfirmed();
      chunks.push(Buffer.from(next.value));
    }
  } finally {
    // Never let a hung producer's cleanup extend the total operation deadline.
    void iterator.return?.().catch(() => undefined);
  }
  const body = Buffer.concat(chunks, size);
  if (
    size !== resource.byteSize ||
    createHash('sha256').update(body).digest('hex') !== binding.source.content_hash
  )
    throw new StageUnconfirmed();
  return { body, contentType: resource.contentType };
}

export function createConfiguredStagePort(config: {
  provider: 's3' | 's3-compatible';
  bucket: string;
  vault: ScopedEvidenceVault;
  resources: RetainedResourceReader;
  claim: StageClaim;
  timeoutMs?: number;
}) {
  const timeout = config.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000 || !config.bucket)
    throw new StageUnconfirmed();
  return async (input: StageBinding) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const deadline = Date.now() + timeout;
    try {
      const binding = stageBindingSchema.parse(input);
      const s = binding.source;
      if (
        s.provider !== config.provider ||
        s.bucket !== config.bucket ||
        Date.parse(s.retain_until) <= Date.now()
      )
        throw new StageUnconfirmed();
      const retained = await resolveRetainedHumanBytes(
        binding,
        config.resources,
        controller.signal,
      );
      const mode = await interrupt(
        config.claim.consume(binding, controller.signal),
        controller.signal,
      );
      if (mode !== 'upload_once' && mode !== 'recover_only') throw new StageUnconfirmed();
      const options = (): EvidenceReadOptions => ({
        maxBytes: s.byte_size,
        timeoutMs: Math.max(1, deadline - Date.now()),
        signal: controller.signal,
      });
      const expected = {
        tenantId: s.tenant_id,
        engagementId: s.engagement_id,
        operationId: s.operation_id,
        contentHash: s.content_hash,
        byteSize: s.byte_size,
        collectedByAgent: 'saakshi',
      };
      const metadata = {
        'saakshi-original-actor': s.actor_id,
        'saakshi-run': binding.runId,
        'saakshi-human-request-hash': s.human_request_hash,
        'saakshi-owned-resource': s.owned_resource_id,
        'saakshi-requested-receipt': binding.requestedReceipt,
        'saakshi-correlation': binding.correlationId,
      };
      const find = () =>
        interrupt(
          config.vault.findEvidenceVersion(s.bucket, s.object_key, expected, options()),
          controller.signal,
        );
      let candidate = await find();
      if (!candidate && mode === 'upload_once') {
        try {
          const sealed = await interrupt(
            config.vault.seal(
              {
                bucket: s.bucket,
                key: s.object_key,
                body: retained.body,
                contentType: retained.contentType,
                retentionDays: 2555,
                retainUntil: s.retain_until,
                legalHold: s.legal_hold,
                encryption: s.encryption,
                tenantId: s.tenant_id,
                engagementId: s.engagement_id,
                operationId: s.operation_id,
                collectedByAgent: 'saakshi',
                createOnly: true,
                metadata,
              },
              options(),
            ),
            controller.signal,
          );
          candidate = { versionId: sealed.versionId };
        } catch {
          // PUT may have committed. Only read the exact original version; never PUT again.
          candidate = await find();
        }
      }
      if (!candidate) throw new StageUnconfirmed();
      const receipt = await interrupt(
        config.vault.verifyReceipt(
          {
            ...expected,
            bucket: s.bucket,
            key: s.object_key,
            versionId: candidate.versionId,
            retainUntil: s.retain_until,
            legalHold: s.legal_hold,
            encryption: s.encryption,
          },
          options(),
        ),
        controller.signal,
      );
      const object = await interrupt(
        config.vault.retrieve(s.bucket, s.object_key, candidate.versionId, options()),
        controller.signal,
      );
      if (
        receipt.versionId !== candidate.versionId ||
        !receipt.versionId.trim() ||
        receipt.versionId === 'null' ||
        receipt.retentionAssurance !== 'verified' ||
        receipt.lockMode !== 'COMPLIANCE' ||
        receipt.bucket !== s.bucket ||
        receipt.key !== s.object_key ||
        receipt.contentHash !== s.content_hash ||
        receipt.byteSize !== s.byte_size ||
        receipt.encryption !== s.encryption ||
        receipt.legalHold !== s.legal_hold ||
        !Number.isFinite(Date.parse(receipt.retainUntil)) ||
        Date.parse(receipt.retainUntil) < Date.parse(s.retain_until) ||
        !Number.isFinite(Date.parse(receipt.readbackAt)) ||
        Math.abs(Date.parse(receipt.readbackAt) - Date.now()) > 300_000 ||
        object.versionId !== candidate.versionId ||
        object.body.length !== s.byte_size ||
        createHash('sha256').update(object.body).digest('hex') !== s.content_hash ||
        Object.entries(metadata).some(([key, value]) => object.metadata[key] !== value)
      )
        throw new StageUnconfirmed();
      controller.signal.throwIfAborted();
      return {
        tenant_id: s.tenant_id,
        engagement_id: s.engagement_id,
        operation_id: s.operation_id,
        provider: s.provider,
        bucket: s.bucket,
        object_key: s.object_key,
        content_hash: s.content_hash,
        byte_size: s.byte_size,
        legal_hold: s.legal_hold,
        encryption: s.encryption,
        correlation_id: binding.correlationId,
        version_id: candidate.versionId,
        collected_by_agent: 'saakshi' as const,
        readback_at: receipt.readbackAt,
        lock_mode: 'COMPLIANCE' as const,
        verified: true as const,
        retain_until: receipt.retainUntil,
      };
    } catch {
      throw new StageUnconfirmed();
    } finally {
      clearTimeout(timer);
    }
  };
}
