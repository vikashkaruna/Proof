/** Exact-version, reviewed board publication. Provider uncertainty stays pending. */
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { renderReviewedBoardHtml } from '@axiom/report-kit/board-source';
import { renderHtmlToPdf } from '@axiom/report-kit/renderer';
import type { RenderPdfOptions, RenderPdfResult } from '@axiom/report-kit/renderer';
import {
  EvidenceError,
  evidenceStorage,
  type EvidenceDatabase,
  type EvidenceStorageConfig,
  type EvidenceVaultApi,
} from './evidence-ingestion.js';

const uuid = z.uuid();
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const reportSchema = z.object({
  id: uuid,
  tenant_id: uuid,
  engagement_id: uuid,
  kind: z.literal('board'),
  title: z.string().min(1),
  status: z.enum(['draft', 'approved', 'published']),
  generated_by_agent: z.literal('board-report-builder'),
  content_text: z.string().min(1),
  content_sha256: hash,
  reviewed_content_hash: hash.nullable(),
  released_archive_hash: hash.nullable(),
});
const requestSchema = z.object({ id: uuid, report_id: uuid, assessment_run_id: uuid });
const sourceSchema = z.object({ source_text: z.string().min(1), source_sha256: hash });
const reviewSchema = z.object({
  id: uuid,
  report_id: uuid,
  decision: z.literal('approved'),
  content_sha256: hash,
  review_text: z.string().min(1),
  review_sha256: hash,
  reviewed_at: z.string().datetime({ offset: true }),
});
const buildSchema = z.object({
  id: uuid,
  tenant_id: uuid,
  report_id: uuid,
  operation_key: uuid,
  status: z.enum(['pending', 'settled']),
  request: z.object({
    provider: z.enum(['s3', 's3-compatible']),
    bucket: z.string().min(1),
    artifacts: z
      .array(
        z.object({
          kind: z.enum(['source_json', 'board_pdf']),
          object_key: z.string(),
          content_hash: hash,
          byte_size: z.number().int().positive(),
        }),
      )
      .length(2),
  }),
  retain_until: z.string().datetime({ offset: true }),
  correlation_id: uuid,
  last_error_code: z.string().nullable(),
});
const versionSchema = z.object({
  id: uuid,
  tenant_id: uuid,
  build_id: uuid,
  artifact_kind: z.enum(['source_json', 'board_pdf']),
  provider: z.enum(['s3', 's3-compatible']),
  bucket: z.string().min(1),
  object_key: z.string().min(1),
  version_id: z.string().min(1),
  content_hash: hash,
  byte_size: z.number().int().positive(),
  retain_until: z.string().datetime({ offset: true }),
  legal_hold: z.literal(false),
  encryption: z.enum(['AES256', 'aws:kms']),
});
type Report = z.infer<typeof reportSchema>;
type Build = z.infer<typeof buildSchema>;
type Version = z.infer<typeof versionSchema>;
type Storage = { vault: EvidenceVaultApi; config: EvidenceStorageConfig };
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const limits = { source_json: 4 * 1024 * 1024, board_pdf: 32 * 1024 * 1024 } as const;
let activeBoardRenders = 0;
const opts = (kind: keyof typeof limits, signal?: AbortSignal) => ({
  maxBytes: limits[kind],
  timeoutMs: 30_000,
  signal,
});

export class BoardArtifactService {
  constructor(
    readonly db: EvidenceDatabase,
    readonly storage: () => Storage = evidenceStorage,
    readonly renderPdf: (
      html: string,
      options: RenderPdfOptions,
    ) => Promise<RenderPdfResult> = renderHtmlToPdf,
  ) {}

  private async row<T>(
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
    if (error) throw new EvidenceError('report_storage_unavailable', 503);
    if (!data) return null;
    const parsed = schema.safeParse(data);
    if (!parsed.success) throw new EvidenceError('invalid_report_record', 503);
    return parsed.data;
  }

  private async authority(
    tenantId: string,
    actorId: string,
    founder: boolean,
    signal?: AbortSignal,
  ) {
    const member = await this.row(
      'tenant_users',
      tenantId,
      'user_id',
      actorId,
      z.object({ role: z.string() }),
      signal,
    );
    if (!member || (founder && member.role !== 'founder'))
      throw new EvidenceError('forbidden', 403);
    if (founder) {
      let query = this.db.from('users').select('is_axiom_internal').eq('id', actorId);
      if (signal) query = query.abortSignal(signal);
      const { data, error } = await query.maybeSingle();
      if (error) throw new EvidenceError('report_storage_unavailable', 503);
      if (data?.is_axiom_internal !== true) throw new EvidenceError('forbidden', 403);
    }
  }

