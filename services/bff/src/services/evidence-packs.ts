import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { buildEvidencePack, readManifestText } from '@axiom/report-kit/archive';
import { PACK_LIMITS, type ManifestV1 } from '@axiom/report-kit/schema';
import {
  EvidenceError,
  evidenceStorage,
  receiptSchema,
  type EvidenceDatabase,
  type EvidenceReceipt,
  type EvidenceStorageConfig,
  type EvidenceVaultApi,
} from './evidence-ingestion.js';
import {
  accessFor,
  canManagePack,
  canReadReport,
  parseRecord,
  reportColumns,
  reportSchema,
  packSchema,
  reviewSchema,
  buildSchema,
  archiveSchema,
  publicPack,
  publicReport,
  uuid,
  type PackAccess,
  type Report,
  type Review,
  type PackBundle,
} from './evidence-pack-records.js';

export const preparePackSchema = z
  .object({
    operationKey: uuid,
    title: z.string().trim().min(1).max(200),
    evidenceReceiptIds: z
      .array(uuid)
      .min(1)
      .max(PACK_LIMITS.members)
      .refine((v) => new Set(v).size === v.length),
    engagementId: uuid.nullable().optional(),
  })
  .strict();
type Storage = { vault: EvidenceVaultApi; config: EvidenceStorageConfig };
const evidenceSchema = z.object({
  id: uuid,
  tenant_id: uuid,
  engagement_id: uuid.nullable(),
  content_hash: z.string(),
  byte_size: z.number().int(),
  collected_by_agent: z.string(),
});
type Member = { receipt: EvidenceReceipt; row: z.infer<typeof evidenceSchema> };
type Budget = { signal: AbortSignal; expires: number };
let activeWork = 0;
async function boundedWork<T>(
  signal: AbortSignal | undefined,
  work: (budget: Budget) => Promise<T>,
): Promise<T> {
  // One memory-heavy assembly per process, without an unbounded request queue.
  if (activeWork >= 1) throw new EvidenceError('pack_capacity_unavailable', 503);
  activeWork++;
  const deadline = AbortSignal.timeout(60_000);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    if (combined.aborted) throw new EvidenceError('pack_deadline_exceeded', 503);
    return await work({ signal: combined, expires: Date.now() + 60_000 });
  } catch (cause) {
    if (combined.aborted) throw new EvidenceError('pack_deadline_exceeded', 503);
    throw cause;
  } finally {
    activeWork--;
  }
}
function options(budget: Budget, maxBytes = PACK_LIMITS.memberBytes) {
  const remaining = budget.expires - Date.now();
  if (budget.signal.aborted || remaining <= 0)
    throw new EvidenceError('pack_deadline_exceeded', 503);
  return { signal: budget.signal, timeoutMs: Math.max(1, Math.min(30_000, remaining)), maxBytes };
}
async function mapBounded<T, R>(values: T[], work: (v: T) => Promise<R>): Promise<R[]> {
  let next = 0;
  let failed = false;
  let failure: unknown;
  const result: R[] = new Array(values.length);
  await Promise.all(
    Array.from({ length: Math.min(2, values.length) }, async () => {
      while (!failed && next < values.length) {
        const index = next++;
        try {
          result[index] = await work(values[index]!);
        } catch (cause) {
          failed = true;
          failure = cause;
        }
      }
    }),
  );
  if (failed) throw failure;
  return result;
}
export class EvidencePackService {
  constructor(
    readonly db: EvidenceDatabase,
    readonly storage: () => Storage = evidenceStorage,
  ) {}
  async access(tenantId: string, actorId: string, signal?: AbortSignal) {
    return accessFor(this.db, tenantId, actorId, signal);
  }
  async engagementOptions(
    tenantId: string,
    actorId: string,
    page: { limit: number; offset: number },
    signal: AbortSignal,
  ) {
    if (!(await this.access(tenantId, actorId, signal)).manager)
      throw new EvidenceError('forbidden', 403);
    const [engagements, libraries] = await Promise.all([
      this.db
        .from('engagements')
        .select('id,title,library_version', { count: 'exact' })
        .eq('tenant_id', tenantId)
        .order('title', { ascending: true })
        .order('id', { ascending: true })
        .range(page.offset, page.offset + page.limit - 1)
        .abortSignal(signal),
      this.db
        .from('control_libraries')
        .select('version')
        .eq('is_current', true)
        .range(0, 1)
        .abortSignal(signal),
    ]);
    if (engagements.error || libraries.error)
      throw new EvidenceError('report_storage_unavailable', 503);
    const rows = parseRecord(
      z.array(z.object({ id: uuid, title: z.string(), library_version: z.string() })),
      engagements.data,
    );
    const current = parseRecord(
      z.array(z.object({ version: z.string().min(1) })).max(1),
      libraries.data,
    );
    const total = parseRecord(z.number().int().nonnegative(), engagements.count);
    // A membership changed during the read must not expose the former manager's options.
    if (!(await this.access(tenantId, actorId, signal)).manager)
      throw new EvidenceError('forbidden', 403);
    return {
      data: rows.map((row) => ({
        id: row.id,
        title: row.title,
        libraryVersion: row.library_version,
      })),
      meta: { ...page, total, hasMore: page.offset + rows.length < total },
      currentLibraryVersion: current[0]?.version ?? null,
    };
  }
  async rpc(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal = AbortSignal.timeout(15_000),
  ) {
    if (signal.aborted) throw new EvidenceError('pack_deadline_exceeded', 503);
    const { data, error } = await this.db.rpc(name, args).abortSignal(signal);
    if (error) throw new EvidenceError('report_persistence_unconfirmed', 503);
    const refusal = z.object({ error: z.string() }).safeParse(data);
    if (refusal.success) throw new EvidenceError(refusal.data.error, 409);
    return data as unknown;
  }
  async report(
    access: PackAccess,
    id: string,
    signal: AbortSignal = AbortSignal.timeout(15_000),
  ): Promise<Report> {
    const { data, error } = await this.db
      .from('reports')
      .select(reportColumns)
      .eq('tenant_id', access.tenantId)
      .eq('id', id)
      .abortSignal(signal)
      .maybeSingle();
    if (error) throw new EvidenceError('report_storage_unavailable', 503);
    if (!data) throw new EvidenceError('report_not_found', 404);
    const report = parseRecord(reportSchema, data);
    if (!canReadReport(access, report)) throw new EvidenceError('report_not_found', 404);
    return report;
  }
  async relations(
    access: PackAccess,
    reports: Report[],
    signal: AbortSignal = AbortSignal.timeout(15_000),
  ) {
    if (!reports.length)
      return { reviews: new Map<string, Review>(), packs: new Map<string, PackBundle>() };
    const ids = reports.map((r) => r.id);
    const [reviewResult, packResult] = await Promise.all([
      this.db
        .from('report_reviews')
        .select('*')
        .eq('tenant_id', access.tenantId)
        .in('report_id', ids)
        .abortSignal(signal),
      this.db
        .from('evidence_packs')
        .select('*')
        .eq('tenant_id', access.tenantId)
        .in('report_id', ids)
        .abortSignal(signal),
    ]);
    if (reviewResult.error || packResult.error)
      throw new EvidenceError('report_storage_unavailable', 503);
    const reviews = new Map<string, Review>();
    for (const row of parseRecord(z.array(reviewSchema), reviewResult.data)) {
      if (
        row.tenant_id !== access.tenantId ||
        !ids.includes(row.report_id) ||
        reviews.has(row.report_id)
      )
        throw new EvidenceError('invalid_report_record', 503);
      reviews.set(row.report_id, row);
    }
    const packs = parseRecord(z.array(packSchema), packResult.data);
    const packIds = packs.map((p) => p.id);
    const result = new Map<string, PackBundle>();
    if (!packIds.length) return { reviews, packs: result };
    const [buildResult, archiveResult] = await Promise.all([
      this.db
        .from('evidence_pack_builds')
        .select('*')
        .eq('tenant_id', access.tenantId)
        .in('pack_id', packIds)
        .abortSignal(signal),
      this.db
        .from('evidence_pack_archives')
        .select('*')
        .eq('tenant_id', access.tenantId)
        .in('pack_id', packIds)
        .abortSignal(signal),
    ]);
    if (buildResult.error || archiveResult.error)
      throw new EvidenceError('report_storage_unavailable', 503);
    const builds = parseRecord(z.array(buildSchema), buildResult.data);
    const archives = parseRecord(z.array(archiveSchema), archiveResult.data);
    for (const pack of packs) {
      const report = reports.find((r) => r.id === pack.report_id);
      if (
        !report ||
        pack.tenant_id !== access.tenantId ||
        result.has(report.id) ||
        report.content_sha256 !== pack.manifest_sha256 ||
        report.content_text !== pack.manifest_text
      )
        throw new EvidenceError('invalid_report_record', 503);
      const matchingBuilds = builds.filter((b) => b.pack_id === pack.id);
      const matchingArchives = archives.filter((a) => a.pack_id === pack.id);
      if (matchingBuilds.length > 1 || matchingArchives.length > 1)
        throw new EvidenceError('invalid_report_record', 503);
      const build = matchingBuilds[0] ?? null;
      const archive = matchingArchives[0] ?? null;
      if (
        (build && build.tenant_id !== access.tenantId) ||
        (archive &&
          (archive.tenant_id !== access.tenantId ||
            archive.build_id !== build?.id ||
            archive.content_hash !== build?.request.content_hash ||
            archive.byte_size !== build?.request.byte_size))
      )
        throw new EvidenceError('invalid_report_record', 503);
      result.set(report.id, {
        pack,
        report,
        review: reviews.get(report.id) ?? null,
        build,
        archive,
      });
    }
    return { reviews, packs: result };
  }
  async detail(
    access: PackAccess,
    packId: string,
    signal: AbortSignal = AbortSignal.timeout(15_000),
  ): Promise<PackBundle> {
    const found = await this.db
      .from('evidence_packs')
      .select('report_id')
      .eq('tenant_id', access.tenantId)
      .eq('id', packId)
      .abortSignal(signal)
      .maybeSingle();
    if (found.error) throw new EvidenceError('report_storage_unavailable', 503);
    if (!found.data) throw new EvidenceError('pack_not_found', 404);
    const id = parseRecord(z.object({ report_id: uuid }), found.data).report_id;
    const report = await this.report(access, id, signal);
    const bundle = (await this.relations(access, [report], signal)).packs.get(id);
    if (!bundle || bundle.pack.id !== packId) throw new EvidenceError('pack_not_found', 404);
    return bundle;
  }
  async list(
    access: PackAccess,
    input: { limit: number; offset: number; status?: Report['status'] },
    packsOnly = false,
    signal: AbortSignal = AbortSignal.timeout(15_000),
  ) {
    let query = this.db
      .from('reports')
      .select(reportColumns, { count: 'exact' })
      .eq('tenant_id', access.tenantId);
    if (!access.founder)
      query = access.manager
        ? query.or(`created_by.eq.${access.actorId},status.eq.published`)
        : query.eq('status', 'published');
    if (input.status) query = query.eq('status', input.status);
    if (packsOnly) query = query.eq('kind', 'evidence_pack');
    const result = await query
      .order('generated_at', { ascending: false })
      .order('id', { ascending: false })
      .range(input.offset, input.offset + input.limit - 1)
      .abortSignal(signal);
    if (result.error || typeof result.count !== 'number')
      throw new EvidenceError('report_storage_unavailable', 503);
    const reports = parseRecord(z.array(reportSchema), result.data);
    const unreadable = reports.filter((r) => !canReadReport(access, r));
    if (unreadable.length > 0) {
      console.warn(
        `[EvidencePacks] Refusing ${unreadable.length} report(s) unreadable by actor ${access.actorId}:`,
        unreadable.map((r) => ({ id: r.id, status: r.status, createdBy: r.created_by })),
      );
      throw new EvidenceError('invalid_report_record', 503);
    }
    const related = await this.relations(access, reports, signal);
    return {
      data: reports.map((report) => {
        const pack = related.packs.get(report.id) ?? null;
        if (packsOnly) {
          if (!pack) throw new EvidenceError('invalid_report_record', 503);
          return publicPack(pack, false);
        }
        return publicReport(report, related.reviews.get(report.id) ?? null, pack);
      }),
      meta: {
        total: result.count,
        limit: input.limit,
        offset: input.offset,
        hasMore: input.offset + input.limit < result.count,
      },
    };
  }
  private configured(storage: Storage, provider: string, bucket: string) {
    if (provider !== storage.config.provider || bucket !== storage.config.bucket)
      throw new EvidenceError('storage_configuration_changed', 503);
  }
  async members(
    access: PackAccess,
    ids: string[],
    signal: AbortSignal = AbortSignal.timeout(15_000),
  ): Promise<Member[]> {
    const objects = await this.db
      .from('evidence_object_versions')
      .select('*')
      .eq('tenant_id', access.tenantId)
      .in('id', ids)
      .abortSignal(signal);
    if (objects.error) throw new EvidenceError('report_storage_unavailable', 503);
    const receipts = parseRecord(z.array(receiptSchema), objects.data);
    if (
      receipts.length !== ids.length ||
      new Set(receipts.map((r) => r.id)).size !== ids.length ||
      receipts.some((r) => r.tenant_id !== access.tenantId || !ids.includes(r.id))
    )
      throw new EvidenceError('evidence_version_unavailable', 409);
    if (receipts.reduce((sum, r) => sum + r.byte_size, 0) > PACK_LIMITS.aggregateBytes)
      throw new EvidenceError('pack_size_exceeded', 413);
    const result = await this.db
      .from('evidence')
      .select('id,tenant_id,engagement_id,content_hash,byte_size,collected_by_agent')
      .eq('tenant_id', access.tenantId)
      .in(
        'id',
        receipts.map((r) => r.evidence_id),
      )
      .abortSignal(signal);
    if (result.error) throw new EvidenceError('report_storage_unavailable', 503);
    const rows = parseRecord(z.array(evidenceSchema), result.data);
    return receipts.map((receipt) => {
      const row = rows.find((r) => r.id === receipt.evidence_id);
      if (
        !row ||
        row.tenant_id !== access.tenantId ||
        row.content_hash !== receipt.content_hash ||
        row.byte_size !== receipt.byte_size
      )
        throw new EvidenceError('evidence_version_unavailable', 409);
      if (row.collected_by_agent !== 'human')
        throw new EvidenceError('provenance_unavailable', 409);
      return { receipt, row };
    });
  }
  private async verifyMember(storage: Storage, member: Member, budget: Budget) {
    const { receipt, row } = member;
    this.configured(storage, receipt.provider, receipt.bucket);
    return storage.vault.verifyReceipt(
      {
        bucket: receipt.bucket,
        key: receipt.object_key,
        versionId: receipt.version_id,
        contentHash: receipt.content_hash,
        byteSize: receipt.byte_size,
        tenantId: receipt.tenant_id,
        engagementId: row.engagement_id,
        collectedByAgent: row.collected_by_agent,
        operationId: receipt.ingestion_id,
        retainUntil: receipt.retain_until,
        legalHold: receipt.legal_hold,
        encryption: receipt.encryption,
      },
      options(budget),
    );
  }
  async prepare(
    access: PackAccess,
    input: z.infer<typeof preparePackSchema>,
    signal?: AbortSignal,
  ) {
    if (!access.manager) throw new EvidenceError('forbidden', 403);
    return boundedWork(signal, async (budget) => {
      const members = await this.members(access, input.evidenceReceiptIds, budget.signal);
      const storage = this.storage();
      try {
        await mapBounded(members, (m) => this.verifyMember(storage, m, budget));
      } catch (cause) {
        if (cause instanceof EvidenceError) throw cause;
        throw new EvidenceError('provider_verification_failed', 503);
      }
      const response = await this.rpc(
        'prepare_evidence_pack',
        {
          p_tenant_id: access.tenantId,
          p_actor_id: access.actorId,
          p_operation_key: input.operationKey,
          p_title: input.title,
          p_engagement_id: input.engagementId ?? null,
          p_library_version: null,
          p_evidence_version_ids: input.evidenceReceiptIds,
          p_correlation_id: randomUUID(),
        },
        budget.signal,
      );
      const id = parseRecord(z.object({ pack_id: uuid }), response).pack_id;
      return this.detail(
        await this.access(access.tenantId, access.actorId, budget.signal),
        id,
        budget.signal,
      );
    });
  }
  private async refresh(access: PackAccess, packId: string, signal?: AbortSignal) {
    return this.detail(await this.access(access.tenantId, access.actorId, signal), packId, signal);
  }
  private async pending(access: PackAccess, bundle: PackBundle, code: string) {
    if (!bundle.build) throw new EvidenceError('report_persistence_unconfirmed', 503);
    const cleanupSignal = AbortSignal.timeout(5_000);
    try {
      await this.rpc(
        'note_evidence_pack_build_failure',
        {
          p_tenant_id: access.tenantId,
          p_actor_id: access.actorId,
          p_build_id: bundle.build.id,
          p_error_code: code,
          p_correlation_id: randomUUID(),
        },
        cleanupSignal,
      );
    } catch {
      /* A lost failure note cannot erase a durable pending operation. */
    }
    return this.refresh(access, bundle.pack.id, cleanupSignal);
  }
  private async settle(
    access: PackAccess,
    bundle: PackBundle,
    versionId: string,
    storage: Storage,
    budget: Budget,
  ) {
    const build = bundle.build!;
    const request = build.request;
    this.configured(storage, request.provider, request.bucket);
    const verified = await storage.vault.verifyReceipt(
      {
        bucket: request.bucket,
        key: request.object_key,
        versionId,
        contentHash: request.content_hash,
        byteSize: request.byte_size,
        tenantId: access.tenantId,
        engagementId: bundle.pack.engagement_id,
        collectedByAgent: 'evidence-pack-builder',
        operationId: build.id,
        retainUntil: build.retain_until,
        legalHold: false,
        encryption: 'AES256',
      },
      options(budget, PACK_LIMITS.archiveBytes),
    );
    await this.rpc(
      'settle_evidence_pack_build',
      {
        p_tenant_id: access.tenantId,
        p_actor_id: access.actorId,
        p_build_id: build.id,
        p_receipt: {
          provider: request.provider,
          bucket: request.bucket,
          object_key: request.object_key,
          version_id: verified.versionId,
          content_hash: verified.contentHash,
          byte_size: verified.byteSize,
          tenant_id: access.tenantId,
          engagement_id: bundle.pack.engagement_id,
          collected_by_agent: 'evidence-pack-builder',
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
      budget.signal,
    );
    const settled = await this.refresh(access, bundle.pack.id, budget.signal);
    if (settled.build?.status !== 'settled' || !settled.archive)
      throw new EvidenceError('report_persistence_unconfirmed', 503);
    return settled;
  }
  async build(access: PackAccess, packId: string, operationKey: string, signal?: AbortSignal) {
    return boundedWork(signal, async (budget) => {
      const bundle = await this.detail(access, packId, budget.signal);
      if (!canManagePack(access, bundle.pack)) throw new EvidenceError('forbidden', 403);
      if (bundle.build) {
        if (bundle.build.operation_key !== operationKey)
          throw new EvidenceError('build_already_started', 409);
        return bundle;
      }
      if (bundle.report.status !== 'approved' || bundle.review?.decision !== 'approved')
        throw new EvidenceError('not_approved', 409);
      const storage = this.storage();
      const parsed = readManifestText(bundle.pack.manifest_text);
      if (
        parsed.manifestSha256 !== bundle.pack.manifest_sha256 ||
        parsed.manifest.pack_id !== packId ||
        parsed.manifest.tenant_id !== access.tenantId
      )
        throw new EvidenceError('manifest_changed', 409);
      const manifest: ManifestV1 = parsed.manifest;
      const members = await this.members(
        access,
        manifest.members.map((m) => m.receipt_id),
        budget.signal,
      );
      const bodies = await mapBounded(members, async (member) => {
        const declared = manifest.members.find((m) => m.receipt_id === member.receipt.id);
        if (
          !declared ||
          declared.evidence_id !== member.row.id ||
          declared.version_id !== member.receipt.version_id ||
          declared.content_hash !== member.receipt.content_hash ||
          declared.byte_size !== member.receipt.byte_size
        )
          throw new EvidenceError('manifest_changed', 409);
        await this.verifyMember(storage, member, budget);
        const result = await storage.vault.retrieve(
          member.receipt.bucket,
          member.receipt.object_key,
          member.receipt.version_id,
          options(budget),
        );
        if (
          result.body.length !== declared.byte_size ||
          createHash('sha256').update(result.body).digest('hex') !== declared.content_hash
        )
          throw new EvidenceError('provider_verification_failed', 503);
        return [member.row.id, result.body] as const;
      });
      options(budget);
      const archive = buildEvidencePack({
        manifestText: bundle.pack.manifest_text,
        expectedManifestSha256: bundle.pack.manifest_sha256,
        reviewText: bundle.review!.review_text,
        expectedReviewSha256: bundle.review!.review_sha256,
        members: new Map(bodies),
      });
      options(budget);
      const objectKey = `tenants/${access.tenantId}/evidence-packs/${packId}/${operationKey}/${archive.archiveSha256}`;
      const response = await this.rpc(
        'begin_evidence_pack_build',
        {
          p_tenant_id: access.tenantId,
          p_actor_id: access.actorId,
          p_pack_id: packId,
          p_operation_key: operationKey,
          p_request: {
            provider: storage.config.provider,
            bucket: storage.config.bucket,
            object_key: objectKey,
            content_hash: archive.archiveSha256,
            byte_size: archive.byteSize,
            manifest_sha256: bundle.pack.manifest_sha256,
            review_sha256: bundle.review!.review_sha256,
            retention_policy: 'seven_years',
            legal_hold: false,
          },
          p_correlation_id: randomUUID(),
        },
        budget.signal,
      );
      const begun = parseRecord(z.object({ build_id: uuid, replayed: z.boolean() }), response);
      const current = await this.refresh(access, packId, budget.signal);
      if (current.build?.id !== begun.build_id)
        throw new EvidenceError('report_persistence_unconfirmed', 503);
      if (begun.replayed || current.build.status === 'settled') return current;
      try {
        const sealed = await storage.vault.seal(
          {
            bucket: storage.config.bucket,
            key: objectKey,
            body: archive.archive,
            contentType: 'application/zip',
            retentionDays: 2555,
            retainUntil: current.build.retain_until,
            legalHold: false,
            encryption: 'AES256',
            tenantId: access.tenantId,
            engagementId: bundle.pack.engagement_id,
            collectedByAgent: 'evidence-pack-builder',
            operationId: current.build.id,
          },
          options(budget, PACK_LIMITS.archiveBytes),
        );
        return await this.settle(access, current, sealed.versionId, storage, budget);
      } catch {
        return this.pending(access, current, 'storage_or_settlement_unconfirmed');
      }
    });
  }
  async reconcile(access: PackAccess, packId: string, operationKey: string, signal?: AbortSignal) {
    return boundedWork(signal, async (budget) => {
      const bundle = await this.detail(access, packId, budget.signal);
      if (!canManagePack(access, bundle.pack)) throw new EvidenceError('forbidden', 403);
      if (!bundle.build || bundle.build.operation_key !== operationKey)
        throw new EvidenceError('operation_not_found', 404);
      if (bundle.build.status === 'settled') return bundle;
      const storage = this.storage();
      const build = bundle.build!;
      const request = build.request;
      try {
        this.configured(storage, request.provider, request.bucket);
        const candidate = await storage.vault.findEvidenceVersion(
          request.bucket,
          request.object_key,
          {
            tenantId: access.tenantId,
            contentHash: request.content_hash,
            byteSize: request.byte_size,
            operationId: build.id,
            engagementId: bundle.pack.engagement_id,
            collectedByAgent: 'evidence-pack-builder',
          },
          options(budget, PACK_LIMITS.archiveBytes),
        );
        if (!candidate) return this.pending(access, bundle, 'object_version_not_found');
        return await this.settle(access, bundle, candidate.versionId, storage, budget);
      } catch {
        return this.pending(access, bundle, 'reconciliation_unconfirmed');
      }
    });
  }
  async content(access: PackAccess, packId: string, signal?: AbortSignal) {
    return boundedWork(signal, async (budget) => {
      if (!access.canExport) throw new EvidenceError('forbidden', 403);
      const bundle = await this.detail(access, packId, budget.signal);
      const archive = bundle.archive;
      const build = bundle.build;
      if (
        bundle.report.status !== 'published' ||
        !archive ||
        !build ||
        build.status !== 'settled' ||
        bundle.report.released_archive_hash !== archive.content_hash ||
        bundle.report.reviewed_content_hash !== bundle.pack.manifest_sha256
      )
        throw new EvidenceError('pack_not_released', 409);
      const storage = this.storage();
      this.configured(storage, archive.provider, archive.bucket);
      await storage.vault.verifyReceipt(
        {
          bucket: archive.bucket,
          key: archive.object_key,
          versionId: archive.version_id,
          contentHash: archive.content_hash,
          byteSize: archive.byte_size,
          tenantId: access.tenantId,
          engagementId: bundle.pack.engagement_id,
          collectedByAgent: 'evidence-pack-builder',
          operationId: build.id,
          retainUntil: archive.retain_until,
          legalHold: archive.legal_hold,
          encryption: archive.encryption,
        },
        options(budget, PACK_LIMITS.archiveBytes),
      );
      const result = await storage.vault.retrieve(
        archive.bucket,
        archive.object_key,
        archive.version_id,
        options(budget, PACK_LIMITS.archiveBytes),
      );
      if (
        result.body.length !== archive.byte_size ||
        createHash('sha256').update(result.body).digest('hex') !== archive.content_hash
      )
        throw new EvidenceError('provider_verification_failed', 503);
      // Recheck current membership and publication after the provider read before releasing bytes.
      const freshAccess = await this.access(access.tenantId, access.actorId, budget.signal);
      if (!freshAccess.canExport) throw new EvidenceError('forbidden', 403);
      const current = await this.detail(freshAccess, packId, budget.signal);
      if (current.report.status !== 'published' || current.archive?.id !== archive.id)
        throw new EvidenceError('pack_not_released', 409);
      return { body: result.body, hash: archive.content_hash };
    });
  }
}
