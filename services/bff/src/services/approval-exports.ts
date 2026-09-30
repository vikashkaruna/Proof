/**
 * Approval Export Service.
 * Implements querying, formatting, PDF/HTML/JSON/CSV generation,
 * and ledgering of bounded snapshots of stored approval tokens.
 */
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { authorize, Capability, type UserRole } from '@axiom/types';
import {
  BRANDING,
  ApprovalHistoryExportContentV1Schema,
  type ApprovalHistoryExportContentV1,
  type ApprovalRecordItem,
  renderApprovalHistoryHtml,
  renderHtmlToPdf,
} from '@axiom/report-kit';
import { EvidenceError, type EvidenceDatabase, uuidSchema } from './evidence-ingestion.js';

export const listApprovalHistoryInputSchema = z
  .object({
    planId: uuidSchema.optional(),
    status: z.enum(['issued', 'consumed', 'revoked', 'expired', 'invalid']).optional(),
    mode: z.enum(['batch', 'individual']).optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export type ListApprovalHistoryInput = z.infer<typeof listApprovalHistoryInputSchema>;

export const exportApprovalHistoryInputSchema = z
  .object({
    planId: uuidSchema.optional(),
    format: z.enum(['json', 'html', 'pdf', 'csv']).default('json'),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(200),
  })
  .strict();

export type ExportApprovalHistoryInput = z.infer<typeof exportApprovalHistoryInputSchema>;

function escapeCsvField(val: unknown): string {
  if (val === null || val === undefined) return '';
  let str = String(val);
  // Spreadsheet applications may execute formulas even when a cell is quoted.
  // Prefixing the value inside the quoted cell preserves the visible source.
  if (/^[\s\u0000-\u001f]*[=+\-@]/u.test(str)) str = `'${str}`;
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export class ApprovalExportService {
  constructor(private readonly db: EvidenceDatabase) {}

  private async assertLiveAccess(
    tenantId: string,
    actorId: string,
    capability: Capability,
    signal?: AbortSignal,
  ) {
    const query = this.db
      .from('tenant_users')
      .select('role')
      .eq('tenant_id', tenantId)
      .eq('user_id', actorId);
    const withSignal =
      signal && typeof query.abortSignal === 'function' ? query.abortSignal(signal) : query;
    const { data, error } = await withSignal.maybeSingle();
    if (error) throw new EvidenceError('export_storage_unavailable', 503);
    if (
      !data ||
      typeof data.role !== 'string' ||
      !authorize(capability, { role: data.role as UserRole }).allowed
    ) {
      throw new EvidenceError('export_forbidden', 403);
    }
  }

  private async rpc(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    const query = this.db.rpc(name, args) as unknown as {
      abortSignal?: (sig: AbortSignal) => Promise<{ data: unknown; error: unknown }>;
    };
    const { data, error } =
      signal && typeof query?.abortSignal === 'function'
        ? await query.abortSignal(signal)
        : await (query as unknown as Promise<{ data: unknown; error: unknown }>);

    if (error) {
      throw new EvidenceError('export_storage_unavailable', 503);
    }
    return data as Record<string, unknown>;
  }

  async listApprovalHistory(
    tenantId: string,
    actorId: string,
    input: ListApprovalHistoryInput,
    signal?: AbortSignal,
  ) {
    await this.assertLiveAccess(tenantId, actorId, Capability.PLAN_READ, signal);
    const limit = input.limit ?? 50;
    const offset = input.offset ?? 0;

    let query = this.db
      .from('approval_tokens')
      .select('*', { count: 'exact' })
      .eq('tenant_id', tenantId);

    if (input.planId) query = query.eq('plan_id', input.planId);
    if (input.status) query = query.eq('status', input.status);
    if (input.mode) query = query.eq('mode', input.mode);
    if (input.from) query = query.gte('issued_at', input.from);
    if (input.to) query = query.lte('issued_at', input.to);

    query = query.order('issued_at', { ascending: false }).range(offset, offset + limit - 1);

    const queryWithSignal =
      signal &&
      typeof (query as unknown as { abortSignal?: (s: AbortSignal) => unknown }).abortSignal ===
        'function'
        ? (query as unknown as { abortSignal: (s: AbortSignal) => typeof query }).abortSignal(
            signal,
          )
        : query;

    const {
      data: tokens,
      error,
      count,
    } = (await queryWithSignal) as unknown as {
      data: Array<Record<string, unknown>> | null;
      error: unknown;
      count: number | null;
    };

    if (error || !Array.isArray(tokens) || typeof count !== 'number') {
      throw new EvidenceError('export_storage_unavailable', 503);
    }

    const enriched = await this.enrichApprovalRecords(tenantId, tokens, signal);

    return {
      items: enriched,
      total: count,
      limit,
      offset,
    };
  }

  private async enrichApprovalRecords(
    tenantId: string,
    tokens: Array<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<ApprovalRecordItem[]> {
    if (tokens.length === 0) return [];

    const planIds = Array.from(new Set(tokens.map((t) => t.plan_id as string).filter(Boolean)));
    const approverIds = Array.from(
      new Set(tokens.map((t) => t.approver_id as string).filter(Boolean)),
    );
    const allActionIds = Array.from(
      new Set(
        tokens.flatMap((t) => (Array.isArray(t.action_ids) ? (t.action_ids as string[]) : [])),
      ),
    );

    // Fetch related plans
    const planMap = new Map<string, { title: string; version: number }>();
    if (planIds.length > 0) {
      const pq = this.db
        .from('remediation_plans')
        .select('id, title, version')
        .eq('tenant_id', tenantId)
        .in('id', planIds);
      const queryWithSignal =
        signal &&
        typeof (pq as unknown as { abortSignal?: (s: AbortSignal) => unknown }).abortSignal ===
          'function'
          ? (pq as unknown as { abortSignal: (s: AbortSignal) => typeof pq }).abortSignal(signal)
          : pq;
      const { data: plans, error } = (await queryWithSignal) as unknown as {
        data: Array<{ id: string; title: string; version: number }> | null;
        error: unknown;
      };
      if (error || !Array.isArray(plans))
        throw new EvidenceError('export_storage_unavailable', 503);
      for (const p of plans ?? []) {
        planMap.set(p.id, { title: p.title, version: p.version });
      }
    }

    // Fetch related approver users
    const userMap = new Map<string, { full_name?: string; email?: string }>();
    if (approverIds.length > 0) {
      const uq = this.db.from('users').select('id, full_name, email').in('id', approverIds);
      const queryWithSignal =
        signal &&
        typeof (uq as unknown as { abortSignal?: (s: AbortSignal) => unknown }).abortSignal ===
          'function'
          ? (uq as unknown as { abortSignal: (s: AbortSignal) => typeof uq }).abortSignal(signal)
          : uq;
      const { data: users, error } = (await queryWithSignal) as unknown as {
        data: Array<{ id: string; full_name?: string; email?: string }> | null;
        error: unknown;
      };
      if (error || !Array.isArray(users))
        throw new EvidenceError('export_storage_unavailable', 503);
      for (const u of users ?? []) {
        userMap.set(u.id, { full_name: u.full_name, email: u.email });
      }
    }

    // Fetch related actions
    const actionMap = new Map<
      string,
      { action_type: string; dry_run_status: string; rollback_validated: boolean }
    >();
    if (allActionIds.length > 0) {
      const aq = this.db
        .from('remediation_actions')
        .select('id, action_type, dry_run_status, rollback_validated')
        .eq('tenant_id', tenantId)
        .in('id', allActionIds);
      const queryWithSignal =
        signal &&
        typeof (aq as unknown as { abortSignal?: (s: AbortSignal) => unknown }).abortSignal ===
          'function'
          ? (aq as unknown as { abortSignal: (s: AbortSignal) => typeof aq }).abortSignal(signal)
          : aq;
      const { data: actions, error } = (await queryWithSignal) as unknown as {
        data: Array<{
          id: string;
          action_type: string;
          dry_run_status: string;
          rollback_validated: boolean;
        }> | null;
        error: unknown;
      };
      if (error || !Array.isArray(actions))
        throw new EvidenceError('export_storage_unavailable', 503);
      for (const a of actions ?? []) {
        actionMap.set(a.id, {
          action_type: a.action_type,
          dry_run_status: a.dry_run_status,
          rollback_validated: a.rollback_validated,
        });
      }
    }

    return tokens.map((row) => {
      const pId = row.plan_id;
      const appId = row.approver_id;
      const actionIds = row.action_ids;
      if (
        typeof row.id !== 'string' ||
        typeof pId !== 'string' ||
        typeof appId !== 'string' ||
        !Array.isArray(actionIds) ||
        actionIds.length === 0 ||
        !actionIds.every((id) => typeof id === 'string') ||
        !['batch', 'individual'].includes(String(row.mode)) ||
        !['issued', 'consumed', 'revoked', 'expired', 'invalid'].includes(String(row.status)) ||
        typeof row.issued_at !== 'string' ||
        typeof row.expires_at !== 'string' ||
        !Number.isFinite(Date.parse(row.issued_at)) ||
        !Number.isFinite(Date.parse(row.expires_at))
      ) {
        throw new EvidenceError('approval_export_source_incomplete', 409);
      }
      if (actionIds.some((id) => !actionMap.has(id))) {
        throw new EvidenceError('approval_export_source_incomplete', 409);
      }

      const planInfo = planMap.get(pId);
      const userInfo = userMap.get(appId);
      if (!planInfo || !userInfo) {
        throw new EvidenceError('approval_export_source_incomplete', 409);
      }

      const actionTypes = Array.from(
        new Set(actionIds.map((aid) => actionMap.get(aid)!.action_type)),
      );

      const dryRunVerified =
        actionIds.length > 0
          ? actionIds.every((aid) => {
              const act = actionMap.get(aid);
              return act?.dry_run_status === 'dry_run_complete';
            })
          : false;

      const rollbackValidated =
        actionIds.length > 0
          ? actionIds.every((aid) => actionMap.get(aid)?.rollback_validated === true)
          : false;

      const sig = typeof row.signature === 'string' ? row.signature : '';
      const signaturePreview = sig.length > 0 ? sig.slice(0, 32) : null;

      return {
        token_id: row.id,
        plan_id: pId,
        plan_title: planInfo?.title ?? null,
        plan_version: typeof planInfo?.version === 'number' ? planInfo.version : null,
        approver_id: appId,
        approver_name: userInfo?.full_name ?? userInfo?.email ?? null,
        approver_role: null,
        approval_scopes: null,
        mode: row.mode as 'batch' | 'individual',
        action_count: actionIds.length,
        action_types: actionTypes,
        dry_run_verified: dryRunVerified,
        dry_run_status:
          actionIds.length === 1 ? actionMap.get(actionIds[0]!)!.dry_run_status : null,
        rollback_validated: rollbackValidated,
        reconciliation_statement: null,
        approval_reason: typeof row.reason === 'string' ? row.reason : null,
        status: row.status as 'issued' | 'consumed' | 'revoked' | 'expired' | 'invalid',
        issued_at: new Date(row.issued_at).toISOString(),
        expires_at: new Date(row.expires_at).toISOString(),
        consumed_at:
          typeof row.consumed_at === 'string' ? new Date(row.consumed_at).toISOString() : null,
        revoked_at:
          typeof row.revoked_at === 'string' ? new Date(row.revoked_at).toISOString() : null,
        signature_preview: signaturePreview,
      };
    });
  }

  async exportApprovalHistory(
    tenantId: string,
    actorId: string,
    input: ExportApprovalHistoryInput,
    correlationId: string = randomUUID(),
    signal?: AbortSignal,
  ) {
    await this.assertLiveAccess(tenantId, actorId, Capability.EVIDENCE_EXPORT, signal);
    // 1. Fetch tenant name
    const tQuery = this.db.from('tenants').select('id, name').eq('id', tenantId);
    const queryWithSignal =
      signal &&
      typeof (tQuery as unknown as { abortSignal?: (s: AbortSignal) => unknown }).abortSignal ===
        'function'
        ? (tQuery as unknown as { abortSignal: (s: AbortSignal) => typeof tQuery }).abortSignal(
            signal,
          )
        : tQuery;

    const { data: tenantData, error: tenantError } = (
      typeof (queryWithSignal as unknown as { maybeSingle?: () => unknown }).maybeSingle ===
      'function'
        ? await (
            queryWithSignal as unknown as {
              maybeSingle: () => Promise<{ data: unknown; error: unknown }>;
            }
          ).maybeSingle()
        : await (queryWithSignal as unknown as Promise<{ data: unknown; error: unknown }>)
    ) as { data: { name?: string } | null; error: unknown };

    if (tenantError) throw new EvidenceError('export_storage_unavailable', 503);
    if (!tenantData || typeof tenantData.name !== 'string' || !tenantData.name) {
      throw new EvidenceError('approval_export_source_incomplete', 409);
    }
    const tenantName = tenantData.name;

    // 2. Fetch up to 200 records
    const limit = input.limit ?? 200;
    const listResult = await this.listApprovalHistory(
      tenantId,
      actorId,
      {
        planId: input.planId,
        from: input.from,
        to: input.to,
        limit,
        offset: 0,
      },
      signal,
    );

    const records = listResult.items;
    if (listResult.total > limit || listResult.total !== records.length) {
      throw new EvidenceError('approval_export_limit_exceeded', 409);
    }

    // 3. Compute summary statistics
    const summary = {
      total_records: records.length,
      active_approvals: records.filter((r) => r.status === 'issued').length,
      consumed_approvals: records.filter((r) => r.status === 'consumed').length,
      revoked_approvals: records.filter((r) => r.status === 'revoked').length,
      // Standing-policy provenance is not retained in the token row.
      standing_policy_approvals: null,
      batch_approvals: records.filter((r) => r.mode === 'batch').length,
      individual_approvals: records.filter((r) => r.mode === 'individual').length,
    };

    const exportContent: ApprovalHistoryExportContentV1 =
      ApprovalHistoryExportContentV1Schema.parse({
        schema_version: 1,
        kind: 'approval_history_export',
        export_id: randomUUID(),
        title: input.planId
          ? `Remediation Plan Stored Approval Tokens`
          : `DPDPA Fiduciary Stored Approval Tokens`,
        tenant_id: tenantId,
        tenant_name: tenantName,
        generated_at: new Date().toISOString(),
        branding: {
          product: BRANDING.product,
          company: BRANDING.company,
          company_url: BRANDING.company_url,
        },
        summary,
        source_context: {
          token_fields: 'stored_token_row',
          related_fields: 'current_database_values_at_export',
          issuance_role_and_scopes: 'not_retained',
          signature_verification: 'not_performed',
          vault_seal: 'not_performed',
        },
        approvals: records,
      });

    // 4. Generate artifact buffer & metadata by format
    let buffer: Buffer;
    let mimeType: string;
    let extension: string;

    switch (input.format) {
      case 'json': {
        const jsonStr = JSON.stringify(exportContent, null, 2);
        buffer = Buffer.from(jsonStr, 'utf-8');
        mimeType = 'application/json';
        extension = 'json';
        break;
      }
      case 'html': {
        const htmlStr = renderApprovalHistoryHtml(exportContent);
        buffer = Buffer.from(htmlStr, 'utf-8');
        mimeType = 'text/html';
        extension = 'html';
        break;
      }
      case 'pdf': {
        const htmlStr = renderApprovalHistoryHtml(exportContent);
        const pdf = await renderHtmlToPdf(htmlStr);
        buffer = pdf.pdfBuffer;
        mimeType = 'application/pdf';
        extension = 'pdf';
        break;
      }
      case 'csv': {
        const headers = [
          'token_id',
          'plan_id',
          'current_plan_title',
          'approver_id',
          'current_approver_display_name',
          'mode',
          'action_count',
          'current_action_types',
          'current_action_dry_run_status',
          'current_action_rollback_validated',
          'approval_reason',
          'status',
          'issued_at',
          'expires_at',
          'consumed_at',
          'revoked_at',
          'stored_signature_prefix_unverified',
        ];
        const lines = [headers.join(',')];
        for (const r of records) {
          lines.push(
            [
              escapeCsvField(r.token_id),
              escapeCsvField(r.plan_id),
              escapeCsvField(r.plan_title),
              escapeCsvField(r.approver_id),
              escapeCsvField(r.approver_name),
              escapeCsvField(r.mode),
              escapeCsvField(r.action_count),
              escapeCsvField(r.action_types.join('; ')),
              escapeCsvField(r.dry_run_status),
              escapeCsvField(r.rollback_validated),
              escapeCsvField(r.approval_reason),
              escapeCsvField(r.status),
              escapeCsvField(r.issued_at),
              escapeCsvField(r.expires_at),
              escapeCsvField(r.consumed_at),
              escapeCsvField(r.revoked_at),
              escapeCsvField(r.signature_preview),
            ].join(','),
          );
        }
        buffer = Buffer.from(lines.join('\n'), 'utf-8');
        mimeType = 'text/csv';
        extension = 'csv';
        break;
      }
    }

    const artifactSha256 = createHash('sha256').update(buffer).digest('hex');
    const artifactBytes = buffer.byteLength;

    // 5. Check live access again before recording and returning a sensitive download.
    await this.assertLiveAccess(tenantId, actorId, Capability.EVIDENCE_EXPORT, signal);
    // The recorder appends a ledger event; it does not seal these bytes in a vault.
    const rpcRes = await this.rpc(
      'record_approval_export',
      {
        p_tenant_id: tenantId,
        p_actor_id: actorId,
        p_plan_id: input.planId ?? null,
        p_format: input.format,
        p_filter_params: {
          planId: input.planId ?? null,
          from: input.from ?? null,
          to: input.to ?? null,
        },
        p_summary: summary,
        p_artifact_sha256: artifactSha256,
        p_artifact_bytes: artifactBytes,
        p_correlation_id: correlationId,
      },
      signal,
    );

    if (
      !rpcRes ||
      rpcRes.error ||
      rpcRes.status !== 'exported' ||
      typeof rpcRes.exportId !== 'string' ||
      rpcRes.artifactSha256 !== artifactSha256
    ) {
      throw new EvidenceError('approval_export_record_failed', 503);
    }
    await this.assertLiveAccess(tenantId, actorId, Capability.EVIDENCE_EXPORT, signal);
    const exportId = rpcRes.exportId;
    const filename = `approval-history-${tenantId.slice(0, 8)}-${Date.now()}.${extension}`;

    return {
      exportId,
      format: input.format,
      buffer,
      sha256: artifactSha256,
      bytes: artifactBytes,
      mimeType,
      filename,
      content: exportContent,
    };
  }
}
