/** Independently retained, exact-version approval and maker-checker proof. */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { ApprovalEngine } from '@axiom/approval-engine';
import { createHumanActionWriter } from '@axiom/supabase';
import { authorize, Capability, type UserRole } from '@axiom/types';
import {
  EvidenceError,
  evidenceStorage,
  type EvidenceDatabase,
  type EvidenceStorageConfig,
  type EvidenceVaultApi,
} from './evidence-ingestion.js';

const uuid = z.uuid();
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const tokenSpec = z.object({
  planId: uuid,
  actionIds: z.array(uuid).min(1).max(200),
  approverId: uuid,
  mode: z.enum(['batch', 'individual']),
  concurrency: z.number().int().positive(),
  stopOnFailure: z.boolean(),
  expiresAt: z.string().datetime({ offset: true }),
  nonce: z.string().min(1),
  contentDigest: hash,
  conditions: z.record(z.string(), z.unknown()).optional(),
});
const sourceSchema = z.object({
  schema_version: z.literal(1),
  kind: z.literal('approval_proof_source'),
  tenant_id: uuid,
  plan_id: uuid,
  token: z.object({
    id: uuid,
    approver_id: uuid,
    action_ids: z.array(uuid).min(1),
    signed_payload: tokenSpec,
    signature: hash,
  }),
  execution: z.object({ id: uuid, content_digest: hash }),
  reconciliation: z.object({
    id: uuid,
    statement: z.string().min(1).max(262144),
    signature: hash,
    approved_scope: z.object({ token_id: uuid, content_digest: hash }),
  }),
});
const preparedSchema = z.object({
  sourceText: z.string().min(1),
  sourceSha256: hash,
  sourceBytes: z
    .number()
    .int()
    .positive()
    .max(4 * 1024 * 1024),
});
const archiveSchema = z.object({
  id: uuid,
  tenant_id: uuid,
  token_id: uuid,
  plan_id: uuid,
  batch_id: uuid,
  reconciliation_id: uuid,
  operation_key: uuid,
  source_text: z.string().min(1),
  source_sha256: hash,
  source_bytes: z.number().int().positive(),
  provider: z.enum(['s3', 's3-compatible']),
  bucket: z.string().min(3),
  object_key: z.string().min(1),
  retain_until: z.string().datetime({ offset: true }),
  status: z.enum(['pending', 'settled', 'released']),
});
const versionSchema = z.object({
  version_id: z.string().min(1),
  content_hash: hash,
  byte_size: z.number().int().positive(),
  retain_until: z.string().datetime({ offset: true }),
  legal_hold: z.literal(false),
  encryption: z.enum(['AES256', 'aws:kms']),
});
const reviewSchema = z.object({
  reviewed_by: uuid,
  source_sha256: hash,
  version_id: z.string().min(1),
});
type Archive = z.infer<typeof archiveSchema>;
type Version = z.infer<typeof versionSchema>;
type Storage = { vault: EvidenceVaultApi; config: EvidenceStorageConfig };
const sha = (body: Buffer | string) => createHash('sha256').update(body).digest('hex');
const readOptions = (signal?: AbortSignal) => ({
  maxBytes: 4 * 1024 * 1024,
  timeoutMs: 30_000,
  signal,
});

/** Proof RPCs that append a human-labelled ledger event; human writer only. */
const HUMAN_WRITER_RPCS: ReadonlySet<string> = new Set([
  'begin_approval_proof_archive',
  'settle_approval_proof_archive',
  'review_approval_proof_archive',
]);

export class ApprovalProofArchiveService {
  constructor(
    private readonly db: EvidenceDatabase,
    private readonly approvalEngine: ApprovalEngine,
    private readonly archiveWriterDb: Pick<EvidenceDatabase, 'rpc'>,
    private readonly storage: () => Storage = evidenceStorage,
    private readonly writer: () => EvidenceDatabase = createHumanActionWriter,
  ) {}