  private async rpc(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    let query = this.db.rpc(name, args);
    if (signal) query = query.abortSignal(signal);
    const { data, error } = await query;
    if (error) throw new EvidenceError('report_persistence_unconfirmed', 503);
    const result = z.record(z.string(), z.unknown()).safeParse(data);
    if (!result.success) throw new EvidenceError('invalid_report_record', 503);
    if (typeof result.data.error === 'string') throw new EvidenceError(result.data.error, 409);
    return result.data;
  }

  private async context(tenantId: string, reportId: string, signal?: AbortSignal) {
    const report = await this.row('reports', tenantId, 'id', reportId, reportSchema, signal);
    if (!report) throw new EvidenceError('report_not_found', 404);
    const request = await this.row(
      'board_report_requests',
      tenantId,
      'report_id',
      reportId,
      requestSchema,
      signal,
    );
    const source = request
      ? await this.row(
          'board_request_sources',
          tenantId,
          'request_id',
          request.id,
          sourceSchema,
          signal,
        )
      : null;
    const review = await this.row(
      'report_reviews',
      tenantId,
      'report_id',
      reportId,
      reviewSchema,
      signal,
    );
    if (
      !request ||
      !source ||
      !review ||
      review.report_id !== reportId ||
      review.content_sha256 !== report.content_sha256 ||
      report.reviewed_content_hash !== report.content_sha256
    )
      throw new EvidenceError('report_artifact_unverified', 409);
    return { report, request, source, review };
  }

  private async reviewedPdf(
    context: Awaited<ReturnType<BoardArtifactService['context']>>,
    tenantId: string,
    reportId: string,
  ): Promise<RenderPdfResult> {
    const { report, request, source, review } = context;
    let html: string;
    try {
      html = renderReviewedBoardHtml({
        sourceText: source.source_text,
        sourceSha256: source.source_sha256,
        documentText: report.content_text,
        documentSha256: report.content_sha256,
        reviewText: review.review_text,
        reviewSha256: review.review_sha256,
        reportId,
        requestId: request.id,
        tenantId,
        engagementId: report.engagement_id,
        assessmentRunId: request.assessment_run_id,
        title: report.title,
      });
    } catch {
      throw new EvidenceError('assessment_source_conflict', 409);
    }
    let pdf: RenderPdfResult;
    if (activeBoardRenders >= 1) throw new EvidenceError('report_capacity_unavailable', 503);
    activeBoardRenders++;
    try {
      pdf = await this.renderPdf(html, {
        requireChromium: true,
        timeoutMs: 30_000,
        documentDate: review.reviewed_at,
      });
    } catch {
      throw new EvidenceError('report_renderer_unavailable', 503);
    } finally {
      activeBoardRenders--;
    }
    if (
      pdf.byteLength < 500 ||
      pdf.byteLength > limits.board_pdf ||
      pdf.byteLength !== pdf.pdfBuffer.length ||
      sha(pdf.pdfBuffer) !== pdf.sha256 ||
      !pdf.pdfBuffer.subarray(0, 5).equals(Buffer.from('%PDF-'))
    )
      throw new EvidenceError('report_artifact_invalid', 409);
    return pdf;
  }

  private async buildRow(tenantId: string, reportId: string, signal?: AbortSignal) {
    return this.row('board_artifact_builds', tenantId, 'report_id', reportId, buildSchema, signal);
  }

  private async versions(tenantId: string, buildId: string, signal?: AbortSignal) {
    let query = this.db
      .from('board_artifact_versions')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('build_id', buildId);
    if (signal) query = query.abortSignal(signal);
    const { data, error } = await query;
    if (error) throw new EvidenceError('report_storage_unavailable', 503);
    const parsed = z.array(versionSchema).max(2).safeParse(data);
    if (
      !parsed.success ||
      parsed.data.some((v) => v.tenant_id !== tenantId || v.build_id !== buildId)
    )
      throw new EvidenceError('invalid_report_record', 503);
    return parsed.data;
  }

  private configured(storage: Storage, build: Build) {
    if (
      storage.config.provider !== build.request.provider ||
      storage.config.bucket !== build.request.bucket
    )
      throw new EvidenceError('storage_configuration_mismatch', 503);
  }

