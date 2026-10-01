import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { EvidenceVault } from '@axiom/evidence';
import { createSupabaseAdmin } from '@axiom/supabase';
import { loadEnv } from '@axiom/config';
import { EvidenceType } from '@axiom/types';

export const EVIDENCE_MAX_BYTES = 8 * 1024 * 1024;
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.string().refine((value) => Number.isFinite(Date.parse(value)));
export const uuidSchema = z
  .string()
  .regex(
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
    'Invalid UUID',
  );

export const evidenceUploadSchema = z
  .object({
    operationKey: uuidSchema,
    filename: z
      .string()
      .min(1)
      .max(160)
      .regex(/^[^\x00-\x1f\x7f/\\]+$/),
    contentType: z
      .string()
      .max(120)
      .regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/),
    evidenceType: z.enum(EvidenceType),
    description: z.string().trim().min(1).max(2000),
    controlIds: z.array(z.string().min(1).max(80)).max(40),
    engagementId: uuidSchema.nullable().optional(),
    contentBase64: z
      .string()
      .min(4)
      .max(Math.ceil(EVIDENCE_MAX_BYTES / 3) * 4),
  })
  .strict();
export type EvidenceUpload = z.infer<typeof evidenceUploadSchema>;
export const ingestRequestSchema = z.object({
  content_hash: hashSchema,
  byte_size: z.number().int().positive().max(EVIDENCE_MAX_BYTES),
  mime_type: z.string(),
  filename: z.string().nullable(),
  evidence_type: z.enum(EvidenceType),
  description: z.string().nullable(),
  control_ids: z.array(z.string()),
  engagement_id: uuidSchema.nullable(),
  collected_by_agent: z.string(),
  provider: z.enum(['s3', 's3-compatible']),
  bucket: z.string().min(1),
  object_key: z.string().min(1),
  retention_policy: z.literal('seven_years'),
  legal_hold: z.boolean(),
});
export const operationSchema = z.object({
  id: uuidSchema,
  tenant_id: uuidSchema,
  operation_key: uuidSchema,
  actor_id: uuidSchema,
  status: z.enum(['pending', 'settled']),
  evidence_id: uuidSchema.nullable(),
  request: ingestRequestSchema,
  retain_until: timestamp,
  correlation_id: uuidSchema,
  last_error_code: z.string().nullable(),
  created_at: timestamp,
});
export const receiptSchema = z.object({
  id: uuidSchema,
  tenant_id: uuidSchema,
  evidence_id: uuidSchema,
  ingestion_id: uuidSchema,
  provider: z.enum(['s3', 's3-compatible']),
  bucket: z.string().min(1),
  object_key: z.string().min(1),
  version_id: z
    .string()
    .min(1)
    .refine((v) => v !== 'null'),
  content_hash: hashSchema,
  byte_size: z.number().int().positive().max(EVIDENCE_MAX_BYTES),
  lock_mode: z.literal('COMPLIANCE'),
  retain_until: timestamp,
  readback_at: timestamp,
  legal_hold: z.boolean(),
  encryption: z.enum(['AES256', 'aws:kms']),
});
export type IngestOperation = z.infer<typeof operationSchema>;
export type EvidenceReceipt = z.infer<typeof receiptSchema>;
export type EvidenceDatabase = Pick<ReturnType<typeof createSupabaseAdmin>, 'from' | 'rpc'>;
export type EvidenceVaultApi = Pick<
  EvidenceVault,
  'seal' | 'verifyReceipt' | 'findEvidenceVersion' | 'retrieve'
>;
export interface EvidenceStorageConfig {
  provider: 's3' | 's3-compatible';
  bucket: string;
}

