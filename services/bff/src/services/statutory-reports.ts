/**
 * Statutory Report Generation Service.
 * Renders existing statutory report drafts. New generation remains closed
 * until source-bound content and exact-version artifacts are implemented.
 *   1. Board Report
 *   2. Auditor Pack
 *   3. DPB Statutory Submission
 *   4. Technical Remediation Register
 * (W8 / FR-8 / BR-10 / Revision 106).
 */
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import {
  BoardReportContentV1Schema,
  renderBoardReportHtml,
  AuditorPackContentV1Schema,
  renderAuditorPackHtml,
  DpbSubmissionContentV1Schema,
  renderDpbSubmissionHtml,
  TechnicalRemediationRegisterContentV1Schema,
  renderTechnicalRemediationRegisterHtml,
  renderHtmlToPdf,
  buildAuditorAssessmentPack,
  renderAuditorAssessmentPackHtml,
  AuditorAssessmentPackV2Schema,
} from '@axiom/report-kit';
import { EvidenceError, type EvidenceDatabase } from './evidence-ingestion.js';

export const statutoryReportKindSchema = z.enum(['board', 'auditor', 'dpb', 'technical']);
export type StatutoryReportKind = z.infer<typeof statutoryReportKindSchema>;

export const generateStatutoryReportInputSchema = z
  .object({
    kind: statutoryReportKindSchema,
    engagementId: z.uuid(),
    title: z.string().trim().min(1).max(300),
    libraryVersion: z.string().trim().min(1).max(100).default('v1.0.0'),
    content: z.record(z.string(), z.unknown()),
  })
  .strict();

export type GenerateStatutoryReportInput = z.infer<typeof generateStatutoryReportInputSchema>;

export const requestAuditorPackInputSchema = z
  .object({
    engagementId: z.uuid(),
    assessmentRunId: z.uuid(),
    title: z.string().trim().min(1).max(300),
    operationKey: z.uuid().optional(),
  })
  .strict();
export type RequestAuditorPackInput = z.infer<typeof requestAuditorPackInputSchema>;

