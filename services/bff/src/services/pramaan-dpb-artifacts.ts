import { createStatutoryProofWriter } from '@axiom/supabase';
/** Source-bound recorded-plan Pramaan dpb dossier. Provider uncertainty remains pending. */
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { buildPramaanDpbArchive } from '@axiom/report-kit/pramaan-archive';
import {
  EvidenceError,
  evidenceStorage,
  type EvidenceDatabase,
  type EvidenceStorageConfig,
  type EvidenceVaultApi,
} from './evidence-ingestion.js';
import { accessFor } from './evidence-pack-records.js';

const uuid = z.uuid();
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const reportSchema = z.object({
  id: uuid,
  tenant_id: uuid,
  engagement_id: z.null(),
  kind: z.literal('dpb'),
  generated_by_agent: z.literal('dpb-report-builder'),
  status: z.enum(['draft', 'approved', 'rejected', 'published', 'archived']),
  title: z.string().min(1),
  content: z.object({ source_sha256: digest }).passthrough(),
  released_by: uuid,
  released_archive_hash: digest.nullable(),
});
const sourceBuildSchema = z.object({
  id: uuid,
  tenant_id: uuid,
  report_id: uuid,
  status: z.literal('settled'),
  source_sha256: digest,
});
const versionSchema = z.object({
  id: uuid,
  tenant_id: uuid,
  report_id: uuid,
  build_id: uuid,
  artifact_kind: z.enum(['source_json', 'dpb_pdf']),
  provider: z.enum(['s3', 's3-compatible']),
  bucket: z.string().min(3),
  object_key: z.string().min(1),
  version_id: z.string().min(1),
  content_hash: digest,
  byte_size: z.number().int().positive(),
  retain_until: z.string().datetime({ offset: true }),
  encryption: z.enum(['AES256', 'aws:kms']),
});
const buildSchema = z.object({
  id: uuid,
  tenant_id: uuid,
  dossier_id: uuid,
  report_id: uuid,
  source_build_id: uuid,
  operation_key: uuid,
  requested_by: uuid,
  request: z.object({
    provider: z.enum(['s3', 's3-compatible']),
    bucket: z.string().min(3),
    object_key: z.string().min(1),
    archive_sha256: digest,
    archive_bytes: z.number().int().positive(),
    manifest_sha256: digest,
    source_sha256: digest,
    pdf_sha256: digest,
    source_version_id: uuid,
    pdf_version_id: uuid,
  }),
  retain_until: z.string().datetime({ offset: true }),
  correlation_id: uuid,
  status: z.enum(['pending', 'settled']),
  last_error_code: z.string().nullable(),
});
const archiveSchema = z.object({
  id: uuid,
  tenant_id: uuid,
  dossier_id: uuid,
  build_id: uuid,
  provider: z.enum(['s3', 's3-compatible']),
  bucket: z.string().min(3),
  object_key: z.string().min(1),
  version_id: z.string().min(1),
  content_hash: digest,
  byte_size: z.number().int().positive(),
  retain_until: z.string().datetime({ offset: true }),
  encryption: z.enum(['AES256', 'aws:kms']),
});
type Version = z.infer<typeof versionSchema>;
type Build = z.infer<typeof buildSchema>;
type Storage = { vault: EvidenceVaultApi; config: EvidenceStorageConfig };
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const readOptions = (maxBytes: number, signal?: AbortSignal) => ({
  maxBytes,
  timeoutMs: 30_000,
  signal,
});

export class PramaanDpbArtifactService {
  constructor(
    private readonly db: EvidenceDatabase,
    private readonly storage: () => Storage = evidenceStorage,
    private readonly writer: () => Pick<EvidenceDatabase, 'rpc'> = createStatutoryProofWriter,
  ) {}