  private async queryRow<T>(
    table: string,
    tenantId: string,
    column: string,
    id: string,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<T | null> {
    let query = this.db.from(table).select('*').eq('tenant_id', tenantId).eq(column, id);
    if (signal) query = query.abortSignal(signal);
    const { data, error } = await query.maybeSingle();
    if (error) throw new EvidenceError('approval_archive_storage_unavailable', 503);
    if (!data) return null;
    const parsed = schema.safeParse(data);
    if (!parsed.success) throw new EvidenceError('approval_archive_record_invalid', 503);
    return parsed.data;
  }

  private async rpcOn(
    client: Pick<EvidenceDatabase, 'rpc'>,
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    let query = client.rpc(name, args);
    if (signal) query = query.abortSignal(signal);
    const { data, error } = await query;
    if (error) throw new EvidenceError('approval_archive_persistence_unconfirmed', 503);
    const parsed = z.record(z.string(), z.unknown()).safeParse(data);
    if (!parsed.success) throw new EvidenceError('approval_archive_record_invalid', 503);
    if (typeof parsed.data.error === 'string') throw new EvidenceError(parsed.data.error, 409);
    return parsed.data;
  }

  private sourceRpc(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    return this.rpcOn(this.db, name, args, signal);
  }

  private mutationRpc(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    // begin/settle/review append a human-labelled event: human writer only.
    // release stays on the dedicated archive writer (not a moved RPC).
    const target = HUMAN_WRITER_RPCS.has(name) ? this.writer() : this.archiveWriterDb;
    return this.rpcOn(target, name, args, signal);
  }

  private async authority(
    tenantId: string,
    actorId: string,
    founder: boolean,
    signal?: AbortSignal,
  ) {
    const member = await this.queryRow(
      'tenant_users',
      tenantId,
      'user_id',
      actorId,
      z.object({ role: z.string() }),
      signal,
    );
    if (
      !member ||
      !authorize(Capability.EVIDENCE_EXPORT, { role: member.role as UserRole }).allowed
    )
      throw new EvidenceError('approval_archive_forbidden', 403);
    if (founder) {
      if (member.role !== 'founder') throw new EvidenceError('approval_archive_forbidden', 403);
      let query = this.db.from('users').select('is_axiom_internal').eq('id', actorId);
      if (signal) query = query.abortSignal(signal);
      const { data, error } = await query.maybeSingle();
      if (error) throw new EvidenceError('approval_archive_storage_unavailable', 503);
      if (data?.is_axiom_internal !== true)
        throw new EvidenceError('approval_archive_forbidden', 403);
    }
  }

  private async verifySource(tenantId: string, sourceText: string) {
    if (Buffer.byteLength(sourceText) > 4 * 1024 * 1024)
      throw new EvidenceError('approval_archive_source_incomplete', 409);
    let source: unknown;
    try {
      source = JSON.parse(sourceText);
    } catch {
      throw new EvidenceError('approval_archive_source_incomplete', 409);
    }
    const parsed = sourceSchema.safeParse(source);
    if (!parsed.success || parsed.data.tenant_id !== tenantId)
      throw new EvidenceError('approval_archive_source_incomplete', 409);
    const { token, execution, reconciliation } = parsed.data;
    const spec = token.signed_payload;
    const storedActionIds = [...token.action_ids].sort();
    if (
      spec.planId !== parsed.data.plan_id ||
      spec.approverId !== token.approver_id ||
      spec.contentDigest !== execution.content_digest ||
      spec.actionIds.length !== token.action_ids.length ||
      new Set(storedActionIds).size !== storedActionIds.length ||
      spec.actionIds.some((id, index) => id !== storedActionIds[index]) ||
      reconciliation.approved_scope.token_id !== token.id ||
      reconciliation.approved_scope.content_digest !== spec.contentDigest
    )
      throw new EvidenceError('approval_archive_scope_mismatch', 409);
    let expected: string;
    try {
      expected = await this.approvalEngine.sign(tenantId, spec);
    } catch {
      throw new EvidenceError('approval_archive_signing_authority_unavailable', 503);
    }
    if (
      !timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(token.signature, 'hex')) ||
      !this.approvalEngine.verifyDetachedStatement(
        tenantId,
        reconciliation.statement,
        reconciliation.signature,
      )
    )
      throw new EvidenceError('approval_archive_signature_invalid', 409);
    let facts: unknown;
    try {
      facts = JSON.parse(reconciliation.statement);
    } catch {
      throw new EvidenceError('approval_archive_reconciliation_invalid', 409);
    }
    const checked = z
      .object({
        schema_version: z.literal(2),
        tenant_id: uuid,
        plan_id: uuid,
        batch_id: uuid,
        token_id: uuid,
        approved_content_digest: hash,
      })
      .safeParse(facts);
    if (
      !checked.success ||
      checked.data.tenant_id !== tenantId ||
      checked.data.plan_id !== parsed.data.plan_id ||
      checked.data.batch_id !== execution.id ||
      checked.data.token_id !== token.id ||
      checked.data.approved_content_digest !== spec.contentDigest
    )
      throw new EvidenceError('approval_archive_reconciliation_invalid', 409);
    return parsed.data;
  }