export const listStatutoryReportsInputSchema = z
  .object({
    kind: statutoryReportKindSchema.optional(),
    engagementId: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export type ListStatutoryReportsInput = z.infer<typeof listStatutoryReportsInputSchema>;

export class StatutoryReportService {
  constructor(private readonly db: EvidenceDatabase) {}

  private async assertLiveFounder(tenantId: string, actorId: string, signal?: AbortSignal) {
    let membership = this.db
      .from('tenant_users')
      .select('role')
      .eq('tenant_id', tenantId)
      .eq('user_id', actorId);
    if (signal) membership = membership.abortSignal(signal);
    const member = await membership.maybeSingle();
    if (member.error) throw new EvidenceError('report_storage_unavailable', 503);
    if (member.data?.role !== 'founder') throw new EvidenceError('forbidden', 403);
    let user = this.db.from('users').select('is_axiom_internal').eq('id', actorId);
    if (signal) user = user.abortSignal(signal);
    const profile = await user.maybeSingle();
    if (profile.error) throw new EvidenceError('report_storage_unavailable', 503);
    if (profile.data?.is_axiom_internal !== true) throw new EvidenceError('forbidden', 403);
  }

  private async rpc(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    let query = this.db.rpc(name, args);
    if (signal) query = query.abortSignal(signal);
    const { data, error } = await query;
    if (error) throw new EvidenceError('report_persistence_unconfirmed', 503);
    const parsed = z.record(z.string(), z.unknown()).safeParse(data);
    if (!parsed.success) throw new EvidenceError('invalid_report_record', 503);
    if (typeof parsed.data.error === 'string') {
      const code = parsed.data.error;
      throw new EvidenceError(
        code,
        code === 'forbidden' || code === 'founder_authority_required'
          ? 403
          : code.endsWith('_not_found')
            ? 404
            : 409,
      );
    }
    return parsed.data;
  }

  async requestAuditorPack(
    tenantId: string,
    actorId: string,
    input: RequestAuditorPackInput,
    correlationId = randomUUID(),
    signal?: AbortSignal,
  ) {
    return this.rpc(
      'request_statutory_report',
      {
        p_tenant_id: tenantId,
        p_actor_id: actorId,
        p_operation_key: input.operationKey ?? randomUUID(),
        p_engagement_id: input.engagementId,
        p_assessment_run_id: input.assessmentRunId,
        p_kind: 'auditor',
        p_title: input.title,
        p_correlation_id: correlationId,
      },
      signal,
    );
  }

  async generateAuditorDraft(
    tenantId: string,
    actorId: string,
    requestId: string,
    correlationId = randomUUID(),
    signal?: AbortSignal,
  ) {
    await this.assertLiveFounder(tenantId, actorId, signal);
    let requestQuery = this.db
      .from('statutory_report_requests')
      .select('id,tenant_id,engagement_id,assessment_run_id,title,kind')
      .eq('tenant_id', tenantId)
      .eq('id', requestId);
    if (signal) requestQuery = requestQuery.abortSignal(signal);
    const request = await requestQuery.maybeSingle();
    if (request.error) throw new EvidenceError('report_storage_unavailable', 503);
    const requestRow = z
      .object({
        id: z.uuid(),
        tenant_id: z.uuid(),
        engagement_id: z.uuid(),
        assessment_run_id: z.uuid(),
        title: z.string().min(1),
        kind: z.literal('auditor'),
      })
      .safeParse(request.data);
    if (!requestRow.success) throw new EvidenceError('request_not_found', 404);
    let sourceQuery = this.db
      .from('statutory_request_sources')
      .select('source_text,source_sha256')
      .eq('tenant_id', tenantId)
      .eq('request_id', requestId);
    if (signal) sourceQuery = sourceQuery.abortSignal(signal);
    const source = await sourceQuery.maybeSingle();
    if (source.error) throw new EvidenceError('report_storage_unavailable', 503);
    const frozen = z
      .object({ source_text: z.string().min(1), source_sha256: z.string().regex(/^[0-9a-f]{64}$/) })
      .safeParse(source.data);
    if (!frozen.success) throw new EvidenceError('assessment_source_incomplete', 409);
    let content;
    try {
      content = buildAuditorAssessmentPack({
        sourceText: frozen.data.source_text,
        sourceSha256: frozen.data.source_sha256,
        requestId,
        tenantId,
        engagementId: requestRow.data.engagement_id,
        assessmentRunId: requestRow.data.assessment_run_id,
        title: requestRow.data.title,
        generatedAt: new Date().toISOString(),
      });
    } catch {
      throw new EvidenceError('assessment_source_conflict', 409);
    }
    const result = await this.rpc(
      'record_source_bound_statutory_draft',
      {
        p_tenant_id: tenantId,
        p_actor_id: actorId,
        p_request_id: requestId,
        p_content_text: JSON.stringify(content),
        p_html_text: renderAuditorAssessmentPackHtml(content),
        p_correlation_id: correlationId,
      },
      signal,
    );
    return result;
  }

  async listAuditorRequests(
    tenantId: string,
    actorId: string,
    limit: number,
    offset: number,
    signal?: AbortSignal,
  ) {
    let membership = this.db
      .from('tenant_users')
      .select('role')
      .eq('tenant_id', tenantId)
      .eq('user_id', actorId);
    if (signal) membership = membership.abortSignal(signal);
    const member = await membership.maybeSingle();
    if (member.error) throw new EvidenceError('report_storage_unavailable', 503);
    const role = member.data?.role;
    if (!['founder', 'owner', 'admin'].includes(role)) throw new EvidenceError('forbidden', 403);
    if (role === 'founder') await this.assertLiveFounder(tenantId, actorId, signal);
    let query = this.db
      .from('statutory_report_requests')
      .select(
        'id,engagement_id,assessment_run_id,report_id,title,status,created_at,updated_at,requested_by',
        { count: 'exact' },
      )
      .eq('tenant_id', tenantId)
      .eq('kind', 'auditor')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (role !== 'founder') query = query.eq('requested_by', actorId);
    if (signal) query = query.abortSignal(signal);
    const result = await query;
    if (result.error) throw new EvidenceError('report_storage_unavailable', 503);
    const rows = z
      .array(
        z.object({
          id: z.uuid(),
          engagement_id: z.uuid(),
          assessment_run_id: z.uuid(),
          report_id: z.uuid().nullable(),
          title: z.string(),
          status: z.enum(['requested', 'drafted', 'reviewed', 'released', 'rejected']),
          created_at: z.string().datetime({ offset: true }),
          updated_at: z.string().datetime({ offset: true }),
          requested_by: z.uuid(),
        }),
      )
      .max(limit)
      .safeParse(result.data ?? []);
    if (!rows.success) throw new EvidenceError('invalid_report_record', 503);
    return {
      requests: rows.data.map((row) => ({
        id: row.id,
        engagementId: row.engagement_id,
        assessmentRunId: row.assessment_run_id,
        reportId: row.report_id,
        title: row.title,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
      total: result.count ?? 0,
      limit,
      offset,
    };
  }

  /**
   * Validates and renders HTML for any of the 4 statutory report formats.
   */
  validateAndRender(
    kind: StatutoryReportKind,
    rawContent: Record<string, unknown>,
  ): {
    validatedContent: unknown;
    html: string;
  } {
    switch (kind) {
      case 'board': {
        const validatedContent = BoardReportContentV1Schema.parse(rawContent);
        const html = renderBoardReportHtml(validatedContent);
        return { validatedContent, html };
      }
      case 'auditor': {
        if (rawContent.schema_version === 2 && rawContent.kind === 'auditor_pack') {
          const validatedContent = AuditorAssessmentPackV2Schema.parse(rawContent);
          return { validatedContent, html: renderAuditorAssessmentPackHtml(validatedContent) };
        }
        const validatedContent = AuditorPackContentV1Schema.parse(rawContent);
        const html = renderAuditorPackHtml(validatedContent);
        return { validatedContent, html };
      }
      case 'dpb': {
        const validatedContent = DpbSubmissionContentV1Schema.parse(rawContent);
        const html = renderDpbSubmissionHtml(validatedContent);
        return { validatedContent, html };
      }
      case 'technical': {
        const validatedContent = TechnicalRemediationRegisterContentV1Schema.parse(rawContent);
        const html = renderTechnicalRemediationRegisterHtml(validatedContent);
        return { validatedContent, html };
      }
    }
  }

  async generateStatutoryReport(
    _tenantId: string,
    _actorId: string,
    _input: GenerateStatutoryReportInput,
    _correlationId: string,
    _signal?: AbortSignal,
  ) {
    // The previous endpoint accepted arbitrary caller claims, attributed them
    // to Prativedan and stored only PDF metadata. Refuse until the source and
    // exact vault object are verified by a dedicated report workflow.
    throw new EvidenceError('source_bound_workflow_required', 409);
  }

  async getReportHtml(tenantId: string, actorId: string, reportId: string, signal?: AbortSignal) {
    const repQuery = this.db
      .from('reports')
      .select('id, title, kind, content_text, content, status, created_by')
      .eq('tenant_id', tenantId)
      .eq('id', reportId);

    const queryWithSignal =
      signal &&
      typeof (repQuery as unknown as { abortSignal?: (s: AbortSignal) => unknown }).abortSignal ===
        'function'
        ? (repQuery as unknown as { abortSignal: (s: AbortSignal) => typeof repQuery }).abortSignal(
            signal,
          )
        : repQuery;

    const repRes = (
      typeof (queryWithSignal as unknown as { maybeSingle?: () => unknown }).maybeSingle ===
      'function'
        ? await (
            queryWithSignal as unknown as {
              maybeSingle: () => Promise<{ data: unknown; error: unknown }>;
            }
          ).maybeSingle()
        : await (queryWithSignal as unknown as Promise<{ data: unknown; error: unknown }>)
    ) as {
      data: {
        id: string;
        title: string;
        kind: StatutoryReportKind;
        content_text?: string;
        content?: Record<string, unknown>;
        status: string;
        created_by: string | null;
      } | null;
      error: unknown;
    };

    if (repRes.error || !repRes.data) {
      throw new EvidenceError('report_not_found', 404);
    }

    const report = repRes.data;
    // Source-bound DPB packs are served only from the exact retained PDF
    // version after provider readback. This legacy renderer has no receipt.
    if (report.kind === 'dpb') {
      throw new EvidenceError('source_bound_workflow_required', 409);
    }
    if (report.status !== 'published' && report.created_by !== actorId) {
      throw new EvidenceError('report_not_found', 404);
    }
    if (report.kind === 'technical') {
      throw new EvidenceError('source_bound_workflow_required', 409);
    }
    const raw = report.content_text ? JSON.parse(report.content_text) : report.content;
    if (
      report.kind === 'auditor' &&
      (raw as Record<string, unknown>)?.schema_version === 2 &&
      report.status === 'published'
    ) {
      throw new EvidenceError('retained_pdf_required', 409);
    }
    const { html } = this.validateAndRender(report.kind, raw as Record<string, unknown>);

    return {
      html,
      title: report.title,
      kind: report.kind,
    };
  }

  async getReportPdf(tenantId: string, actorId: string, reportId: string, signal?: AbortSignal) {
    const { html, title, kind } = await this.getReportHtml(tenantId, actorId, reportId, signal);
    const pdf = await renderHtmlToPdf(html);

    return {
      pdfBuffer: pdf.pdfBuffer,
      sha256: pdf.sha256,
      byteLength: pdf.byteLength,
      title,
      kind,
    };
  }

  async listStatutoryReports(
    tenantId: string,
    actorId: string,
    input: ListStatutoryReportsInput,
    signal?: AbortSignal,
  ) {
    const limit = input.limit ?? 25;
    const offset = input.offset ?? 0;

    let query = this.db
      .from('reports')
      .select(
        'id, tenant_id, engagement_id, kind, title, library_version, generated_by_agent, status, created_by, created_at',
        {
          count: 'exact',
        },
      )
      .eq('tenant_id', tenantId)
      .or(`status.eq.published,created_by.eq.${actorId}`)
      .in('kind', ['board', 'auditor', 'dpb', 'technical']);

    if (input.kind) query = query.eq('kind', input.kind);
    if (input.engagementId) query = query.eq('engagement_id', input.engagementId);

    query = query.order('created_at', { ascending: false }).range(offset, offset + limit - 1);

    const queryWithSignal =
      signal &&
      typeof (query as unknown as { abortSignal?: (s: AbortSignal) => unknown }).abortSignal ===
        'function'
        ? (query as unknown as { abortSignal: (s: AbortSignal) => typeof query }).abortSignal(
            signal,
          )
        : query;

    const { data, error, count } = (await queryWithSignal) as unknown as {
      data: Array<Record<string, unknown>> | null;
      error: unknown;
      count: number | null;
    };

    if (error) {
      throw new EvidenceError('report_storage_unavailable', 503);
    }

    return {
      reports: data ?? [],
      total: count ?? data?.length ?? 0,
      limit,
      offset,
    };
  }
}