export class EvidenceError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 403 | 404 | 409 | 413 | 500 | 503,
  ) {
    super(code);
  }
}
export function evidenceStorage() {
  const env = loadEnv();
  const credentials =
    env.AXIOM_STORAGE_ACCESS_KEY_ID && env.AXIOM_STORAGE_SECRET_ACCESS_KEY
      ? {
          accessKeyId: env.AXIOM_STORAGE_ACCESS_KEY_ID,
          secretAccessKey: env.AXIOM_STORAGE_SECRET_ACCESS_KEY,
        }
      : undefined;
  return {
    config: {
      bucket: env.AXIOM_EVIDENCE_BUCKET,
      provider: env.AXIOM_STORAGE_ENDPOINT ? 's3-compatible' : 's3',
    } as EvidenceStorageConfig,
    vault: new EvidenceVault(env.AXIOM_REGION, env.AXIOM_STORAGE_ENDPOINT, credentials),
  };
}
export function decodeEvidence(input: EvidenceUpload): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.contentBase64))
    throw new EvidenceError('invalid_content_encoding', 400);
  const body = Buffer.from(input.contentBase64, 'base64');
  if (
    !body.length ||
    body.length > EVIDENCE_MAX_BYTES ||
    body.toString('base64') !== input.contentBase64
  )
    throw new EvidenceError('invalid_content_size', 400);
  return body;
}
export function publicOperation(operation: IngestOperation) {
  return {
    operationId: operation.id,
    operationKey: operation.operation_key,
    status: operation.status,
    evidenceId: operation.evidence_id,
    errorCode: operation.last_error_code,
    createdAt: operation.created_at,
    retainUntil: operation.retain_until,
  };
}
export function publicReceipt(receipt: EvidenceReceipt) {
  return {
    id: receipt.id,
    provider: receipt.provider,
    version_id: receipt.version_id,
    lock_mode: receipt.lock_mode,
    retain_until: receipt.retain_until,
    readback_at: receipt.readback_at,
    legal_hold: receipt.legal_hold,
    encryption: receipt.encryption,
  };
}
function domainError(data: unknown) {
  const parsed = z.object({ error: z.string().min(1) }).safeParse(data);
  if (parsed.success) throw new EvidenceError(parsed.data.error, 409);
}
const options = () => ({
  maxBytes: EVIDENCE_MAX_BYTES,
  timeoutMs: 30_000,
  signal: AbortSignal.timeout(30_000),
});

export class EvidenceIngestionService {
  constructor(
    readonly db: EvidenceDatabase,
    readonly vault: EvidenceVaultApi,
    readonly config: EvidenceStorageConfig,
    private readonly writer: Pick<EvidenceDatabase, 'rpc'> = db,
  ) {}