  private async prepared(tenantId: string, tokenId: string, signal?: AbortSignal) {
    const result = preparedSchema.safeParse(
      await this.sourceRpc(
        'prepare_approval_proof_source',
        {
          p_tenant_id: tenantId,
          p_token_id: tokenId,
        },
        signal,
      ),
    );
    if (
      !result.success ||
      Buffer.byteLength(result.data.sourceText) !== result.data.sourceBytes ||
      sha(result.data.sourceText) !== result.data.sourceSha256
    )
      throw new EvidenceError('approval_archive_source_incomplete', 409);
    await this.verifySource(tenantId, result.data.sourceText);
    return result.data;
  }

  private async archive(tenantId: string, archiveId: string, signal?: AbortSignal) {
    const row = await this.queryRow(
      'approval_proof_archives',
      tenantId,
      'id',
      archiveId,
      archiveSchema,
      signal,
    );
    if (!row) throw new EvidenceError('approval_archive_not_found', 404);
    return row;
  }

  private async version(tenantId: string, archiveId: string, signal?: AbortSignal) {
    return this.queryRow(
      'approval_proof_versions',
      tenantId,
      'archive_id',
      archiveId,
      versionSchema,
      signal,
    );
  }

  private publicStatus(row: Archive, version: Version | null, reviewed = false) {
    return {
      archiveId: row.id,
      tokenId: row.token_id,
      planId: row.plan_id,
      status: row.status,
      sourceSha256: row.source_sha256,
      versionId: version?.version_id ?? null,
      reviewed,
      retainUntil: version?.retain_until ?? row.retain_until,
    };
  }

  async status(tenantId: string, actorId: string, archiveId: string, signal?: AbortSignal) {
    await this.authority(tenantId, actorId, false, signal);
    const row = await this.archive(tenantId, archiveId, signal);
    if (row.status !== 'released') await this.authority(tenantId, actorId, true, signal);
    const version = await this.version(tenantId, archiveId, signal);
    if (row.status !== 'pending' && !version)
      throw new EvidenceError('approval_archive_record_invalid', 503);
    const review = await this.queryRow(
      'approval_proof_reviews',
      tenantId,
      'archive_id',
      archiveId,
      reviewSchema,
      signal,
    );
    if (
      review &&
      (review.source_sha256 !== row.source_sha256 || review.version_id !== version?.version_id)
    )
      throw new EvidenceError('approval_archive_record_invalid', 503);
    return this.publicStatus(row, version, Boolean(review));
  }

