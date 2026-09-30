/**
 * Board Report Generation Service.
 * Implements manager-initiated request binding, Prativedan draft synthesis,
 * deterministic HTML & PDF generation, and dual-signature verification.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  BoardReportContentV1,
  BoardReportContentV1Schema,
  renderBoardReportHtml,
} from '@axiom/report-kit/board-report';
import { renderHtmlToPdf } from '@axiom/report-kit/renderer';
import { EvidenceError, type EvidenceDatabase } from './evidence-ingestion.js';

export interface BoardReportServiceDependencies {
  db: EvidenceDatabase;
}

export const requestBoardReportInputSchema = z
  .object({
    engagementId: z.uuid(),
    assessmentRunId: z.uuid(),
    title: z.string().trim().min(1).max(300),
    operationKey: z.uuid().optional(),
  })
  .strict();

export type RequestBoardReportInput = z.infer<typeof requestBoardReportInputSchema>;

export const generateBoardReportDraftInputSchema = z
  .object({
    requestId: z.uuid(),
  })
  .strict();

export type GenerateBoardReportDraftInput = z.infer<typeof generateBoardReportDraftInputSchema>;

export class BoardReportService {
  constructor(private readonly db: EvidenceDatabase) {}

  private async rpc(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    const query = this.db.rpc(name, args);
    const { data, error } = signal ? await query.abortSignal(signal) : await query;
    if (error) {
      throw new EvidenceError('report_storage_unavailable', 503);
    }
    return data as Record<string, unknown>;
  }

  async requestBoardReport(
    tenantId: string,
    actorId: string,
    input: RequestBoardReportInput,
    correlationId: string = randomUUID(),
    signal?: AbortSignal,
  ) {
    const operationKey = input.operationKey ?? randomUUID();
    const result = await this.rpc(
      'request_board_report',
      {
        p_tenant_id: tenantId,
        p_actor_id: actorId,
        p_operation_key: operationKey,
        p_engagement_id: input.engagementId,
        p_assessment_run_id: input.assessmentRunId,
        p_title: input.title,
        p_correlation_id: correlationId,
      },
      signal,
    );

    if (result.error) {
      if (result.error === 'forbidden') throw new EvidenceError('forbidden', 403);
      if (result.error === 'assessment_not_found')
        throw new EvidenceError('assessment_not_found', 404);
      if (result.error === 'assessment_not_finalized')
        throw new EvidenceError('assessment_not_finalized', 409);
      throw new EvidenceError('invalid_request', 400);
    }

    return result;
  }

  async generateDraft(
    tenantId: string,
    actorId: string,
    requestId: string,
    correlationId: string = randomUUID(),
    signal?: AbortSignal,
  ) {
    // 1. Fetch board report request
    let reqQuery = this.db
      .from('board_report_requests')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('id', requestId);
    if (signal) reqQuery = reqQuery.abortSignal(signal);
    const reqRes = await reqQuery.maybeSingle();

    if (reqRes.error || !reqRes.data) {
      throw new EvidenceError('request_not_found', 404);
    }

    const requestRow = reqRes.data;

    // 2. Fetch finalized assessment packet
    let pktQuery = this.db
      .from('workload_assessment_packets')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('run_id', requestRow.assessment_run_id);
    if (signal) pktQuery = pktQuery.abortSignal(signal);
    const pktRes = await pktQuery.maybeSingle();

    if (pktRes.error || !pktRes.data) {
      throw new EvidenceError('assessment_not_found', 404);
    }

    const pktRow = pktRes.data;
    const source = z
      .object({
        run_id: z.uuid(),
        engagement_id: z.uuid(),
        finalized_at: z.string().datetime(),
        finalized_receipt: z.union([
          z.number().int().positive(),
          z.string().regex(/^[1-9][0-9]*$/),
        ]),
        result_digest: z.string().regex(/^[0-9a-f]{64}$/),
        library_digest: z.string().regex(/^[0-9a-f]{64}$/),
        library_version: z.string().min(1),
        controls: z
          .array(
            z.object({
              id: z.string().min(1),
              title: z.string().min(1),
              domain: z.string().min(1),
              severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
              remediation_patterns: z.array(z.string()).optional(),
            }),
          )
          .min(1)
          .max(500),
        result: z.object({
          library_version: z.string().min(1),
          posture_score: z.number().finite().min(0).max(100),
          estimated_exposure_inr: z.number().int().safe().nonnegative(),
          findings: z
            .array(
              z.object({
                control_id: z.string().min(1),
                score: z.number().finite().min(0).max(100),
                rationale: z.string().min(1),
              }),
            )
            .min(1)
            .max(500),
        }),
      })
      .safeParse(pktRow);
    if (!source.success) throw new EvidenceError('assessment_source_incomplete', 409);
    const packet = source.data;
    if (
      packet.run_id !== requestRow.assessment_run_id ||
      packet.engagement_id !== requestRow.engagement_id ||
      packet.result_digest !== requestRow.assessment_result_digest ||
      packet.library_digest !== requestRow.library_digest ||
      packet.library_version !== requestRow.library_version ||
      packet.result.library_version !== packet.library_version ||
      packet.controls.length !== packet.result.findings.length
    ) {
      throw new EvidenceError('assessment_source_conflict', 409);
    }
    const controls = new Map(packet.controls.map((control) => [control.id, control]));
    const findingIds = new Set(packet.result.findings.map((finding) => finding.control_id));
    if (
      controls.size !== packet.controls.length ||
      findingIds.size !== controls.size ||
      [...findingIds].some((id) => !controls.has(id))
    ) {
      throw new EvidenceError('assessment_source_conflict', 409);
    }
    const postureScore = packet.result.posture_score;
    const exposureInr = packet.result.estimated_exposure_inr;
    const findings = packet.result.findings.map((finding) => {
      const control = controls.get(finding.control_id)!;
      return {
        control_id: finding.control_id,
        domain: control.domain,
        severity: control.severity,
        title: control.title,
        score: finding.score,
        gap_summary: finding.rationale,
        remediation_recommendation:
          control.remediation_patterns?.[0] ||
          'No remediation pattern is recorded in the frozen control library.',
      };
    });

    const criticalCount = findings.filter((f) => f.score < 80 && f.severity === 'critical').length;
    const highCount = findings.filter((f) => f.score < 80 && f.severity === 'high').length;
    const totalControls = packet.controls.length;
    const passedControls = findings.filter((f) => f.score >= 80).length;

    // Construct BoardReportContentV1 payload
    const contentPayload: BoardReportContentV1 = {
      schema_version: 1,
      kind: 'board_report',
      title: requestRow.title,
      tenant_id: tenantId,
      engagement_id: requestRow.engagement_id,
      assessment_run_id: requestRow.assessment_run_id,
      assessment_result_digest: requestRow.assessment_result_digest,
      library_version: requestRow.library_version,
      library_digest: requestRow.library_digest,
      generated_at: new Date().toISOString(),
      branding: {
        product: 'Axiom Proof',
        company: 'Axiom Minds Private Limited',
        company_url: 'https://axiomminds.ai',
      },
      executive_summary: {
        posture_score: postureScore,
        total_controls: totalControls,
        passed_controls: passedControls,
        failed_controls: totalControls - passedControls,
        critical_gaps: criticalCount,
        high_gaps: highCount,
        medium_gaps: findings.filter((f) => f.score < 80 && f.severity === 'medium').length,
        low_gaps: findings.filter((f) => f.score < 80 && f.severity === 'low').length,
        estimated_exposure_inr: exposureInr,
        narrative: `This report summarizes the recorded assessment for ${requestRow.title}. The computed posture score is ${postureScore}%. Evidence requirements in the control library do not establish that evidence was collected or independently verified.`,
      },
      key_findings: findings,
      action_plan: [],
      signatures: {
        prepared_by: {
          name: 'Prativedan (Axiom Reporting Agent)',
          role: 'Autonomous Compliance Synthesizer',
          agent: 'prativedan',
        },
        approved_by: null,
      },
    };

    // Render HTML
    const htmlText = renderBoardReportHtml(contentPayload);
    const contentText = JSON.stringify(contentPayload);

    // Call RPC record_board_report_draft
    const draftRes = await this.rpc(
      'record_board_report_draft',
      {
        p_tenant_id: tenantId,
        p_actor_id: actorId,
        p_request_id: requestId,
        p_content_text: contentText,
        p_html_text: htmlText,
        p_correlation_id: correlationId,
      },
      signal,
    );

    if (draftRes.error) {
      if (draftRes.error === 'founder_authority_required')
        throw new EvidenceError('forbidden', 403);
      if (draftRes.error === 'request_not_found') throw new EvidenceError('request_not_found', 404);
      throw new EvidenceError('invalid_request', 400);
    }

    const reportId = String(draftRes.reportId);

    return {
      reportId,
      requestId,
      status: 'draft',
      contentHash: draftRes.contentHash,
      replayed: draftRes.replayed,
    };
  }

  async getReportPdf(tenantId: string, actorId: string, reportId: string, signal?: AbortSignal) {
    // 1. Fetch artifacts row
    let artQuery = this.db
      .from('board_report_artifacts')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('report_id', reportId);
    if (signal) artQuery = artQuery.abortSignal(signal);
    const artRes = await artQuery.maybeSingle();

    if (artRes.error || !artRes.data) {
      throw new EvidenceError('report_not_found', 404);
    }

    // 2. Fetch report row for content_text
    let repQuery = this.db
      .from('reports')
      .select('title, content_text, status, created_by')
      .eq('tenant_id', tenantId)
      .eq('id', reportId);
    if (signal) repQuery = repQuery.abortSignal(signal);
    const repRes = await repQuery.maybeSingle();

    if (repRes.error || !repRes.data) {
      throw new EvidenceError('report_not_found', 404);
    }

    // Service-role reads bypass table RLS. Reapply the draft boundary before
    // rendering any bytes; only the draft creator may preview an unpublished PDF.
    if (repRes.data.status !== 'published' && repRes.data.created_by !== actorId) {
      throw new EvidenceError('report_not_found', 404);
    }

    // Render PDF from content or cached HTML
    const content = BoardReportContentV1Schema.parse(JSON.parse(repRes.data.content_text));
    const html = renderBoardReportHtml(content);
    const pdf = await renderHtmlToPdf(html);

    return {
      pdfBuffer: pdf.pdfBuffer,
      sha256: pdf.sha256,
      byteLength: pdf.byteLength,
      title: repRes.data.title,
    };
  }

  async listRequests(
    tenantId: string,
    actorId: string,
    options: { limit?: number; offset?: number } = {},
    signal?: AbortSignal,
  ) {
    const limit = options.limit ?? 25;
    const offset = options.offset ?? 0;

    const query = this.db
      .from('board_report_requests')
      .select('*', { count: 'exact' })
      .eq('tenant_id', tenantId)
      .eq('requested_by', actorId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    const { data, error, count } = signal ? await query.abortSignal(signal) : await query;
    if (error) {
      throw new EvidenceError('report_storage_unavailable', 503);
    }

    return {
      requests: data ?? [],
      total: count ?? data?.length ?? 0,
      limit,
      offset,
    };
  }
}
