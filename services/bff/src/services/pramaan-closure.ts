/**
 * Historical Pramaan dossier read service. Source-free synthesis, sealing and
 * outbound dispatch remain closed until exact retained artifacts are verified.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DossierTypeSchema, type DossierType, type PramaanDossier } from '@axiom/types';
import { EvidenceError, type EvidenceDatabase } from './evidence-ingestion.js';
import { accessFor } from './evidence-pack-records.js';
import { PramaanArtifactService } from './pramaan-artifacts.js';

export const synthesizeDossierInputSchema = z
  .object({
    engagementId: z.string().uuid(),
    dossierType: DossierTypeSchema,
    title: z.string().trim().min(1).max(300),
    reportId: z.string().uuid(),
    operationKey: z.string().uuid(),
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
  readonly artifacts: PramaanArtifactService;
  constructor(private readonly db: EvidenceDatabase) {
    this.artifacts = new PramaanArtifactService(db);
  }

  private async assertHistoricalReader(tenantId: string, actorId: string, signal?: AbortSignal) {
    const access = await accessFor(this.db, tenantId, actorId, signal);
    if (!access.founder) throw new EvidenceError('dossier_not_found', 404);
  }

  async listMyBuilds(tenantId: string, actorId: string, signal?: AbortSignal) {
    return this.artifacts.mine(tenantId, actorId, signal);
  }

  /** Only published, exact-version board evidence currently has a dossier source contract. */
  async synthesizeDossier(
    tenantId: string,
    actorId: string,
    input: SynthesizeDossierInput,
    _correlationId: string = randomUUID(),
    signal?: AbortSignal,
  ) {
    return this.artifacts.create(tenantId, actorId, input, signal);
  }

  /** Historical rows cannot enter this source-bound seal path. */
  async sealDossier(
    tenantId: string,
    actorId: string,
    dossierId: string,
    input: SealDossierInput,
    _correlationId: string = randomUUID(),
    signal?: AbortSignal,
  ) {
    return this.artifacts.seal(tenantId, actorId, dossierId, input.expectedProofSeal, signal);
  }

  async reconcileDossier(
    tenantId: string,
    actorId: string,
    dossierId: string,
    operationKey: string,
    signal?: AbortSignal,
  ) {
    return this.artifacts.reconcile(tenantId, actorId, dossierId, operationKey, signal);
  }

  async retryMissingDossier(
    tenantId: string,
    actorId: string,
    dossierId: string,
    operationKey: string,
    signal?: AbortSignal,
  ) {
    return this.artifacts.retryMissing(tenantId, actorId, dossierId, operationKey, signal);
  }

  async getDossierArchive(
    tenantId: string,
    actorId: string,
    dossierId: string,
    signal?: AbortSignal,
  ) {
    return this.artifacts.archive(tenantId, actorId, dossierId, signal);
  }

  /**
   * Retrieves a single dossier by ID.
   */
  async getDossier(
    tenantId: string,
    actorId: string,
    dossierId: string,
    signal?: AbortSignal,
  ): Promise<PramaanDossier> {
    const access = await accessFor(this.db, tenantId, actorId, signal);
    if (!access.manager) throw new EvidenceError('dossier_not_found', 404);
    const query = this.db
      .from('pramaan_dossiers')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('id', dossierId);

    const queryWithSignal =
      signal &&
      typeof (query as unknown as { abortSignal?: (s: AbortSignal) => unknown }).abortSignal ===
        'function'
        ? (query as unknown as { abortSignal: (s: AbortSignal) => typeof query }).abortSignal(
            signal,
          )
        : query;

    const res =
      typeof (queryWithSignal as unknown as { maybeSingle?: () => unknown }).maybeSingle ===
      'function'
        ? await (
            queryWithSignal as unknown as {
              maybeSingle: () => Promise<{ data: Record<string, unknown> | null; error: unknown }>;
            }
          ).maybeSingle()
        : await (queryWithSignal as unknown as Promise<{
            data: Record<string, unknown>[] | null;
            error: unknown;
          }>);

    if (res.error) throw new EvidenceError('closure_storage_unavailable', 503);
    const row = Array.isArray(res.data) ? res.data[0] : res.data;
    if (!row) throw new EvidenceError('dossier_not_found', 404);
    const source = await this.artifacts.status(tenantId, actorId, dossierId, signal);
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
      ...source,
    };
  }

  /**
   * Lists dossiers with optional filtering and pagination.
   */
  async listDossiers(
    tenantId: string,
    actorId: string,
    input: ListDossiersInput,
    signal?: AbortSignal,
  ): Promise<{ dossiers: PramaanDossier[]; total: number }> {
    await this.assertHistoricalReader(tenantId, actorId, signal);
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
        ? (query as unknown as { abortSignal: (s: AbortSignal) => typeof query }).abortSignal(
            signal,
          )
        : query;

    const { data, count, error } = await (queryWithSignal as unknown as Promise<{
      data: Record<string, unknown>[] | null;
      count: number | null;
      error: unknown;
    }>);

    if (error) throw new EvidenceError('closure_storage_unavailable', 503);
    await this.assertHistoricalReader(tenantId, actorId, signal);

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

  /** External dispatch is closed until the selected artifact is source-bound and retained. */
  async dispatchReportEmail(
    _tenantId: string,
    _actorId: string,
    _input: DispatchReportEmailInput,
    _correlationId: string = randomUUID(),
    _signal?: AbortSignal,
  ): Promise<{ dispatchId: string; status: 'sent' | 'simulated'; providerMessageId?: string }> {
    throw new EvidenceError('source_bound_dispatch_required', 409);
  }
}
