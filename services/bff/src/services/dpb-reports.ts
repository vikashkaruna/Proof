import { createStatutoryProofWriter } from '@axiom/supabase';
/** DPB review packs are deterministic manifests over recorded, frozen breach data. */
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { buildDpbReviewContent } from '@axiom/report-kit/dpb-source';
import { EvidenceError, type EvidenceDatabase } from './evidence-ingestion.js';
import { DpbArtifactService } from './dpb-artifacts.js';

const uuid = z.uuid();
const hash = z.string().regex(/^[0-9a-f]{64}$/);
export const requestDpbInputSchema = z
  .object({
    breachId: uuid,
    notificationId: uuid,
    title: z.string().trim().min(1).max(300),
    operationKey: uuid.optional(),
  })
  .strict();
const requestSchema = z.object({
  id: uuid,
  tenant_id: uuid,
  breach_id: uuid,
  notification_id: uuid,
  title: z.string().min(1),
  status: z.string(),
  report_id: uuid.nullable(),
});
const sourceSchema = z.object({ source_text: z.string().min(1), source_sha256: hash });

export class DpbReportService {
  constructor(
    private readonly db: EvidenceDatabase,
    private readonly writer: () => Pick<EvidenceDatabase, 'rpc'> = createStatutoryProofWriter,
  ) {}

  async listRequests(
    tenantId: string,
    actorId: string,
    limit: number,
    offset: number,
    signal?: AbortSignal,
  ) {
    await this.role(tenantId, actorId, false, signal);
    const founder = await this.isInternalFounder(tenantId, actorId, signal);
    let query = this.db
      .from('dpb_report_requests')
      .select('id,breach_id,notification_id,title,status,report_id,requested_by,created_at', {
        count: 'exact',
      })
      .eq('tenant_id', tenantId);
    if (!founder) query = query.eq('requested_by', actorId);
    query = query.order('created_at', { ascending: false }).range(offset, offset + limit - 1);
    if (signal) query = query.abortSignal(signal);
    const result = await query;
    if (result.error) throw new EvidenceError('report_storage_unavailable', 503);
    const parsed = z
      .array(
        z.object({
          id: uuid,
          breach_id: uuid,
          notification_id: uuid,
          title: z.string(),
          status: z.string(),
          report_id: uuid.nullable(),
          requested_by: uuid,
          created_at: z.string(),
        }),
      )
      .max(limit)
      .safeParse(result.data ?? []);
    if (!parsed.success) throw new EvidenceError('invalid_report_record', 503);
    const visible = parsed.data;
    const ids = visible.map((r) => r.report_id).filter((v): v is string => v !== null);
    let reports: Array<{ id: string; status: string; content_sha256: string }> = [];
    if (ids.length) {
      let reportsQuery = this.db
        .from('reports')
        .select('id,kind,generated_by_agent,status,content_sha256')
        .eq('tenant_id', tenantId)
        .in('id', ids)
        .range(0, limit - 1);
      if (signal) reportsQuery = reportsQuery.abortSignal(signal);
      const reportResult = await reportsQuery;
      if (reportResult.error) throw new EvidenceError('report_storage_unavailable', 503);
      const checked = z
        .array(
          z.object({
            id: uuid,
            kind: z.literal('dpb'),
            generated_by_agent: z.literal('dpb-report-builder'),
            status: z.string(),
            content_sha256: hash,
          }),
        )
        .max(limit)
        .safeParse(reportResult.data ?? []);
      if (!checked.success || checked.data.length !== ids.length)
        throw new EvidenceError('invalid_report_record', 503);
      reports = checked.data;
    }
    const byId = new Map(reports.map((r) => [r.id, r]));
    let builds: Array<{
      id: string;
      report_id: string;
      status: 'pending' | 'settled';
      operation_key: string;
      last_error_code: string | null;
    }> = [];
    if (ids.length) {
      let buildQuery = this.db
        .from('dpb_artifact_builds')
        .select('id,report_id,status,operation_key,last_error_code')
        .eq('tenant_id', tenantId)
        .in('report_id', ids)
        .range(0, limit - 1);
      if (signal) buildQuery = buildQuery.abortSignal(signal);
      const buildResult = await buildQuery;
      if (buildResult.error) throw new EvidenceError('report_storage_unavailable', 503);
      const checked = z
        .array(
          z.object({
            id: uuid,
            report_id: uuid,
            status: z.enum(['pending', 'settled']),
            operation_key: uuid,
            last_error_code: z.string().nullable(),
          }),
        )
        .max(limit)
        .safeParse(buildResult.data ?? []);
      if (
        !checked.success ||
        new Set(checked.data.map((row) => row.report_id)).size !== checked.data.length
      )
        throw new EvidenceError('invalid_report_record', 503);
      builds = checked.data;
    }
    let pdfs: Array<{
      build_id: string;
      content_hash: string;
      byte_size: number;
      retain_until: string;
    }> = [];
    if (builds.length) {
      let pdfQuery = this.db
        .from('dpb_artifact_versions')
        .select('build_id,artifact_kind,content_hash,byte_size,retain_until')
        .eq('tenant_id', tenantId)
        .eq('artifact_kind', 'dpb_pdf')
        .in(
          'build_id',
          builds.map((row) => row.id),
        )
        .range(0, limit - 1);
      if (signal) pdfQuery = pdfQuery.abortSignal(signal);
      const pdfResult = await pdfQuery;
      if (pdfResult.error) throw new EvidenceError('report_storage_unavailable', 503);
      const checked = z
        .array(
          z.object({
            build_id: uuid,
            artifact_kind: z.literal('dpb_pdf'),
            content_hash: hash,
            byte_size: z.number().int().positive(),
            retain_until: z.string(),
          }),
        )
        .max(limit)
        .safeParse(pdfResult.data ?? []);
      if (
        !checked.success ||
        new Set(checked.data.map((row) => row.build_id)).size !== checked.data.length
      )
        throw new EvidenceError('invalid_report_record', 503);
      pdfs = checked.data;
    }
    const buildByReport = new Map(builds.map((row) => [row.report_id, row]));
    const pdfByBuild = new Map(pdfs.map((row) => [row.build_id, row]));
    return {
      requests: visible.map((r) => {
        const report = r.report_id ? byId.get(r.report_id) : null;
        const build = r.report_id ? buildByReport.get(r.report_id) : null;
        const pdf = build ? pdfByBuild.get(build.id) : null;
        return {
          requestId: r.id,
          breachId: r.breach_id,
          notificationId: r.notification_id,
          title: r.title,
          status: r.status,
          reportId: r.report_id,
          reportStatus: report?.status ?? null,
          contentHash: founder && report ? report.content_sha256 : null,
          artifact: report
            ? {
                reportStatus: report.status,
                status: build?.status ?? 'not_started',
                operationKey: founder ? (build?.operation_key ?? null) : null,
                lastErrorCode: founder ? (build?.last_error_code ?? null) : null,
                pdf:
                  pdf && (founder || report.status === 'published')
                    ? {
                        sha256: pdf.content_hash,
                        byteSize: pdf.byte_size,
                        retainUntil: pdf.retain_until,
                      }
                    : null,
              }
            : null,
          createdAt: r.created_at,
        };
      }),
      total: result.count ?? visible.length,
      limit,
      offset,
    };
  }