  async statusForToken(tenantId: string, actorId: string, tokenId: string, signal?: AbortSignal) {
    await this.authority(tenantId, actorId, false, signal);
    const row = await this.queryRow(
      'approval_proof_archives',
      tenantId,
      'token_id',
      tokenId,
      archiveSchema,
      signal,
    );
    if (!row) throw new EvidenceError('approval_archive_not_found', 404);
    return this.status(tenantId, actorId, row.id, signal);
  }

  private async settle(row: Archive, actorId: string, signal?: AbortSignal) {
    const { vault } = this.storage();
    const found = await vault.findEvidenceVersion(
      row.bucket,
      row.object_key,
      {
        tenantId: row.tenant_id,
        contentHash: row.source_sha256,
        byteSize: row.source_bytes,
        operationId: row.id,
        collectedByAgent: 'approval-proof-archive',
      },
      readOptions(signal),
    );
    if (!found) return this.publicStatus(row, null);
    const receipt = await vault.verifyReceipt(
      {
        bucket: row.bucket,
        key: row.object_key,
        versionId: found.versionId,
        contentHash: row.source_sha256,
        byteSize: row.source_bytes,
        tenantId: row.tenant_id,
        collectedByAgent: 'approval-proof-archive',
        operationId: row.id,
        retainUntil: row.retain_until,
        legalHold: false,
      },
      readOptions(signal),
    );
    const result = await this.mutationRpc(
      'settle_approval_proof_archive',
      {
        p_tenant_id: row.tenant_id,
        p_actor_id: actorId,
        p_archive_id: row.id,
        p_receipt: {
          provider: row.provider,
          bucket: row.bucket,
          object_key: row.object_key,
          version_id: receipt.versionId,
          content_hash: receipt.contentHash,
          byte_size: receipt.byteSize,
          tenant_id: row.tenant_id,
          collected_by_agent: 'approval-proof-archive',
          operation_id: row.id,
          retain_until: receipt.retainUntil,
          readback_at: receipt.readbackAt,
          lock_mode: receipt.lockMode,
          verified: true,
          legal_hold: receipt.legalHold,
          encryption: receipt.encryption,
        },
        p_correlation_id: randomUUID(),
      },
      signal,
    );
    if (result.status !== 'settled' && result.status !== 'released')
      throw new EvidenceError('approval_archive_persistence_unconfirmed', 503);
    return this.status(row.tenant_id, actorId, row.id, signal);
  }

  async start(
    tenantId: string,
    actorId: string,
    tokenId: string,
    operationKey: string,
    signal?: AbortSignal,
  ) {
    await this.authority(tenantId, actorId, true, signal);
    const source = await this.prepared(tenantId, tokenId, signal);
    const { config, vault } = this.storage();
    const objectKey = `tenants/${tenantId}/approvals/${tokenId}/${operationKey}/${source.sourceSha256}`;
    const begun = await this.mutationRpc(
      'begin_approval_proof_archive',
      {
        p_tenant_id: tenantId,
        p_actor_id: actorId,
        p_token_id: tokenId,
        p_operation_key: operationKey,
        p_provider: config.provider,
        p_bucket: config.bucket,
        p_object_key: objectKey,
        p_source_sha256: source.sourceSha256,
        p_source_bytes: source.sourceBytes,
        p_correlation_id: randomUUID(),
      },
      signal,
    );
    const parsed = z
      .object({
        archiveId: uuid,
        status: z.enum(['pending', 'settled', 'released']),
        sourceText: z.string(),
        sourceSha256: hash,
        sourceBytes: z.number().int(),
        retainUntil: z.string().datetime({ offset: true }),
        replayed: z.boolean(),
      })
      .safeParse(begun);
    if (
      !parsed.success ||
      parsed.data.sourceText !== source.sourceText ||
      parsed.data.sourceSha256 !== source.sourceSha256 ||
      parsed.data.sourceBytes !== source.sourceBytes
    )
      throw new EvidenceError('approval_archive_persistence_unconfirmed', 503);
    const row = await this.archive(tenantId, parsed.data.archiveId, signal);
    if (parsed.data.replayed) return this.status(tenantId, actorId, row.id, signal);
    try {
      await vault.seal(
        {
          bucket: row.bucket,
          key: row.object_key,
          body: Buffer.from(row.source_text, 'utf8'),
          contentType: 'application/json',
          retentionDays: 2555,
          retainUntil: row.retain_until,
          operationId: row.id,
          createOnly: true,
          tenantId,
          collectedByAgent: 'approval-proof-archive',
          legalHold: false,
        },
        readOptions(signal),
      );
      return await this.settle(row, actorId, signal);
    } catch {
      // The provider may already have committed the version. Reconcile exact
      // metadata before any explicit retry; never silently re-PUT.
      throw new EvidenceError('approval_archive_pending_reconciliation', 503);
    }
  }

