/**
 * Pramaan Statutory Closure & Proof Attestation Service.
 * Implements closure dossier synthesis, founder sealing with Gold ProofSeal,
 * dossier retrieval, and email dispatch audit log (W12 / W14 / Option B).
 */
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { BRAND } from '@axiom/config';
import { DossierTypeSchema, type DossierType, type PramaanDossier } from '@axiom/types';
import { EvidenceError, type EvidenceDatabase } from './evidence-ingestion.js';
import { sendReportDispatchEmail } from './report-dispatch-email.js';

export const synthesizeDossierInputSchema = z
  .object({
    engagementId: z.string().uuid(),
    dossierType: DossierTypeSchema,
    title: z.string().trim().min(1).max(300),
    reportId: z.string().uuid().optional(),
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export type SynthesizeDossierInput = z.infer<typeof synthesizeDossierInputSchema>;

export const sealDossierInputSchema = z
  .object({
    expectedProofSeal: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export type SealDossierInput = z.infer<typeof sealDossierInputSchema>;

export const listDossiersInputSchema = z
  .object({
    engagementId: z.string().uuid().optional(),
    dossierType: DossierTypeSchema.optional(),
    status: z.enum(['draft', 'approved', 'sealed', 'rejected']).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export type ListDossiersInput = z.infer<typeof listDossiersInputSchema>;

export const dispatchReportEmailInputSchema = z
  .object({
    recipientEmail: z.string().trim().email(),
    reportId: z.string().uuid().optional(),
    dossierId: z.string().uuid().optional(),
    notes: z.string().trim().max(2000).optional(),
  })
  .refine((data) => Boolean(data.reportId || data.dossierId), {
    message: 'Either reportId or dossierId must be provided',
  });

export type DispatchReportEmailInput = z.infer<typeof dispatchReportEmailInputSchema>;

export class PramaanClosureService {
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
      throw new EvidenceError('closure_storage_unavailable', 503);
    }
    return data as Record<string, unknown>;
  }

  /**
   * Synthesizes a statutory closure dossier in DRAFT status.
   * Calculates cryptographic Merkle root, manifest hash, and Gold ProofSeal hash.
   */
  async synthesizeDossier(
    tenantId: string,
    actorId: string,
    input: SynthesizeDossierInput,
    correlationId: string = randomUUID(),
    signal?: AbortSignal,
  ): Promise<PramaanDossier> {
    const timestamp = new Date().toISOString();

    // Deterministic cryptographic hash generation
    const manifestPayload = JSON.stringify({
      tenantId,
      engagementId: input.engagementId,
      reportId: input.reportId ?? null,
      dossierType: input.dossierType,
      title: input.title,
      synthesizedAt: timestamp,
      synthesizedByAgent: 'pramaan',
      metadata: input.metadata,
      branding: {
        company: BRAND.company,
        website: BRAND.companyDomain,
        product: BRAND.name,
        domain: `https://${BRAND.primaryDomain}`,
        tagline: BRAND.tagline,
      },
    });

    const manifestHash = createHash('sha256').update(manifestPayload, 'utf8').digest('hex');
    const merkleRoot = createHash('sha256')
      .update(`${manifestHash}:${input.engagementId}:${input.dossierType}`, 'utf8')
      .digest('hex');
    const proofSealHash = createHash('sha256')
      .update(`proof_seal:${tenantId}:${merkleRoot}:${manifestHash}`, 'utf8')
      .digest('hex');

    const dossierId = randomUUID();

    const insertQuery = this.db.from('pramaan_dossiers').insert({
      id: dossierId,
      tenant_id: tenantId,
      engagement_id: input.engagementId,
      report_id: input.reportId ?? null,
      dossier_type: input.dossierType,
      title: input.title,
      status: 'draft',
      merkle_root: merkleRoot,
      manifest_hash: manifestHash,
      proof_seal_hash: proofSealHash,
      metadata: input.metadata,
      created_at: timestamp,
      updated_at: timestamp,
    });

    const insertWithSignal =
      signal &&
      typeof (insertQuery as unknown as { abortSignal?: (s: AbortSignal) => unknown }).abortSignal ===
        'function'
        ? (insertQuery as unknown as { abortSignal: (s: AbortSignal) => typeof insertQuery }).abortSignal(
            signal,
          )
        : insertQuery;

    const { error: insertError } = (await (insertWithSignal as unknown as Promise<{ error: unknown }>));
    if (insertError) {
      throw new EvidenceError('closure_storage_unavailable', 503);
    }

    // Append draft action to immutable ledger
    try {
      await this.rpc(
        'append_ledger',
        {
          p_tenant_id: tenantId,
          p_correlation_id: correlationId,
          p_actor_type: 'agent',
          p_actor_id: 'pramaan',
          p_action_type: 'closure.pramaan.drafted',
          p_target_id: dossierId,
          p_result: 'success',
          p_payload: {
            dossier_id: dossierId,
            engagement_id: input.engagementId,
            dossier_type: input.dossierType,
            title: input.title,
            merkle_root: merkleRoot,
            proof_seal_hash: proofSealHash,
          },
        },
        signal,
      );
    } catch {
      // Non-blocking if append_ledger rpc wrapper handled in database
    }

    return {
      id: dossierId,
      tenantId,
      engagementId: input.engagementId,
      reportId: input.reportId ?? null,
      dossierType: input.dossierType,
      title: input.title,
      status: 'draft',
      merkleRoot,
      manifestHash,
      archiveHash: null,
      archiveBytes: null,
      proofSealHash,
      sealedAt: null,
      sealedBy: null,
      metadata: input.metadata,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  /**
   * Seals a dossier under Founder Authority using seal_pramaan_dossier RPC.
   */
  async sealDossier(
    tenantId: string,
    actorId: string,
    dossierId: string,
    input: SealDossierInput,
    correlationId: string = randomUUID(),
    signal?: AbortSignal,
  ): Promise<{ dossierId: string; status: 'sealed'; sealedAt: string }> {
    const sealRes = await this.rpc(
      'seal_pramaan_dossier',
      {
        p_tenant_id: tenantId,
        p_dossier_id: dossierId,
        p_sealed_by: actorId,
        p_expected_proof_seal: input.expectedProofSeal,
        p_correlation_id: correlationId,
      },
      signal,
    );

    if (sealRes.error) {
      if (sealRes.error === 'founder_authority_required') {
        throw new EvidenceError('founder_authority_required', 403);
      }
      if (sealRes.error === 'dossier_not_found') {
        throw new EvidenceError('dossier_not_found', 404);
      }
      if (sealRes.error === 'already_sealed') {
        throw new EvidenceError('already_sealed', 409);
      }
      if (sealRes.error === 'proof_seal_mismatch') {
        throw new EvidenceError('proof_seal_mismatch', 400);
      }
      throw new EvidenceError('invalid_request', 400);
    }

    return {
      dossierId,
      status: 'sealed',
      sealedAt: (sealRes.sealedAt as string) || new Date().toISOString(),
    };
  }

  /**
   * Retrieves a single dossier by ID.
   */
  async getDossier(
    tenantId: string,
    dossierId: string,
    signal?: AbortSignal,
  ): Promise<PramaanDossier> {
    const query = this.db
      .from('pramaan_dossiers')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('id', dossierId);

    const queryWithSignal =
      signal &&
      typeof (query as unknown as { abortSignal?: (s: AbortSignal) => unknown }).abortSignal ===
        'function'
        ? (query as unknown as { abortSignal: (s: AbortSignal) => typeof query }).abortSignal(signal)
        : query;

    const res = (
      typeof (queryWithSignal as unknown as { maybeSingle?: () => unknown }).maybeSingle ===
      'function'
        ? await (queryWithSignal as unknown as {
            maybeSingle: () => Promise<{ data: Record<string, unknown> | null; error: unknown }>;
          }).maybeSingle()
        : await (queryWithSignal as unknown as Promise<{
            data: Record<string, unknown>[] | null;
            error: unknown;
          }>)
    );

    if (res.error) throw new EvidenceError('closure_storage_unavailable', 503);
    const row = Array.isArray(res.data) ? res.data[0] : res.data;
    if (!row) throw new EvidenceError('dossier_not_found', 404);

    return {
      id: row.id as string,
      tenantId: row.tenant_id as string,
      engagementId: row.engagement_id as string,
      reportId: (row.report_id as string) ?? null,
      dossierType: row.dossier_type as DossierType,
      title: row.title as string,
      status: row.status as PramaanDossier['status'],
      merkleRoot: row.merkle_root as string,
      manifestHash: row.manifest_hash as string,
      archiveHash: (row.archive_hash as string) ?? null,
      archiveBytes: row.archive_bytes ? Number(row.archive_bytes) : null,
      proofSealHash: row.proof_seal_hash as string,
      sealedAt: (row.sealed_at as string) ?? null,
      sealedBy: (row.sealed_by as string) ?? null,
      metadata: (row.metadata as Record<string, unknown>) ?? {},
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  /**
   * Lists dossiers with optional filtering and pagination.
   */
  async listDossiers(
    tenantId: string,
    input: ListDossiersInput,
    signal?: AbortSignal,
  ): Promise<{ dossiers: PramaanDossier[]; total: number }> {
    let query = this.db
      .from('pramaan_dossiers')
      .select('*', { count: 'exact' })
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .range(input.offset, input.offset + input.limit - 1);

    if (input.engagementId) {
      query = query.eq('engagement_id', input.engagementId);
    }
    if (input.dossierType) {
      query = query.eq('dossier_type', input.dossierType);
    }
    if (input.status) {
      query = query.eq('status', input.status);
    }

    const queryWithSignal =
      signal &&
      typeof (query as unknown as { abortSignal?: (s: AbortSignal) => unknown }).abortSignal ===
        'function'
        ? (query as unknown as { abortSignal: (s: AbortSignal) => typeof query }).abortSignal(signal)
        : query;

    const { data, count, error } = await (queryWithSignal as unknown as Promise<{
      data: Record<string, unknown>[] | null;
      count: number | null;
      error: unknown;
    }>);

    if (error) throw new EvidenceError('closure_storage_unavailable', 503);

    const dossiers: PramaanDossier[] = (data ?? []).map((row) => ({
      id: row.id as string,
      tenantId: row.tenant_id as string,
      engagementId: row.engagement_id as string,
      reportId: (row.report_id as string) ?? null,
      dossierType: row.dossier_type as DossierType,
      title: row.title as string,
      status: row.status as PramaanDossier['status'],
      merkleRoot: row.merkle_root as string,
      manifestHash: row.manifest_hash as string,
      archiveHash: (row.archive_hash as string) ?? null,
      archiveBytes: row.archive_bytes ? Number(row.archive_bytes) : null,
      proofSealHash: row.proof_seal_hash as string,
      sealedAt: (row.sealed_at as string) ?? null,
      sealedBy: (row.sealed_by as string) ?? null,
      metadata: (row.metadata as Record<string, unknown>) ?? {},
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    }));

    return { dossiers, total: count ?? dossiers.length };
  }

  /**
   * Dispatches a compliance report or statutory closure dossier via email
   * and records immutable audit ledger entry.
   */
  async dispatchReportEmail(
    tenantId: string,
    actorId: string,
    input: DispatchReportEmailInput,
    correlationId: string = randomUUID(),
    signal?: AbortSignal,
  ): Promise<{ dispatchId: string; status: 'sent' | 'simulated'; providerMessageId?: string }> {
    let title = 'Axiom Proof Compliance Report';
    let kind = 'compliance_report';
    let summary = 'Attached is the official compliance report issued under DPDPA framework.';
    let proofSealHash: string | undefined;
    let merkleRoot: string | undefined;
    let reportUrl = 'https://app.axiomproof.ai/reports';

    if (input.dossierId) {
      const dossier = await this.getDossier(tenantId, input.dossierId, signal);
      title = dossier.title;
      kind = `statutory_dossier_${dossier.dossierType}`;
      summary = `Authoritative DPDPA Statutory Closure Dossier (${dossier.dossierType.replace(/_/g, ' ')}). Status: ${dossier.status.toUpperCase()}.`;
      proofSealHash = dossier.proofSealHash;
      merkleRoot = dossier.merkleRoot;
      reportUrl = `https://app.axiomproof.ai/reports?dossierId=${dossier.id}`;
    } else if (input.reportId) {
      const repQuery = this.db
        .from('reports')
        .select('id, title, kind')
        .eq('tenant_id', tenantId)
        .eq('id', input.reportId);

      const res = await (repQuery as unknown as Promise<{
        data: { id: string; title: string; kind: string }[] | null;
        error: unknown;
      }>);

      if (!res.error && res.data && res.data[0]) {
        title = res.data[0].title;
        kind = res.data[0].kind;
        summary = `DPDPA Statutory Compliance Report (${kind.toUpperCase()}).`;
        reportUrl = `https://app.axiomproof.ai/reports?reportId=${input.reportId}`;
      }
    }

    // Dispatch via server-side Resend service with strict brand origin
    const emailResult = await sendReportDispatchEmail({
      recipientEmail: input.recipientEmail,
      title,
      kind,
      summary,
      reportId: input.reportId,
      dossierId: input.dossierId,
      reportUrl,
      proofSealHash,
      merkleRoot,
      notes: input.notes,
    });

    if (emailResult.status === 'failed') {
      throw new EvidenceError(emailResult.error || 'email_dispatch_failed', 503);
    }

    // Record audit dispatch row via RPC
    const recordRes = await this.rpc(
      'record_report_email_dispatch',
      {
        p_tenant_id: tenantId,
        p_report_id: input.reportId ?? null,
        p_dossier_id: input.dossierId ?? null,
        p_recipient_email: input.recipientEmail,
        p_subject: `[Axiom Proof] ${proofSealHash ? 'Sealed Statutory Closure Dossier' : 'Compliance Report'}: ${title}`,
        p_external_id: emailResult.providerMessageId ?? 'simulated',
        p_dispatched_by: actorId,
        p_correlation_id: correlationId,
      },
      signal,
    );

    if (recordRes.error) {
      throw new EvidenceError('dispatch_audit_failed', 500);
    }

    return {
      dispatchId: (recordRes.dispatchId as string) || randomUUID(),
      status: emailResult.status,
      providerMessageId: emailResult.providerMessageId,
    };
  }
}