  private async isInternalFounder(tenantId: string, actorId: string, signal?: AbortSignal) {
    let member = this.db
      .from('tenant_users')
      .select('role')
      .eq('tenant_id', tenantId)
      .eq('user_id', actorId);
    if (signal) member = member.abortSignal(signal);
    const result = await member.maybeSingle();
    if (result.error) throw new EvidenceError('report_storage_unavailable', 503);
    if (result.data?.role !== 'founder') return false;
    let user = this.db.from('users').select('is_axiom_internal').eq('id', actorId);
    if (signal) user = user.abortSignal(signal);
    const u = await user.maybeSingle();
    if (u.error) throw new EvidenceError('report_storage_unavailable', 503);
    return u.data?.is_axiom_internal === true;
  }

  private async role(tenantId: string, actorId: string, founder: boolean, signal?: AbortSignal) {
    let query = this.db
      .from('tenant_users')
      .select('role')
      .eq('tenant_id', tenantId)
      .eq('user_id', actorId);
    if (signal) query = query.abortSignal(signal);
    const { data, error } = await query.maybeSingle();
    if (error) throw new EvidenceError('report_storage_unavailable', 503);
    if (
      !data ||
      (founder ? data.role !== 'founder' : !['owner', 'admin', 'founder'].includes(data.role))
    )
      throw new EvidenceError('forbidden', 403);
    if (data.role === 'founder') {
      let userQuery = this.db.from('users').select('is_axiom_internal').eq('id', actorId);
      if (signal) userQuery = userQuery.abortSignal(signal);
      const user = await userQuery.maybeSingle();
      if (user.error) throw new EvidenceError('report_storage_unavailable', 503);
      if (user.data?.is_axiom_internal !== true) throw new EvidenceError('forbidden', 403);
    }
  }

  private async rpc(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    let query = this.writer().rpc(name, args);
    if (signal) query = query.abortSignal(signal);
    const { data, error } = await query;
    if (error) throw new EvidenceError('report_persistence_unconfirmed', 503);
    const parsed = z.record(z.string(), z.unknown()).safeParse(data);
    if (!parsed.success) throw new EvidenceError('invalid_report_record', 503);
    if (typeof parsed.data.error === 'string') throw new EvidenceError(parsed.data.error, 409);
    return parsed.data;
  }

  async request(
    tenantId: string,
    actorId: string,
    input: z.infer<typeof requestDpbInputSchema>,
    signal?: AbortSignal,
  ) {
    await this.role(tenantId, actorId, false, signal);
    const result = await this.rpc(
      'request_dpb_report',
      {
        p_tenant_id: tenantId,
        p_actor_id: actorId,
        p_operation_key: input.operationKey ?? randomUUID(),
        p_breach_id: input.breachId,
        p_notification_id: input.notificationId,
        p_title: input.title,
        p_correlation_id: randomUUID(),
      },
      signal,
    );
    return z
      .object({
        requestId: uuid,
        reportId: uuid.nullable(),
        status: z.string(),
        replayed: z.boolean(),
      })
      .parse(result);
  }

