/**
 * Statutory Report Generation Service.
 * Implements draft recording, deterministic HTML & PDF generation,
 * and immutable artifact storage for the four statutory DPDPA report formats:
 *   1. Board Report
 *   2. Auditor Pack
 *   3. DPB Statutory Submission
 *   4. Technical Remediation Register
 * (W8 / FR-8 / BR-10 / Revision 106).
 */
import { randomUUID } from 'node:crypto';
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

  private async rpc(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    const query = this.db.rpc(name, args) as unknown as {
      abortSignal?: (sig: AbortSignal) => Promise<{ data: unknown; error: unknown }>;
    };
    const { data, error } =
      signal && typeof query?.abortSignal === 'function'
        ? await query.abortSignal(signal)
        : await (query as unknown as Promise<{ data: unknown; error: unknown }>);

    if (error) {
      throw new EvidenceError('report_storage_unavailable', 503);
    }
    return data as Record<string, unknown>;
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
    tenantId: string,
    actorId: string,
    input: GenerateStatutoryReportInput,
    correlationId: string = randomUUID(),
    signal?: AbortSignal,
  ) {
    // 1. Validate content and render deterministic HTML
    let validatedContent: unknown;
    let html: string;
    try {
      const rendered = this.validateAndRender(input.kind, input.content);
      validatedContent = rendered.validatedContent;
      html = rendered.html;
    } catch (err) {
      if (err instanceof z.ZodError) {
        throw new EvidenceError('invalid_content', 400);
      }
      throw err;
    }

    const contentText = JSON.stringify(validatedContent);

    // 2. Call record_statutory_report_draft RPC
    const draftRes = await this.rpc(
      'record_statutory_report_draft',
      {
        p_tenant_id: tenantId,
        p_actor_id: actorId,
        p_engagement_id: input.engagementId,
        p_kind: input.kind,
        p_title: input.title,
        p_library_version: input.libraryVersion,
        p_content_text: contentText,
        p_html_text: html,
        p_correlation_id: correlationId,
      },
      signal,
    );

    if (draftRes.error) {
      if (draftRes.error === 'forbidden') throw new EvidenceError('forbidden', 403);
      if (draftRes.error === 'invalid_report_kind')
        throw new EvidenceError('invalid_report_kind', 400);
      if (draftRes.error === 'invalid_content') throw new EvidenceError('invalid_content', 400);
      throw new EvidenceError('invalid_request', 400);
    }

    const reportId = draftRes.reportId as string;

    // 3. Render and attach PDF
    try {
      const pdf = await renderHtmlToPdf(html);
      await this.rpc(
        'attach_statutory_report_pdf',
        {
          p_tenant_id: tenantId,
          p_actor_id: actorId,
          p_report_id: reportId,
          p_pdf_sha256: pdf.sha256,
          p_pdf_bytes: pdf.byteLength,
          p_correlation_id: correlationId,
        },
        signal,
      );
    } catch {
      // PDF generation failure does not prevent draft creation
    }

    return {
      reportId,
      kind: input.kind,
      status: 'draft',
      contentHash: draftRes.contentHash,
      htmlHash: draftRes.htmlHash,
    };
  }

  async getReportHtml(tenantId: string, actorId: string, reportId: string, signal?: AbortSignal) {
    const repQuery = this.db
      .from('reports')
      .select('id, title, kind, content_text, content')
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
      } | null;
      error: unknown;
    };

    if (repRes.error || !repRes.data) {
      throw new EvidenceError('report_not_found', 404);
    }

    const report = repRes.data;
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

    // Attempt best-effort attach if not present
    try {
      await this.rpc(
        'attach_statutory_report_pdf',
        {
          p_tenant_id: tenantId,
          p_actor_id: actorId,
          p_report_id: reportId,
          p_pdf_sha256: pdf.sha256,
          p_pdf_bytes: pdf.byteLength,
          p_correlation_id: randomUUID(),
        },
        signal,
      );
    } catch {
      // Best-effort
    }

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
        'id, tenant_id, engagement_id, kind, title, library_version, generated_by_agent, created_at',
        {
          count: 'exact',
        },
      )
      .eq('tenant_id', tenantId)
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