  async reconcile(tenantId: string, actorId: string, archiveId: string, signal?: AbortSignal) {
    await this.authority(tenantId, actorId, true, signal);
    const row = await this.archive(tenantId, archiveId, signal);
    await this.verifySource(tenantId, row.source_text);
    if (row.status !== 'pending') return this.status(tenantId, actorId, archiveId, signal);
    try {
      return await this.settle(row, actorId, signal);
    } catch {
      throw new EvidenceError('approval_archive_pending_reconciliation', 503);
    }
  }

  async retryMissing(tenantId: string, actorId: string, archiveId: string, signal?: AbortSignal) {
    await this.authority(tenantId, actorId, true, signal);
    const row = await this.archive(tenantId, archiveId, signal);
    if (row.status !== 'pending') return this.status(tenantId, actorId, archiveId, signal);
    const current = await this.prepared(tenantId, row.token_id, signal);
    if (current.sourceSha256 !== row.source_sha256)
      throw new EvidenceError('approval_archive_source_changed', 409);
    const { vault } = this.storage();
    const existing = await vault.findEvidenceVersion(
      row.bucket,
      row.object_key,
      {
        tenantId,
        contentHash: row.source_sha256,
        byteSize: row.source_bytes,
        operationId: row.id,
        collectedByAgent: 'approval-proof-archive',
      },
      readOptions(signal),
    );
    if (existing) return this.settle(row, actorId, signal);
    try {
      await vault.seal(
        {
          bucket: row.bucket,
          key: row.object_key,
          body: Buffer.from(row.source_text, 'utf8'),
          contentType: 'application/json',
          retentionDays: 2555,
          retainUntil: row.retain_until,
          operationId: row.id,
          createOnly: true,
          tenantId,
          collectedByAgent: 'approval-proof-archive',
          legalHold: false,
        },
        readOptions(signal),
      );
      return await this.settle(row, actorId, signal);
    } catch {
      throw new EvidenceError('approval_archive_pending_reconciliation', 503);
    }
  }

  async release(tenantId: string, actorId: string, archiveId: string, signal?: AbortSignal) {
    await this.authority(tenantId, actorId, true, signal);
    const row = await this.archive(tenantId, archiveId, signal);
    const version = await this.version(tenantId, archiveId, signal);
    if (!version || row.status === 'pending')
      throw new EvidenceError('approval_archive_not_settled', 409);
    const current = await this.prepared(tenantId, row.token_id, signal);
    if (current.sourceSha256 !== row.source_sha256 || current.sourceText !== row.source_text)
      throw new EvidenceError('approval_archive_source_changed', 409);
    const { vault } = this.storage();
    await vault.verifyReceipt(
      {
        bucket: row.bucket,
        key: row.object_key,
        versionId: version.version_id,
        contentHash: row.source_sha256,
        byteSize: row.source_bytes,
        tenantId,
        collectedByAgent: 'approval-proof-archive',
        operationId: row.id,
        retainUntil: row.retain_until,
        legalHold: false,
        encryption: version.encryption,
      },
      readOptions(signal),
    );
    const result = await this.mutationRpc(
      'release_approval_proof_archive',
      {
        p_tenant_id: tenantId,
        p_actor_id: actorId,
        p_archive_id: archiveId,
        p_source_sha256: row.source_sha256,
        p_version_id: version.version_id,
        p_correlation_id: randomUUID(),
      },
      signal,
    );
    if (
      result.status !== 'released' ||
      result.sourceSha256 !== row.source_sha256 ||
      result.versionId !== version.version_id
    )
      throw new EvidenceError('approval_archive_persistence_unconfirmed', 503);
    return this.status(tenantId, actorId, archiveId, signal);
  }

