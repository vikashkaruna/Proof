/**
 * Board Report Generation Service.
 * Implements manager-initiated request binding, deterministic draft synthesis,
 * deterministic draft HTML. Retained reviewed PDFs live in board-artifacts.
 */
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { BoardReportContentV1, renderBoardReportHtml } from '@axiom/report-kit/board-report';
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
  constructor(private readonly db: EvidenceDatabase, private readonly writerDb?: EvidenceDatabase) {}

  private async readRole(tenantId: string, actorId: string, signal?: AbortSignal) {
    let membership = this.db
      .from('tenant_users')
      .select('role')
      .eq('tenant_id', tenantId)
      .eq('user_id', actorId);
    if (signal) membership = membership.abortSignal(signal);
    const result = await membership.maybeSingle();
    if (result.error) throw new EvidenceError('report_storage_unavailable', 503);
    const role = result.data?.role;
    if (role !== 'founder' && role !== 'owner' && role !== 'admin')
      throw new EvidenceError('forbidden', 403);
    if (role === 'founder') {
      let user = this.db.from('users').select('is_axiom_internal').eq('id', actorId);
      if (signal) user = user.abortSignal(signal);
      const userResult = await user.maybeSingle();
      if (userResult.error) throw new EvidenceError('report_storage_unavailable', 503);
      if (userResult.data?.is_axiom_internal !== true) throw new EvidenceError('forbidden', 403);
    }
    return role;
  }

  async listAssessmentOptions(
    tenantId: string,
    actorId: string,
    options: { limit: number; offset: number },
    signal?: AbortSignal,
  ) {
    await this.readRole(tenantId, actorId, signal);
    const { limit, offset } = options;
    let query = this.db
      .from('workload_assessment_packets')
      .select('run_id,engagement_id,library_version,finalized_at,finalized_receipt', {
        count: 'exact',
      })
      .eq('tenant_id', tenantId)
      .gte('finalized_at', '1970-01-01T00:00:00Z')
      .order('finalized_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (signal) query = query.abortSignal(signal);
    const result = await query;
    if (result.error) throw new EvidenceError('report_storage_unavailable', 503);
    const parsed = z
      .array(
        z.object({
          run_id: z.uuid(),
          engagement_id: z.uuid(),
          library_version: z.string().min(1),
          finalized_at: z.string().datetime({ offset: true }),
          finalized_receipt: z.union([
            z.number().int().positive(),
            z.string().regex(/^[1-9][0-9]*$/),
          ]),
        }),
      )
      .max(limit)
      .safeParse(result.data ?? []);
    if (!parsed.success) throw new EvidenceError('invalid_report_record', 503);
    const engagementIds = [...new Set(parsed.data.map((row) => row.engagement_id))];
    let engagements: Array<{ id: string; title: string }> = [];
    if (engagementIds.length) {
      let titles = this.db
        .from('engagements')
        .select('id,title')
        .eq('tenant_id', tenantId)
        .in('id', engagementIds)
        .range(0, limit - 1);
      if (signal) titles = titles.abortSignal(signal);
      const titleResult = await titles;
      if (titleResult.error) throw new EvidenceError('report_storage_unavailable', 503);
      const titleRows = z
        .array(z.object({ id: z.uuid(), title: z.string() }))
        .max(limit)
        .safeParse(titleResult.data ?? []);
      if (!titleRows.success) throw new EvidenceError('invalid_report_record', 503);
      engagements = titleRows.data;
    }
    const titleById = new Map(engagements.map((row) => [row.id, row.title]));
    if (parsed.data.some((row) => !titleById.has(row.engagement_id)))
      throw new EvidenceError('invalid_report_record', 503);
    return {
      assessments: parsed.data.map((row) => ({
        assessmentRunId: row.run_id,
        engagementId: row.engagement_id,
        engagementTitle: titleById.get(row.engagement_id)!,
        finalizedAt: row.finalized_at,
        libraryVersion: row.library_version,
      })),
      total: result.count ?? 0,
      limit,
      offset,
    };
  }

  private async assertLiveFounder(tenantId: string, actorId: string, signal?: AbortSignal) {
    let membership = this.db
      .from('tenant_users')
      .select('role')
      .eq('tenant_id', tenantId)
      .eq('user_id', actorId);
    if (signal) membership = membership.abortSignal(signal);
    const memberResult = await membership.maybeSingle();
    if (memberResult.error) throw new EvidenceError('report_storage_unavailable', 503);
    if (memberResult.data?.role !== 'founder') throw new EvidenceError('forbidden', 403);

    let user = this.db.from('users').select('is_axiom_internal').eq('id', actorId);
    if (signal) user = user.abortSignal(signal);
    const userResult = await user.maybeSingle();
    if (userResult.error) throw new EvidenceError('report_storage_unavailable', 503);
    if (userResult.data?.is_axiom_internal !== true) throw new EvidenceError('forbidden', 403);
  }

  private async rpc(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    if (!this.writerDb) throw new EvidenceError('report_persistence_unconfirmed', 503);
    const query = this.writerDb.rpc(name, args);
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
    await this.assertLiveFounder(tenantId, actorId, signal);
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

    // 2. Render only the exact source frozen with the manager's request.
    // Legacy requests without this snapshot must be requested again.
    let pktQuery = this.db
      .from('board_request_sources')
      .select('source_text, source_sha256, controls_sha256, result_sha256')
      .eq('tenant_id', tenantId)
      .eq('request_id', requestId);
    if (signal) pktQuery = pktQuery.abortSignal(signal);
    const pktRes = await pktQuery.maybeSingle();

    if (pktRes.error) throw new EvidenceError('report_storage_unavailable', 503);
    if (!pktRes.data) {
      throw new EvidenceError('assessment_source_incomplete', 409);
    }

    const snapshot = z
      .object({
        source_text: z
          .string()
          .min(1)
          .max(4 * 1024 * 1024),
        source_sha256: z.string().regex(/^[0-9a-f]{64}$/),
        controls_sha256: z.string().regex(/^[0-9a-f]{64}$/),
        result_sha256: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .safeParse(pktRes.data);
    if (!snapshot.success) throw new EvidenceError('assessment_source_incomplete', 409);
    const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
    if (digest(snapshot.data.source_text) !== snapshot.data.source_sha256) {
      throw new EvidenceError('assessment_source_conflict', 409);
    }
    let frozenJson: unknown;
    try {
      frozenJson = JSON.parse(snapshot.data.source_text);
    } catch {
      throw new EvidenceError('assessment_source_incomplete', 409);
    }
    const frozen = z
      .object({
        schema_version: z.literal(1),
        serialization: z.literal('postgres-jsonb-text-v1'),
        kind: z.literal('board_source'),
        request_id: z.uuid(),
        tenant_id: z.uuid(),
        engagement_id: z.uuid(),
        assessment_run_id: z.uuid(),
        library_version: z.string().min(1),
        controls_text: z.string().min(1),
        controls_sha256: z.string().regex(/^[0-9a-f]{64}$/),
        result_text: z.string().min(1),
        result_sha256: z.string().regex(/^[0-9a-f]{64}$/),
        finalized_at: z.string().refine((value) => Number.isFinite(Date.parse(value))),
        receipts: z.object({
          finalized: z.object({ id: z.string().regex(/^[1-9][0-9]*$/) }),
        }),
      })
      .safeParse(frozenJson);
    if (!frozen.success) throw new EvidenceError('assessment_source_incomplete', 409);
    if (
      frozen.data.request_id !== requestId ||
      frozen.data.tenant_id !== tenantId ||
      frozen.data.engagement_id !== requestRow.engagement_id ||
      frozen.data.assessment_run_id !== requestRow.assessment_run_id ||
      frozen.data.library_version !== requestRow.library_version ||
      frozen.data.controls_sha256 !== snapshot.data.controls_sha256 ||
      frozen.data.result_sha256 !== snapshot.data.result_sha256 ||
      digest(frozen.data.controls_text) !== frozen.data.controls_sha256 ||
      digest(frozen.data.result_text) !== frozen.data.result_sha256
    ) {
      throw new EvidenceError('assessment_source_conflict', 409);
    }
    let frozenControls: unknown;
    let result: unknown;
    try {
      frozenControls = JSON.parse(frozen.data.controls_text);
      result = JSON.parse(frozen.data.result_text);
    } catch {
      throw new EvidenceError('assessment_source_incomplete', 409);
    }
    const pktRow = {
      run_id: frozen.data.assessment_run_id,
      engagement_id: frozen.data.engagement_id,
      finalized_at: new Date(frozen.data.finalized_at).toISOString(),
      finalized_receipt: frozen.data.receipts.finalized.id,
      result_digest: frozen.data.result_sha256,
      library_digest: frozen.data.controls_sha256,
      library_version: frozen.data.library_version,
      controls: frozenControls,
      result,
    };
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
      source_sha256: snapshot.data.source_sha256,
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
          name: 'Axiom Proof board report builder',
          role: 'Deterministic assessment renderer',
          agent: 'board-report-builder',
        },
        approved_by: null,
      },
    };

    // Render HTML
    const htmlText = renderBoardReportHtml(contentPayload);
    const contentText = JSON.stringify(contentPayload);

    // Call RPC record_board_report_draft
    await this.assertLiveFounder(tenantId, actorId, signal);
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
      if (draftRes.error === 'assessment_not_finalized')
        throw new EvidenceError('assessment_not_finalized', 409);
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

  async listRequests(
    tenantId: string,
    actorId: string,
    options: { limit: number; offset: number },
    signal?: AbortSignal,
  ) {
    const role = await this.readRole(tenantId, actorId, signal);
    const { limit, offset } = options;

    const query = this.db
      .from('board_report_requests')
      .select('id,engagement_id,assessment_run_id,report_id,title,status,created_at,updated_at', {
        count: 'exact',
      })
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (role !== 'founder') query.eq('requested_by', actorId);

    const { data, error, count } = signal ? await query.abortSignal(signal) : await query;
    if (error) {
      throw new EvidenceError('report_storage_unavailable', 503);
    }

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
        }),
      )
      .max(limit)
      .safeParse(data ?? []);
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
      total: count ?? 0,
      limit,
      offset,
    };
  }
}