  private async settle(
    tenantId: string,
    actorId: string,
    build: Build,
    versionId: string,
    kind: 'source_json' | 'board_pdf',
    engagementId: string,
    storage: Storage,
    signal?: AbortSignal,
  ) {
    const descriptor = build.request.artifacts.find((item) => item.kind === kind);
    if (!descriptor) throw new EvidenceError('invalid_report_record', 503);
    const verified = await storage.vault.verifyReceipt(
      {
        bucket: build.request.bucket,
        key: descriptor.object_key,
        versionId,
        contentHash: descriptor.content_hash,
        byteSize: descriptor.byte_size,
        tenantId,
        engagementId,
        collectedByAgent: 'board-report-builder',
        operationId: build.id,
        retainUntil: build.retain_until,
        legalHold: false,
        encryption: 'AES256',
      },
      opts(kind, signal),
    );
    await this.authority(tenantId, actorId, true, signal);
    await this.rpc(
      'settle_board_artifact_version',
      {
        p_tenant_id: tenantId,
        p_actor_id: actorId,
        p_build_id: build.id,
        p_artifact_kind: kind,
        p_receipt: {
          provider: build.request.provider,
          bucket: build.request.bucket,
          object_key: descriptor.object_key,
          version_id: verified.versionId,
          content_hash: verified.contentHash,
          byte_size: verified.byteSize,
          tenant_id: tenantId,
          engagement_id: engagementId,
          collected_by_agent: 'board-report-builder',
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
        'note_board_artifact_failure',
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
      /* The fixed durable build survives an unavailable failure note. */
    }
    return {
      reportId: build.report_id,
      buildId: build.id,
      status: 'pending',
      operationKey: build.operation_key,
    };
  }

  async build(
    tenantId: string,
    actorId: string,
    reportId: string,
    operationKey: string,
    signal?: AbortSignal,
  ) {
    await this.authority(tenantId, actorId, true, signal);
    const current = await this.buildRow(tenantId, reportId, signal);
    if (current) {
      if (current.operation_key !== operationKey)
        throw new EvidenceError('build_already_started', 409);
      return {
        reportId,
        buildId: current.id,
        status: current.status,
        operationKey,
        replayed: true,
      };
    }
    const context = await this.context(tenantId, reportId, signal);
    const { report, source, review } = context;
    if (report.status !== 'approved') throw new EvidenceError('not_approved', 409);
    const pdf = await this.reviewedPdf(context, tenantId, reportId);
    const sourceBytes = Buffer.from(source.source_text, 'utf8');
    if (sourceBytes.length > limits.source_json || sha(sourceBytes) !== source.source_sha256)
      throw new EvidenceError('assessment_source_conflict', 409);
    const storage = this.storage();
    const base = `tenants/${tenantId}/reports/${reportId}/${operationKey}`;
    const artifacts = [
      {
        kind: 'source_json',
        mime_type: 'application/json',
        content_hash: source.source_sha256,
        byte_size: sourceBytes.length,
        object_key: `${base}/source_json/${source.source_sha256}`,
      },
      {
        kind: 'board_pdf',
        mime_type: 'application/pdf',
        content_hash: pdf.sha256,
        byte_size: pdf.byteLength,
        object_key: `${base}/board_pdf/${pdf.sha256}`,
      },
    ];
    await this.authority(tenantId, actorId, true, signal);
    const response = await this.rpc(
      'begin_board_artifact_build',
      {
        p_tenant_id: tenantId,
        p_actor_id: actorId,
        p_report_id: reportId,
        p_operation_key: operationKey,
        p_request: {
          provider: storage.config.provider,
          bucket: storage.config.bucket,
          retention_policy: 'seven_years',
          legal_hold: false,
          source_sha256: source.source_sha256,
          content_sha256: report.content_sha256,
          review_sha256: review.review_sha256,
          renderer_version: 'chromium-board-v1',
          artifacts,
        },
        p_correlation_id: randomUUID(),
      },
      signal,
    );
    const begun = z.object({ buildId: uuid, replayed: z.boolean() }).safeParse(response);
    if (!begun.success) throw new EvidenceError('invalid_report_record', 503);
    const build = await this.buildRow(tenantId, reportId, signal);
    if (!build || build.id !== begun.data.buildId)
      throw new EvidenceError('report_persistence_unconfirmed', 503);
    if (begun.data.replayed || build.status === 'settled')
      return { reportId, buildId: build.id, status: build.status, operationKey, replayed: true };
    this.configured(storage, build);
    try {
      for (const [kind, bytes, mime] of [
        ['source_json', sourceBytes, 'application/json'],
        ['board_pdf', pdf.pdfBuffer, 'application/pdf'],
      ] as const) {
        const descriptor = build.request.artifacts.find((item) => item.kind === kind);
        if (
          !descriptor ||
          descriptor.content_hash !== sha(bytes) ||
          descriptor.byte_size !== bytes.length
        )
          throw new Error('Frozen build differs from bytes');
        const sealed = await storage.vault.seal(
          {
            bucket: build.request.bucket,
            key: descriptor.object_key,
            body: bytes,
            contentType: mime,
            retentionDays: 2555,
            retainUntil: build.retain_until,
            legalHold: false,
            encryption: 'AES256',
            tenantId,
            engagementId: report.engagement_id,
            collectedByAgent: 'board-report-builder',
            operationId: build.id,
            createOnly: true,
          },
          opts(kind, signal),
        );
        await this.settle(
          tenantId,
          actorId,
          build,
          sealed.versionId,
          kind,
          report.engagement_id,
          storage,
          signal,
        );
      }
      const settled = await this.buildRow(tenantId, reportId, signal);
      if (settled?.status !== 'settled') throw new Error('Build settlement unconfirmed');
      return { reportId, buildId: build.id, status: 'settled', operationKey, replayed: false };
    } catch {
      return this.pending(tenantId, actorId, build);
    }
  }

  async reconcile(
    tenantId: string,
    actorId: string,
    reportId: string,
    operationKey: string,
    signal?: AbortSignal,
  ) {
    await this.authority(tenantId, actorId, true, signal);
    const build = await this.buildRow(tenantId, reportId, signal);
    if (!build || build.operation_key !== operationKey)
      throw new EvidenceError('operation_not_found', 404);
    if (build.status === 'settled')
      return { reportId, buildId: build.id, status: 'settled', operationKey };
    const { report } = await this.context(tenantId, reportId, signal);
    const storage = this.storage();
    this.configured(storage, build);
    const versions = await this.versions(tenantId, build.id, signal);
    try {
      for (const descriptor of build.request.artifacts) {
        if (versions.some((v) => v.artifact_kind === descriptor.kind)) continue;
        const candidate = await storage.vault.findEvidenceVersion(
          build.request.bucket,
          descriptor.object_key,
          {
            tenantId,
            contentHash: descriptor.content_hash,
            byteSize: descriptor.byte_size,
            operationId: build.id,
            engagementId: report.engagement_id,
            collectedByAgent: 'board-report-builder',
          },
          opts(descriptor.kind, signal),
        );
        if (!candidate) return this.pending(tenantId, actorId, build);
        await this.settle(
          tenantId,
          actorId,
          build,
          candidate.versionId,
          descriptor.kind,
          report.engagement_id,
          storage,
          signal,
        );
      }
      const settled = await this.buildRow(tenantId, reportId, signal);
      if (settled?.status !== 'settled') return this.pending(tenantId, actorId, build);
      return { reportId, buildId: build.id, status: 'settled', operationKey };
    } catch {
      return this.pending(tenantId, actorId, build);
    }
  }

  /** Explicit founder action. An exact-key lookup plus conditional PUT prevents
   * an ambiguous response from creating a second retained version. */
  async retryMissing(
    tenantId: string,
    actorId: string,
    reportId: string,
    operationKey: string,
    signal?: AbortSignal,
  ) {
    await this.authority(tenantId, actorId, true, signal);
    const build = await this.buildRow(tenantId, reportId, signal);
    if (!build || build.operation_key !== operationKey)
      throw new EvidenceError('operation_not_found', 404);
    if (build.status === 'settled')
      return { reportId, buildId: build.id, status: 'settled', operationKey };
    const context = await this.context(tenantId, reportId, signal);
    if (context.report.status !== 'approved') throw new EvidenceError('not_approved', 409);
    const storage = this.storage();
    this.configured(storage, build);
    const versions = await this.versions(tenantId, build.id, signal);
    for (const descriptor of build.request.artifacts) {
      if (versions.some((v) => v.artifact_kind === descriptor.kind)) continue;
      let candidate: { versionId: string } | null;
      try {
        candidate = await storage.vault.findEvidenceVersion(
          build.request.bucket,
          descriptor.object_key,
          {
            tenantId,
            contentHash: descriptor.content_hash,
            byteSize: descriptor.byte_size,
            operationId: build.id,
            engagementId: context.report.engagement_id,
            collectedByAgent: 'board-report-builder',
          },
          opts(descriptor.kind, signal),
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
            candidate.versionId,
            descriptor.kind,
            context.report.engagement_id,
            storage,
            signal,
          );
        } catch {
          return this.pending(tenantId, actorId, build);
        }
        continue;
      }
      let bytes: Buffer;
      if (descriptor.kind === 'source_json')
        bytes = Buffer.from(context.source.source_text, 'utf8');
      else bytes = (await this.reviewedPdf(context, tenantId, reportId)).pdfBuffer;
      if (bytes.length !== descriptor.byte_size || sha(bytes) !== descriptor.content_hash)
        throw new EvidenceError('renderer_hash_changed', 409);
      await this.authority(tenantId, actorId, true, signal);
      try {
        const sealed = await storage.vault.seal(
          {
            bucket: build.request.bucket,
            key: descriptor.object_key,
            body: bytes,
            contentType: descriptor.kind === 'source_json' ? 'application/json' : 'application/pdf',
            retentionDays: 2555,
            retainUntil: build.retain_until,
            legalHold: false,
            encryption: 'AES256',
            tenantId,
            engagementId: context.report.engagement_id,
            collectedByAgent: 'board-report-builder',
            operationId: build.id,
            createOnly: true,
          },
          opts(descriptor.kind, signal),
        );
        await this.settle(
          tenantId,
          actorId,
          build,
          sealed.versionId,
          descriptor.kind,
          context.report.engagement_id,
          storage,
          signal,
        );
      } catch {
        return this.pending(tenantId, actorId, build);
      }
    }
    const settled = await this.buildRow(tenantId, reportId, signal);
    if (settled?.status !== 'settled') return this.pending(tenantId, actorId, build);
    return { reportId, buildId: build.id, status: 'settled', operationKey };
  }

  async pdf(tenantId: string, actorId: string, reportId: string, signal?: AbortSignal) {
    await this.authority(tenantId, actorId, false, signal);
    const report = await this.row('reports', tenantId, 'id', reportId, reportSchema, signal);
    if (!report) throw new EvidenceError('report_not_found', 404);
    if (report.status !== 'published') await this.authority(tenantId, actorId, true, signal);
    const build = await this.buildRow(tenantId, reportId, signal);
    if (!build || build.status !== 'settled')
      throw new EvidenceError('report_artifact_unverified', 409);
    const versions = await this.versions(tenantId, build.id, signal);
    const pdf = versions.find((v) => v.artifact_kind === 'board_pdf');
    if (
      !pdf ||
      versions.length !== 2 ||
      build.request.artifacts[1]?.content_hash !== pdf.content_hash ||
      (report.status === 'published' && report.released_archive_hash !== pdf.content_hash)
    )
      throw new EvidenceError('report_artifact_unverified', 409);
    const storage = this.storage();
    this.configured(storage, build);
    await storage.vault.verifyReceipt(
      {
        bucket: pdf.bucket,
        key: pdf.object_key,
        versionId: pdf.version_id,
        contentHash: pdf.content_hash,
        byteSize: pdf.byte_size,
        tenantId,
        engagementId: report.engagement_id,
        collectedByAgent: 'board-report-builder',
        operationId: build.id,
        retainUntil: pdf.retain_until,
        legalHold: false,
        encryption: pdf.encryption,
      },
      opts('board_pdf', signal),
    );
    const result = await storage.vault.retrieve(
      pdf.bucket,
      pdf.object_key,
      pdf.version_id,
      opts('board_pdf', signal),
    );
    if (result.body.length !== pdf.byte_size || sha(result.body) !== pdf.content_hash)
      throw new EvidenceError('provider_verification_failed', 503);
    await this.authority(tenantId, actorId, report.status !== 'published', signal);
    const fresh = await this.row('reports', tenantId, 'id', reportId, reportSchema, signal);
    const freshBuild = await this.buildRow(tenantId, reportId, signal);
    if (
      !fresh ||
      fresh.status !== report.status ||
      freshBuild?.id !== build.id ||
      freshBuild.status !== 'settled'
    )
      throw new EvidenceError('report_artifact_unverified', 409);
    return {
      pdfBuffer: result.body,
      sha256: pdf.content_hash,
      byteLength: pdf.byte_size,
      title: report.title,
    };
  }
}