  async preview(tenantId: string, actorId: string, archiveId: string, signal?: AbortSignal) {
    await this.authority(tenantId, actorId, true, signal);
    const row = await this.archive(tenantId, archiveId, signal);
    if (row.status !== 'settled') throw new EvidenceError('approval_archive_not_settled', 409);
    const version = await this.version(tenantId, archiveId, signal);
    if (!version) throw new EvidenceError('approval_archive_record_invalid', 503);
    const current = await this.prepared(tenantId, row.token_id, signal);
    if (current.sourceSha256 !== row.source_sha256 || current.sourceText !== row.source_text)
      throw new EvidenceError('approval_archive_source_changed', 409);
    const artifact = await this.storage().vault.retrieve(
      row.bucket,
      row.object_key,
      version.version_id,
      readOptions(signal),
    );
    if (
      artifact.contentHash !== row.source_sha256 ||
      artifact.body.byteLength !== row.source_bytes ||
      artifact.body.toString('utf8') !== row.source_text
    )
      throw new EvidenceError('approval_archive_version_invalid', 503);
    await this.authority(tenantId, actorId, true, signal);
    return {
      sourceText: row.source_text,
      sourceSha256: row.source_sha256,
      versionId: version.version_id,
    };
  }

  async review(
    tenantId: string,
    actorId: string,
    archiveId: string,
    sourceSha256: string,
    versionId: string,
    signal?: AbortSignal,
  ) {
    const preview = await this.preview(tenantId, actorId, archiveId, signal);
    if (preview.sourceSha256 !== sourceSha256 || preview.versionId !== versionId)
      throw new EvidenceError('approval_archive_version_mismatch', 409);
    const result = await this.mutationRpc(
      'review_approval_proof_archive',
      {
        p_tenant_id: tenantId,
        p_actor_id: actorId,
        p_archive_id: archiveId,
        p_source_sha256: sourceSha256,
        p_version_id: versionId,
        p_correlation_id: randomUUID(),
      },
      signal,
    );
    if (result.sourceSha256 !== sourceSha256 || result.versionId !== versionId)
      throw new EvidenceError('approval_archive_persistence_unconfirmed', 503);
    return this.status(tenantId, actorId, archiveId, signal);
  }

  async download(tenantId: string, actorId: string, archiveId: string, signal?: AbortSignal) {
    await this.authority(tenantId, actorId, false, signal);
    const row = await this.archive(tenantId, archiveId, signal);
    if (row.status !== 'released') throw new EvidenceError('approval_archive_not_released', 409);
    const version = await this.version(tenantId, archiveId, signal);
    if (!version) throw new EvidenceError('approval_archive_record_invalid', 503);
    const { vault } = this.storage();
    const artifact = await vault.retrieve(
      row.bucket,
      row.object_key,
      version.version_id,
      readOptions(signal),
    );
    if (artifact.contentHash !== row.source_sha256 || artifact.body.byteLength !== row.source_bytes)
      throw new EvidenceError('approval_archive_version_invalid', 503);
    await this.authority(tenantId, actorId, false, signal);
    return { bytes: artifact.body, sha256: row.source_sha256, versionId: version.version_id };
  }
}