  async operation(tenantId: string, operationKey: string): Promise<IngestOperation> {
    const { data, error } = await this.db
      .from('evidence_ingestions')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('operation_key', operationKey)
      .maybeSingle();
    if (error) throw new EvidenceError('evidence_storage_unavailable', 503);
    if (!data) throw new EvidenceError('ingestion_not_found', 404);
    const parsed = operationSchema.safeParse(data);
    if (!parsed.success || parsed.data.tenant_id !== tenantId)
      throw new EvidenceError('invalid_ingestion_receipt', 503);
    return parsed.data;
  }
  private assertConfiguration(provider: string, bucket: string) {
    if (provider !== this.config.provider || bucket !== this.config.bucket)
      throw new EvidenceError('storage_configuration_mismatch', 503);
  }
  private expected(operation: IngestOperation, versionId: string) {
    const request = operation.request;
    this.assertConfiguration(request.provider, request.bucket);
    return {
      bucket: request.bucket,
      key: request.object_key,
      versionId,
      contentHash: request.content_hash,
      byteSize: request.byte_size,
      tenantId: operation.tenant_id,
      engagementId: request.engagement_id,
      collectedByAgent: request.collected_by_agent,
      retainUntil: operation.retain_until,
      legalHold: request.legal_hold,
      encryption: 'AES256' as const,
      operationId: operation.id,
    };
  }
  private async pending(operation: IngestOperation, actorId: string, code: string) {
    // Diagnostic text is never persisted: provider errors may contain credentials/URLs.
    try {
      await this.writer.rpc('note_evidence_ingest_failure', {
        p_tenant_id: operation.tenant_id,
        p_actor_id: actorId,
        p_operation_id: operation.id,
        p_error_code: code,
        p_correlation_id: randomUUID(),
      });
    } catch {
      /* The committed intent remains pending even if failure recording is unavailable. */
    }
    try {
      const current = await this.operation(operation.tenant_id, operation.operation_key);
      if (current.status === 'settled') return publicOperation(current);
      return { ...publicOperation(current), errorCode: code };
    } catch {
      return { ...publicOperation(operation), errorCode: code };
    }
  }
  private async settle(operation: IngestOperation, actorId: string, versionId: string) {
    const verified = await this.vault.verifyReceipt(this.expected(operation, versionId), options());
    const request = operation.request;
    const { data, error } = await this.writer.rpc('settle_evidence_ingest', {
      p_tenant_id: operation.tenant_id,
      p_actor_id: actorId,
      p_operation_id: operation.id,
      p_correlation_id: randomUUID(),
      p_receipt: {
        provider: request.provider,
        bucket: request.bucket,
        object_key: request.object_key,
        version_id: versionId,
        content_hash: verified.contentHash,
        byte_size: verified.byteSize,
        tenant_id: operation.tenant_id,
        engagement_id: request.engagement_id,
        collected_by_agent: request.collected_by_agent,
        retain_until: verified.retainUntil,
        readback_at: verified.readbackAt,
        lock_mode: verified.lockMode,
        verified: true,
        legal_hold: verified.legalHold,
        encryption: verified.encryption,
        operation_id: operation.id,
        correlation_id: operation.correlation_id,
      },
    });
    if (error) throw new EvidenceError('settlement_unavailable', 503);
    domainError(data);
    // Read back the immutable DB result; never invent success from a provider upload.
    const settled = await this.operation(operation.tenant_id, operation.operation_key);
    if (settled.status !== 'settled' || !settled.evidence_id)
      throw new EvidenceError('settlement_unavailable', 503);
    return publicOperation(settled);
  }
  async ingest(tenantId: string, actorId: string, input: EvidenceUpload) {
    const body = decodeEvidence(input);
    const hash = createHash('sha256').update(body).digest('hex');
    const request = {
      content_hash: hash,
      byte_size: body.length,
      mime_type: input.contentType,
      filename: input.filename,
      evidence_type: input.evidenceType,
      description: input.description,
      control_ids: [...new Set(input.controlIds)].sort(),
      engagement_id: input.engagementId ?? null,
      collected_by_agent: 'human',
      provider: this.config.provider,
      bucket: this.config.bucket,
      object_key: `tenants/${tenantId}/evidence-ingestions/${input.operationKey}/${hash}`,
      retention_policy: 'seven_years',
      legal_hold: false,
    };
    const { data, error } = await this.writer.rpc('begin_evidence_ingest', {
      p_tenant_id: tenantId,
      p_actor_id: actorId,
      p_operation_key: input.operationKey,
      p_request: request,
      p_correlation_id: randomUUID(),
    });
    if (error) throw new EvidenceError('ingestion_begin_unavailable', 503);
    domainError(data);
    const begun = z.object({ operation_id: uuidSchema, replayed: z.boolean() }).safeParse(data);
    if (!begun.success) throw new EvidenceError('ingestion_begin_unavailable', 503);
    const operation = await this.operation(tenantId, input.operationKey);
    if (operation.id !== begun.data.operation_id)
      throw new EvidenceError('invalid_ingestion_receipt', 503);
    if (begun.data.replayed || operation.status === 'settled') return publicOperation(operation);
    try {
      const sealed = await this.vault.seal({
        bucket: request.bucket,
        key: request.object_key,
        body,
        contentType: request.mime_type,
        retentionDays: 2555,
        retainUntil: operation.retain_until,
        legalHold: false,
        encryption: 'AES256',
        tenantId,
        engagementId: request.engagement_id,
        collectedByAgent: 'human',
        operationId: operation.id,
      });
      return await this.settle(operation, actorId, sealed.versionId);
    } catch {
      return this.pending(operation, actorId, 'storage_or_settlement_unconfirmed');
    }
  }
  async reconcile(tenantId: string, actorId: string, operationKey: string) {
    const operation = await this.operation(tenantId, operationKey);
    if (operation.status === 'settled') return publicOperation(operation);
    const request = operation.request;
    try {
      this.assertConfiguration(request.provider, request.bucket);
      const candidate = await this.vault.findEvidenceVersion(
        request.bucket,
        request.object_key,
        {
          tenantId,
          contentHash: request.content_hash,
          byteSize: request.byte_size,
          operationId: operation.id,
          engagementId: request.engagement_id,
          collectedByAgent: request.collected_by_agent,
        },
        options(),
      );
      if (!candidate) return this.pending(operation, actorId, 'object_version_not_found');
      return await this.settle(operation, actorId, candidate.versionId);
    } catch {
      return this.pending(operation, actorId, 'reconciliation_unconfirmed');
    }
  }
  async verify(
    tenantId: string,
    receipt: EvidenceReceipt,
    row: { engagement_id: string | null; collected_by_agent: string },
  ) {
    if (receipt.tenant_id !== tenantId) throw new EvidenceError('evidence_not_found', 404);
    this.assertConfiguration(receipt.provider, receipt.bucket);
    try {
      return await this.vault.verifyReceipt(
        {
          bucket: receipt.bucket,
          key: receipt.object_key,
          versionId: receipt.version_id,
          contentHash: receipt.content_hash,
          byteSize: receipt.byte_size,
          tenantId,
          engagementId: row.engagement_id,
          collectedByAgent: row.collected_by_agent,
          retainUntil: receipt.retain_until,
          legalHold: receipt.legal_hold,
          encryption: receipt.encryption,
          operationId: receipt.ingestion_id,
        },
        options(),
      );
    } catch {
      throw new EvidenceError('provider_verification_failed', 503);
    }
  }
  async content(
    tenantId: string,
    receipt: EvidenceReceipt,
    row: { engagement_id: string | null; collected_by_agent: string },
  ) {
    await this.verify(tenantId, receipt, row);
    try {
      const result = await this.vault.retrieve(
        receipt.bucket,
        receipt.object_key,
        receipt.version_id,
        options(),
      );
      if (result.contentHash !== receipt.content_hash || result.body.length !== receipt.byte_size)
        throw new Error('content_mismatch');
      return result.body;
    } catch {
      throw new EvidenceError('provider_verification_failed', 503);
    }
  }
}