  async draft(tenantId: string, actorId: string, requestId: string, signal?: AbortSignal) {
    await this.role(tenantId, actorId, true, signal);
    let requestQuery = this.db
      .from('dpb_report_requests')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('id', requestId);
    if (signal) requestQuery = requestQuery.abortSignal(signal);
    const requestResult = await requestQuery.maybeSingle();
    if (requestResult.error) throw new EvidenceError('report_storage_unavailable', 503);
    if (!requestResult.data) throw new EvidenceError('request_not_found', 404);
    const request = requestSchema.safeParse(requestResult.data);
    if (!request.success) throw new EvidenceError('invalid_report_record', 503);
    let sourceQuery = this.db
      .from('dpb_request_sources')
      .select('source_text,source_sha256')
      .eq('tenant_id', tenantId)
      .eq('request_id', requestId);
    if (signal) sourceQuery = sourceQuery.abortSignal(signal);
    const sourceResult = await sourceQuery.maybeSingle();
    if (sourceResult.error) throw new EvidenceError('report_storage_unavailable', 503);
    const source = sourceSchema.safeParse(sourceResult.data);
    if (!source.success) throw new EvidenceError('source_not_found', 409);
    let documentText: string;
    try {
      const content = buildDpbReviewContent({
        sourceText: source.data.source_text,
        sourceSha256: source.data.source_sha256,
        requestId,
        tenantId,
        title: request.data.title,
      });
      documentText = JSON.stringify(content);
    } catch {
      throw new EvidenceError('source_binding_mismatch', 409);
    }
    await this.role(tenantId, actorId, true, signal);
    const result = await this.rpc(
      'record_dpb_report_draft',
      {
        p_tenant_id: tenantId,
        p_actor_id: actorId,
        p_request_id: requestId,
        p_content_text: documentText,
        p_correlation_id: randomUUID(),
      },
      signal,
    );
    const parsed = z
      .object({
        requestId: uuid,
        reportId: uuid,
        status: z.string(),
        contentHash: hash,
        replayed: z.boolean(),
      })
      .parse(result);
    if (parsed.contentHash !== createHash('sha256').update(documentText).digest('hex'))
      throw new EvidenceError('report_persistence_unconfirmed', 503);
    return parsed;
  }

  /** Reviewers inspect the exact frozen bytes before approving their digest. */
  async source(tenantId: string, actorId: string, requestId: string, signal?: AbortSignal) {
    await this.role(tenantId, actorId, true, signal);
    let requestQuery = this.db
      .from('dpb_report_requests')
      .select('id,report_id')
      .eq('tenant_id', tenantId)
      .eq('id', requestId);
    if (signal) requestQuery = requestQuery.abortSignal(signal);
    const request = await requestQuery.maybeSingle();
    if (request.error) throw new EvidenceError('report_storage_unavailable', 503);
    if (!request.data) throw new EvidenceError('request_not_found', 404);
    let sourceQuery = this.db
      .from('dpb_request_sources')
      .select('source_text,source_sha256')
      .eq('tenant_id', tenantId)
      .eq('request_id', requestId);
    if (signal) sourceQuery = sourceQuery.abortSignal(signal);
    const result = await sourceQuery.maybeSingle();
    if (result.error) throw new EvidenceError('report_storage_unavailable', 503);
    const parsed = sourceSchema.safeParse(result.data);
    if (
      !parsed.success ||
      createHash('sha256').update(parsed.data.source_text).digest('hex') !==
        parsed.data.source_sha256
    )
      throw new EvidenceError('source_binding_mismatch', 409);
    return { sourceText: parsed.data.source_text, sourceSha256: parsed.data.source_sha256 };
  }

  async release(
    tenantId: string,
    actorId: string,
    reportId: string,
    expectedContentHash: string,
    expectedPdfHash: string,
    artifacts: DpbArtifactService,
    signal?: AbortSignal,
  ) {
    await this.role(tenantId, actorId, true, signal);
    const pdf = await artifacts.pdf(tenantId, actorId, reportId, signal);
    if (pdf.sha256 !== expectedPdfHash) throw new EvidenceError('artifact_mismatch', 409);
    await this.role(tenantId, actorId, true, signal);
    const result = await this.rpc(
      'release_dpb_report',
      {
        p_tenant_id: tenantId,
        p_report_id: reportId,
        p_actor_id: actorId,
        p_expected_content_hash: expectedContentHash,
        p_expected_pdf_hash: expectedPdfHash,
        p_correlation_id: randomUUID(),
      },
      signal,
    );
    return z
      .object({ reportId: uuid, status: z.literal('published'), replayed: z.boolean() })
      .parse(result);
  }
}