  private async row<T>(
    table: string,
    tenantId: string,
    key: string,
    value: string,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<T | null> {
    let query = this.db.from(table).select('*').eq('tenant_id', tenantId).eq(key, value);
    if (signal) query = query.abortSignal(signal);
    const { data, error } = await query.maybeSingle();
    if (error) throw new EvidenceError('dossier_storage_unavailable', 503);
    if (!data) return null;
    const parsed = schema.safeParse(data);
    if (!parsed.success) throw new EvidenceError('invalid_dossier_record', 503);
    return parsed.data;
  }

  private async rpc(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    let query = this.writer().rpc(name, args);
    if (signal) query = query.abortSignal(signal);
    const { data, error } = await query;
    if (error) throw new EvidenceError('dossier_persistence_unconfirmed', 503);
    const parsed = z.record(z.string(), z.unknown()).safeParse(data);
    if (!parsed.success) throw new EvidenceError('invalid_dossier_record', 503);
    if (typeof parsed.data.error === 'string') throw new EvidenceError(parsed.data.error, 409);
    return parsed.data;
  }

  private async manager(tenantId: string, actorId: string, signal?: AbortSignal) {
    const access = await accessFor(this.db, tenantId, actorId, signal);
    if (!access.manager) throw new EvidenceError('forbidden', 403);
    return access;
  }

  private async founder(tenantId: string, actorId: string, signal?: AbortSignal) {
    const access = await accessFor(this.db, tenantId, actorId, signal);
    if (!access.founder) throw new EvidenceError('dossier_not_found', 404);
  }

  private async source(tenantId: string, reportId: string, signal?: AbortSignal) {
    const identity = await this.row(
      'reports',
      tenantId,
      'id',
      reportId,
      z.object({ kind: z.string() }),
      signal,
    );
    if (identity && identity.kind !== 'dpb')
      throw new EvidenceError('source_bound_dossier_required', 409);
    const report = await this.row('reports', tenantId, 'id', reportId, reportSchema, signal);
    if (!report || report.status !== 'published')
      throw new EvidenceError('source_report_not_released', 409);
    const request = await this.row(
      'dpb_report_requests',
      tenantId,
      'report_id',
      reportId,
      z.object({
        id: uuid,
        tenant_id: uuid,
        report_id: uuid,
        status: z.literal('released'),
      }),
      signal,
    );
    if (!request || request.report_id !== reportId)
      throw new EvidenceError('source_version_conflict', 409);
    const frozen = await this.row(
      'dpb_request_sources',
      tenantId,
      'request_id',
      request.id,
      z.object({ request_id: uuid, tenant_id: uuid, source_sha256: digest }),
      signal,
    );
    if (!frozen || frozen.source_sha256 !== report.content.source_sha256)
      throw new EvidenceError('source_version_conflict', 409);
    const build = await this.row(
      'dpb_artifact_builds',
      tenantId,
      'report_id',
      reportId,
      sourceBuildSchema,
      signal,
    );
    if (!build) throw new EvidenceError('source_version_conflict', 409);
    let query = this.db
      .from('dpb_artifact_versions')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('build_id', build.id);
    if (signal) query = query.abortSignal(signal);
    const { data, error } = await query;
    if (error) throw new EvidenceError('dossier_storage_unavailable', 503);
    const parsed = z.array(versionSchema).length(2).safeParse(data);
    if (!parsed.success) throw new EvidenceError('source_version_conflict', 409);
    const source = parsed.data.find((v) => v.artifact_kind === 'source_json');
    const pdf = parsed.data.find((v) => v.artifact_kind === 'dpb_pdf');
    if (
      !source ||
      !pdf ||
      parsed.data.some((v) => v.report_id !== reportId || v.build_id !== build.id) ||
      build.source_sha256 !== frozen.source_sha256 ||
      source.content_hash !== frozen.source_sha256 ||
      report.released_archive_hash !== pdf.content_hash ||
      report.engagement_id !== null
    )
      throw new EvidenceError('source_version_conflict', 409);
    return { report, request, build, source, pdf };
  }

  private async exactSourceBytes(
    tenantId: string,
    context: Awaited<ReturnType<PramaanDpbArtifactService['source']>>,
    storage: Storage,
    signal?: AbortSignal,
  ) {
    const { report, build, source, pdf } = context;
    if (
      storage.config.provider !== source.provider ||
      storage.config.bucket !== source.bucket ||
      storage.config.provider !== pdf.provider ||
      storage.config.bucket !== pdf.bucket
    )
      throw new EvidenceError('storage_configuration_mismatch', 503);
    const read = async (version: Version, maxBytes: number) => {
      const options = readOptions(maxBytes, signal);
      await storage.vault.verifyReceipt(
        {
          bucket: version.bucket,
          key: version.object_key,
          versionId: version.version_id,
          contentHash: version.content_hash,
          byteSize: version.byte_size,
          tenantId,
          engagementId: report.engagement_id,
          collectedByAgent: 'dpb-report-builder',
          operationId: build.id,
          retainUntil: version.retain_until,
          legalHold: false,
          encryption: version.encryption,
        },
        options,
      );
      const result = await storage.vault.retrieve(
        version.bucket,
        version.object_key,
        version.version_id,
        options,
      );
      if (result.body.length !== version.byte_size || sha(result.body) !== version.content_hash)
        throw new EvidenceError('provider_verification_failed', 503);
      return result.body;
    };
    const sourceBytes = await read(source, 4 * 1024 * 1024);
    const pdfBytes = await read(pdf, 32 * 1024 * 1024);
    return { sourceBytes, pdfBytes };
  }

  private async buildRow(tenantId: string, dossierId: string, signal?: AbortSignal) {
    return this.row('pramaan_dpb_builds', tenantId, 'dossier_id', dossierId, buildSchema, signal);
  }

  private async archiveRow(tenantId: string, dossierId: string, signal?: AbortSignal) {
    return this.row(
      'pramaan_dpb_archives',
      tenantId,
      'dossier_id',
      dossierId,
      archiveSchema,
      signal,
    );
  }

  async owns(tenantId: string, dossierId: string, signal?: AbortSignal) {
    return Boolean(await this.buildRow(tenantId, dossierId, signal));
  }

  async status(tenantId: string, actorId: string, dossierId: string, signal?: AbortSignal) {
    const access = await accessFor(this.db, tenantId, actorId, signal);
    const build = await this.buildRow(tenantId, dossierId, signal);
    if (!access.founder && (!access.manager || build?.requested_by !== actorId))
      throw new EvidenceError('dossier_not_found', 404);
    if (!build)
      return {
        sourceBound: false as const,
        archiveStatus: null,
        archiveVersionId: null,
        operationKey: null,
      };
    const archive = await this.archiveRow(tenantId, dossierId, signal);
    if (build.status === 'settled' && (!archive || archive.build_id !== build.id))
      throw new EvidenceError('invalid_dossier_record', 503);
    return {
      sourceBound: true as const,
      archiveStatus: build.status,
      archiveVersionId: archive?.version_id ?? null,
      operationKey: build.operation_key,
    };
  }

  async mine(tenantId: string, actorId: string, signal?: AbortSignal) {
    await this.manager(tenantId, actorId, signal);
    let query = this.db
      .from('pramaan_dpb_builds')
      .select('dossier_id,report_id,status,operation_key,created_at')
      .eq('tenant_id', tenantId)
      .eq('requested_by', actorId)
      .order('created_at', { ascending: false })
      .range(0, 99);
    if (signal) query = query.abortSignal(signal);
    const { data, error } = await query;
    if (error) throw new EvidenceError('dossier_storage_unavailable', 503);
    const parsed = z
      .array(
        z.object({
          dossier_id: uuid,
          report_id: uuid,
          status: z.enum(['pending', 'settled']),
          operation_key: uuid,
          created_at: z.string().datetime({ offset: true }),
        }),
      )
      .max(100)
      .safeParse(data);
    if (!parsed.success) throw new EvidenceError('invalid_dossier_record', 503);
    return {
      builds: parsed.data.map((item) => ({
        dossierId: item.dossier_id,
        reportId: item.report_id,
        status: item.status,
        operationKey: item.operation_key,
        createdAt: item.created_at,
      })),
    };
  }

  private async settle(
    tenantId: string,
    actorId: string,
    build: Build,
    engagementId: string | null,
    versionId: string,
    storage: Storage,
    signal?: AbortSignal,
  ) {
    const verified = await storage.vault.verifyReceipt(
      {
        bucket: build.request.bucket,
        key: build.request.object_key,
        versionId,
        contentHash: build.request.archive_sha256,
        byteSize: build.request.archive_bytes,
        tenantId,
        engagementId,
        collectedByAgent: 'pramaan',
        operationId: build.id,
        retainUntil: build.retain_until,
        legalHold: false,
        encryption: 'AES256',
      },
      readOptions(64 * 1024 * 1024, signal),
    );
    await this.rpc(
      'settle_dpb_pramaan',
      {
        p_tenant_id: tenantId,
        p_actor_id: actorId,
        p_build_id: build.id,
        p_receipt: {
          provider: build.request.provider,
          bucket: build.request.bucket,
          object_key: build.request.object_key,
          version_id: verified.versionId,
          content_hash: verified.contentHash,
          byte_size: verified.byteSize,
          tenant_id: tenantId,
          engagement_id: engagementId,
          collected_by_agent: 'pramaan',
          retain_until: verified.retainUntil,
          readback_at: verified.readbackAt,
          lock_mode: verified.lockMode,
          verified: true,
          legal_hold: verified.legalHold,
          encryption: verified.encryption,
          operation_id: build.id,
          correlation_id: build.correlation_id,
        },
        p_correlation_id: randomUUID(),
      },
      signal,
    );
  }

  private async pending(tenantId: string, actorId: string, build: Build) {
    try {
      await this.rpc(
        'note_dpb_pramaan_failure',
        {
          p_tenant_id: tenantId,
          p_actor_id: actorId,
          p_build_id: build.id,
          p_error_code: 'storage_or_settlement_unconfirmed',
          p_correlation_id: randomUUID(),
        },
        AbortSignal.timeout(5_000),
      );
    } catch {
      /* The fixed build survives an unavailable failure note. */
    }
    return {
      dossierId: build.dossier_id,
      buildId: build.id,
      operationKey: build.operation_key,
      status: 'pending' as const,
    };
  }

  async create(
    tenantId: string,
    actorId: string,
    input: {
      engagementId: string | null;
      reportId: string;
      dossierType: string;
      title: string;
      operationKey: string;
    },
    signal?: AbortSignal,
  ) {
    await this.manager(tenantId, actorId, signal);
    if (input.dossierType !== 'dpb_statutory')
      throw new EvidenceError('source_bound_dossier_required', 409);
    const title = input.title.trim();
    const context = await this.source(tenantId, input.reportId, signal);
    if (input.engagementId !== null) throw new EvidenceError('source_version_conflict', 409);
    const storage = this.storage();
    const bytes = await this.exactSourceBytes(tenantId, context, storage, signal);
    let archive: ReturnType<typeof buildPramaanDpbArchive>;
    try {
      archive = buildPramaanDpbArchive({
        tenantId,
        engagementId: input.engagementId,
        reportId: input.reportId,
        requestId: context.request.id,
        title,
        source: {
          id: context.source.id,
          versionId: context.source.version_id,
          sha256: context.source.content_hash,
        },
        pdf: {
          id: context.pdf.id,
          versionId: context.pdf.version_id,
          sha256: context.pdf.content_hash,
        },
        ...bytes,
      });
    } catch {
      throw new EvidenceError('source_version_conflict', 409);
    }
    const objectKey = `tenants/${tenantId}/pramaan/dpb/${input.reportId}/${input.operationKey}/${archive.archiveSha256}`;
    const begun = await this.rpc(
      'begin_dpb_pramaan',
      {
        p_tenant_id: tenantId,
        p_actor_id: actorId,
        p_report_id: input.reportId,
        p_operation_key: input.operationKey,
        p_title: title,
        p_request: {
          provider: storage.config.provider,
          bucket: storage.config.bucket,
          source_sha256: context.source.content_hash,
          pdf_sha256: context.pdf.content_hash,
          source_version_id: context.source.id,
          pdf_version_id: context.pdf.id,
          manifest_sha256: archive.manifestSha256,
          archive_sha256: archive.archiveSha256,
          archive_bytes: archive.byteSize,
          object_key: objectKey,
        },
        p_correlation_id: randomUUID(),
      },
      signal,
    );
    const id = uuid.safeParse(begun.dossierId);
    if (!id.success) throw new EvidenceError('invalid_dossier_record', 503);
    const build = await this.buildRow(tenantId, id.data, signal);
    if (!build || build.operation_key !== input.operationKey)
      throw new EvidenceError('dossier_persistence_unconfirmed', 503);
    if (build.status === 'settled' || begun.replayed === true)
      return {
        dossierId: id.data,
        buildId: build.id,
        operationKey: input.operationKey,
        status: build.status,
        replayed: true,
      };
    try {
      const sealed = await storage.vault.seal(
        {
          bucket: build.request.bucket,
          key: build.request.object_key,
          body: archive.archive,
          contentType: 'application/zip',
          retentionDays: 2555,
          retainUntil: build.retain_until,
          legalHold: false,
          encryption: 'AES256',
          tenantId,
          engagementId: input.engagementId,
          collectedByAgent: 'pramaan',
          operationId: build.id,
          createOnly: true,
        },
        readOptions(64 * 1024 * 1024, signal),
      );
      await this.settle(
        tenantId,
        actorId,
        build,
        input.engagementId,
        sealed.versionId,
        storage,
        signal,
      );
      return {
        dossierId: id.data,
        buildId: build.id,
        operationKey: input.operationKey,
        status: 'settled' as const,
        replayed: false,
      };
    } catch {
      return this.pending(tenantId, actorId, build);
    }
  }

  async reconcile(
    tenantId: string,
    actorId: string,
    dossierId: string,
    operationKey: string,
    signal?: AbortSignal,
  ) {
    await this.manager(tenantId, actorId, signal);
    const build = await this.buildRow(tenantId, dossierId, signal);
    if (!build || build.operation_key !== operationKey)
      throw new EvidenceError('operation_not_found', 404);
    if (build.requested_by !== actorId) await this.founder(tenantId, actorId, signal);
    if (build.status === 'settled')
      return { dossierId, buildId: build.id, operationKey, status: 'settled' as const };
    const context = await this.source(tenantId, build.report_id, signal);
    const storage = this.storage();
    if (
      storage.config.provider !== build.request.provider ||
      storage.config.bucket !== build.request.bucket
    )
      throw new EvidenceError('storage_configuration_mismatch', 503);
    try {
      const candidate = await storage.vault.findEvidenceVersion(
        build.request.bucket,
        build.request.object_key,
        {
          tenantId,
          contentHash: build.request.archive_sha256,
          byteSize: build.request.archive_bytes,
          operationId: build.id,
          engagementId: context.report.engagement_id,
          collectedByAgent: 'pramaan',
        },
        readOptions(64 * 1024 * 1024, signal),
      );
      if (!candidate) return this.pending(tenantId, actorId, build);
      await this.settle(
        tenantId,
        actorId,
        build,
        context.report.engagement_id,
        candidate.versionId,
        storage,
        signal,
      );
      return { dossierId, buildId: build.id, operationKey, status: 'settled' as const };
    } catch {
      return this.pending(tenantId, actorId, build);
    }
  }

  /** A second PUT is an explicit founder action only after the fixed key is confirmed absent. */
  async retryMissing(
    tenantId: string,
    actorId: string,
    dossierId: string,
    operationKey: string,
    signal?: AbortSignal,
  ) {
    await this.founder(tenantId, actorId, signal);
    const build = await this.buildRow(tenantId, dossierId, signal);
    if (!build || build.operation_key !== operationKey)
      throw new EvidenceError('operation_not_found', 404);
    if (build.status === 'settled')
      return { dossierId, buildId: build.id, operationKey, status: 'settled' as const };
    const context = await this.source(tenantId, build.report_id, signal);
    const storage = this.storage();
    if (
      storage.config.provider !== build.request.provider ||
      storage.config.bucket !== build.request.bucket
    )
      throw new EvidenceError('storage_configuration_mismatch', 503);
    let candidate: { versionId: string } | null;
    try {
      candidate = await storage.vault.findEvidenceVersion(
        build.request.bucket,
        build.request.object_key,
        {
          tenantId,
          contentHash: build.request.archive_sha256,
          byteSize: build.request.archive_bytes,
          operationId: build.id,
          engagementId: context.report.engagement_id,
          collectedByAgent: 'pramaan',
        },
        readOptions(64 * 1024 * 1024, signal),
      );
    } catch {
      return this.pending(tenantId, actorId, build);
    }
    if (candidate) {
      try {
        await this.settle(
          tenantId,
          actorId,
          build,
          context.report.engagement_id,
          candidate.versionId,
          storage,
          signal,
        );
        return { dossierId, buildId: build.id, operationKey, status: 'settled' as const };
      } catch {
        return this.pending(tenantId, actorId, build);
      }
    }
    const dossier = await this.row(
      'pramaan_dossiers',
      tenantId,
      'id',
      dossierId,
      z.object({ title: z.string().min(1).max(300), status: z.literal('draft') }),
      signal,
    );
    if (!dossier) throw new EvidenceError('dossier_not_found', 404);
    const bytes = await this.exactSourceBytes(tenantId, context, storage, signal);
    let rebuilt: ReturnType<typeof buildPramaanDpbArchive>;
    try {
      rebuilt = buildPramaanDpbArchive({
        tenantId,
        engagementId: context.report.engagement_id,
        reportId: build.report_id,
        requestId: context.request.id,
        title: dossier.title,
        source: {
          id: context.source.id,
          versionId: context.source.version_id,
          sha256: context.source.content_hash,
        },
        pdf: {
          id: context.pdf.id,
          versionId: context.pdf.version_id,
          sha256: context.pdf.content_hash,
        },
        ...bytes,
      });
    } catch {
      throw new EvidenceError('source_version_conflict', 409);
    }
    if (
      rebuilt.archiveSha256 !== build.request.archive_sha256 ||
      rebuilt.byteSize !== build.request.archive_bytes ||
      rebuilt.manifestSha256 !== build.request.manifest_sha256
    )
      throw new EvidenceError('archive_hash_changed', 409);
    try {
      const sealed = await storage.vault.seal(
        {
          bucket: build.request.bucket,
          key: build.request.object_key,
          body: rebuilt.archive,
          contentType: 'application/zip',
          retentionDays: 2555,
          retainUntil: build.retain_until,
          legalHold: false,
          encryption: 'AES256',
          tenantId,
          engagementId: context.report.engagement_id,
          collectedByAgent: 'pramaan',
          operationId: build.id,
          createOnly: true,
        },
        readOptions(64 * 1024 * 1024, signal),
      );
      await this.settle(
        tenantId,
        actorId,
        build,
        context.report.engagement_id,
        sealed.versionId,
        storage,
        signal,
      );
      return { dossierId, buildId: build.id, operationKey, status: 'settled' as const };
    } catch {
      return this.pending(tenantId, actorId, build);
    }
  }

  async seal(
    tenantId: string,
    actorId: string,
    dossierId: string,
    expectedProofSeal: string,
    signal?: AbortSignal,
  ) {
    await this.founder(tenantId, actorId, signal);
    const build = await this.buildRow(tenantId, dossierId, signal);
    if (!build) throw new EvidenceError('source_bound_dossier_required', 409);
    if (build.status !== 'settled') throw new EvidenceError('archive_unverified', 409);
    const archive = await this.archiveRow(tenantId, dossierId, signal);
    if (
      !archive ||
      archive.build_id !== build.id ||
      archive.content_hash !== build.request.archive_sha256
    )
      throw new EvidenceError('archive_unverified', 409);
    const storage = this.storage();
    if (storage.config.provider !== archive.provider || storage.config.bucket !== archive.bucket)
      throw new EvidenceError('storage_configuration_mismatch', 503);
    const context = await this.source(tenantId, build.report_id, signal);
    await this.exactSourceBytes(tenantId, context, storage, signal);
    await storage.vault.verifyReceipt(
      {
        bucket: archive.bucket,
        key: archive.object_key,
        versionId: archive.version_id,
        contentHash: archive.content_hash,
        byteSize: archive.byte_size,
        tenantId,
        engagementId: context.report.engagement_id,
        collectedByAgent: 'pramaan',
        operationId: build.id,
        retainUntil: archive.retain_until,
        legalHold: false,
        encryption: archive.encryption,
      },
      readOptions(64 * 1024 * 1024, signal),
    );
    return this.rpc(
      'seal_dpb_pramaan',
      {
        p_tenant_id: tenantId,
        p_actor_id: actorId,
        p_dossier_id: dossierId,
        p_expected_proof_seal: expectedProofSeal,
        p_correlation_id: randomUUID(),
      },
      signal,
    );
  }

  async archive(tenantId: string, actorId: string, dossierId: string, signal?: AbortSignal) {
    await this.founder(tenantId, actorId, signal);
    const build = await this.buildRow(tenantId, dossierId, signal);
    const archive = await this.archiveRow(tenantId, dossierId, signal);
    if (!build || build.status !== 'settled' || !archive || archive.build_id !== build.id)
      throw new EvidenceError('archive_unverified', 409);
    const context = await this.source(tenantId, build.report_id, signal);
    const storage = this.storage();
    if (storage.config.provider !== archive.provider || storage.config.bucket !== archive.bucket)
      throw new EvidenceError('storage_configuration_mismatch', 503);
    await storage.vault.verifyReceipt(
      {
        bucket: archive.bucket,
        key: archive.object_key,
        versionId: archive.version_id,
        contentHash: archive.content_hash,
        byteSize: archive.byte_size,
        tenantId,
        engagementId: context.report.engagement_id,
        collectedByAgent: 'pramaan',
        operationId: build.id,
        retainUntil: archive.retain_until,
        legalHold: false,
        encryption: archive.encryption,
      },
      readOptions(64 * 1024 * 1024, signal),
    );
    const exact = await storage.vault.retrieve(
      archive.bucket,
      archive.object_key,
      archive.version_id,
      readOptions(64 * 1024 * 1024, signal),
    );
    if (exact.body.length !== archive.byte_size || sha(exact.body) !== archive.content_hash)
      throw new EvidenceError('provider_verification_failed', 503);
    return { body: exact.body, sha256: archive.content_hash, byteSize: archive.byte_size };
  }
}
