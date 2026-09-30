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
    if (report.status !== 'published' && report.created_by !== actorId) {
      throw new EvidenceError('report_not_found', 404);
    }
    const raw = report.content_text ? JSON.parse(report.content_text) : report.content;
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
