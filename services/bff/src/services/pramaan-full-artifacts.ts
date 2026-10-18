/** Full closure composes only SQL-authorized, released exact-version sources.
 * Provider uncertainty stays pending; review, seal and release are separate acts. */
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createStatutoryProofWriter } from '@axiom/supabase';
import {
  buildPramaanFullClosureArchive,
  verifyFullClosureSource,
  type FullClosureComponent,
} from '@axiom/report-kit/full-closure';
import {
  EvidenceError,
  evidenceStorage,
  type EvidenceDatabase,
  type EvidenceStorageConfig,
  type EvidenceVaultApi,
} from './evidence-ingestion.js';
import { accessFor } from './evidence-pack-records.js';
const uuid = z.uuid(),
  digest = z.string().regex(/^[a-f0-9]{64}$/),
  instant = z.iso.datetime({ offset: true });
const requestSchema = z
  .object({
    provider: z.enum(['s3', 's3-compatible']),
    bucket: z.string().min(3),
    object_key: z.string().min(1),
    source_sha256: digest,
    manifest_sha256: digest,
    archive_sha256: digest,
    archive_bytes: z
      .number()
      .int()
      .positive()
      .max(64 * 1024 * 1024),
    merkle_root: digest,
  })
  .strict();
const buildSchema = z.object({
  id: uuid,
  tenant_id: uuid,
  dossier_id: uuid,
  report_id: uuid,
  source_text: z
    .string()
    .min(2)
    .max(8 * 1024 * 1024),
  source_sha256: digest,
  operation_key: uuid,
  requested_by: uuid,
  request: requestSchema,
  retain_until: instant,
  correlation_id: uuid,
  status: z.enum(['pending', 'settled']),
  created_at: instant,
});
const archiveSchema = z.object({
  id: uuid,
  tenant_id: uuid,
  dossier_id: uuid,
  build_id: uuid,
  provider: z.enum(['s3', 's3-compatible']),
  bucket: z.string(),
  object_key: z.string(),
  version_id: z.string().min(1),
  content_hash: digest,
  byte_size: z.number().int().positive(),
  retain_until: instant,
  encryption: z.enum(['AES256', 'aws:kms']),
});
type Build = z.infer<typeof buildSchema>;
type Archive = z.infer<typeof archiveSchema>;
type Storage = { vault: EvidenceVaultApi; config: EvidenceStorageConfig };
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const options = (signal?: AbortSignal, maxBytes = 64 * 1024 * 1024) => ({
  signal,
  maxBytes,
  timeoutMs: 30000,
});
export class PramaanFullArtifactService {
  constructor(
    private readonly db: EvidenceDatabase,
    private readonly storage: () => Storage = evidenceStorage,
    private readonly writer: () => Pick<EvidenceDatabase, 'rpc'> = createStatutoryProofWriter,
  ) {}
  private async row<T>(
    table: string,
    tenantId: string,
    key: string,
    value: string,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<T | null> {
    let q = this.db.from(table).select('*').eq('tenant_id', tenantId).eq(key, value);
    if (signal) q = q.abortSignal(signal);
    const r = await q.maybeSingle();
    if (r.error) throw new EvidenceError('dossier_storage_unavailable', 503);
    if (!r.data) return null;
    const parsed = schema.safeParse(r.data);
    if (!parsed.success) throw new EvidenceError('invalid_dossier_record', 503);
    return parsed.data;
  }
  private async rpc(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    read = false,
  ) {
    let q = (read ? this.db : this.writer()).rpc(name, args);
    if (signal) q = q.abortSignal(signal);
    const r = await q;
    if (r.error) {
      if (
        read &&
        ['23514', '54000'].includes(r.error.code) &&
        /^[a-z_]{1,100}$/.test(r.error.message)
      )
        throw new EvidenceError(r.error.message, 409);
      throw new EvidenceError('closure_source_or_storage_unavailable', 503);
    }
    const value = z.record(z.string(), z.unknown()).safeParse(r.data);
    if (!value.success) throw new EvidenceError('invalid_dossier_record', 503);
    if (typeof value.data.error === 'string') throw new EvidenceError(value.data.error, 409);
    return value.data;
  }
  private async manager(t: string, a: string, signal?: AbortSignal) {
    const access = await accessFor(this.db, t, a, signal);
    if (!access.manager) throw new EvidenceError('forbidden', 403);
    return access;
  }
  private async founder(t: string, a: string, signal?: AbortSignal) {
    const access = await this.manager(t, a, signal);
    if (!access.founder) throw new EvidenceError('founder_authority_required', 403);
    return access;
  }
  private build(t: string, id: string, signal?: AbortSignal) {
    return this.row('pramaan_full_builds', t, 'dossier_id', id, buildSchema, signal);
  }
  private storedArchive(t: string, id: string, signal?: AbortSignal) {
    return this.row('pramaan_full_archives', t, 'dossier_id', id, archiveSchema, signal);
  }
  private async source(t: string, a: string, report: string, signal?: AbortSignal) {
    const result = z
      .object({ sourceText: z.string(), sourceSha256: digest })
      .strict()
      .parse(
        await this.rpc(
          'read_full_closure_source',
          { p_tenant_id: t, p_actor_id: a, p_report_id: report },
          signal,
          true,
        ),
      );
    const header = z.object({ engagement_id: uuid }).parse(JSON.parse(result.sourceText));
    const source = verifyFullClosureSource(result.sourceText, result.sourceSha256, {
      tenantId: t,
      engagementId: header.engagement_id,
      reportId: report,
    });
    return { ...result, source };
  }
  private sourceFor(build: Build) {
    const header = z.object({ engagement_id: uuid }).parse(JSON.parse(build.source_text));
    return verifyFullClosureSource(build.source_text, build.source_sha256, {
      tenantId: build.tenant_id,
      engagementId: header.engagement_id,
      reportId: build.report_id,
    });
  }
  private assertStorage(storage: Storage, provider: string, bucket: string) {
    if (storage.config.provider !== provider || storage.config.bucket !== bucket)
      throw new EvidenceError('storage_configuration_mismatch', 503);
  }
  private async componentBytes(
    component: FullClosureComponent,
    storage: Storage,
    signal?: AbortSignal,
  ) {
    this.assertStorage(storage, component.provider, component.bucket);
    await storage.vault.verifyReceipt(
      {
        bucket: component.bucket,
        key: component.object_key,
        versionId: component.version_id,
        contentHash: component.content_hash,
        byteSize: component.byte_size,
        tenantId: component.tenant_id,
        ...(component.provider_engagement_id
          ? { engagementId: component.provider_engagement_id }
          : {}),
        operationId: component.operation_id,
        collectedByAgent: component.collected_by_agent,
        retainUntil: component.retain_until,
        legalHold: component.legal_hold,
        encryption: component.encryption,
      },
      options(signal, component.byte_size),
    );
    const result = await storage.vault.retrieve(
      component.bucket,
      component.object_key,
      component.version_id,
      options(signal, component.byte_size),
    );
    if (result.body.length !== component.byte_size || sha(result.body) !== component.content_hash)
      throw new EvidenceError('provider_verification_failed', 503);
    return { id: component.id, bytes: result.body };
  }
  private async prepareArchive(
    build: Pick<Build, 'tenant_id' | 'report_id' | 'source_text' | 'source_sha256'>,
    title: string,
    storage: Storage,
    signal?: AbortSignal,
  ) {
    const header = z.object({ engagement_id: uuid }).parse(JSON.parse(build.source_text));
    const source = verifyFullClosureSource(build.source_text, build.source_sha256, {
      tenantId: build.tenant_id,
      engagementId: header.engagement_id,
      reportId: build.report_id,
    });
    const members = [];
    for (const component of source.components)
      members.push(await this.componentBytes(component, storage, signal));
    return buildPramaanFullClosureArchive({
      tenantId: build.tenant_id,
      engagementId: source.engagement_id,
      reportId: build.report_id,
      title,
      sourceText: build.source_text,
      sourceSha256: build.source_sha256,
      members,
    });
  }
  async owns(t: string, id: string, signal?: AbortSignal) {
    return Boolean(await this.build(t, id, signal));
  }
  async status(t: string, a: string, id: string, signal?: AbortSignal) {
    const access = await accessFor(this.db, t, a, signal);
    const build = await this.build(t, id, signal);
    if (!build && access.founder)
      return {
        sourceBound: false as const,
        archiveStatus: null,
        archiveVersionId: null,
        operationKey: null,
        releaseStatus: 'withheld' as const,
      };
    if (!build || (!access.founder && (!access.manager || build.requested_by !== a)))
      throw new EvidenceError('dossier_not_found', 404);
    const archive = await this.storedArchive(t, id, signal);
    const release = await this.row(
      'pramaan_full_releases',
      t,
      'dossier_id',
      id,
      z.object({ dossier_id: uuid }),
      signal,
    );
    if (build.status === 'settled' && (!archive || archive.build_id !== build.id))
      throw new EvidenceError('invalid_dossier_record', 503);
    return {
      sourceBound: true as const,
      archiveStatus: build.status,
      archiveVersionId: archive?.version_id ?? null,
      operationKey: build.operation_key,
      releaseStatus: release ? ('released' as const) : ('withheld' as const),
    };
  }
  async mine(t: string, a: string, signal?: AbortSignal) {
    await this.manager(t, a, signal);
    let q = this.db
      .from('pramaan_full_builds')
      .select('dossier_id,report_id,status,operation_key,created_at')
      .eq('tenant_id', t)
      .eq('requested_by', a)
      .order('created_at', { ascending: false })
      .range(0, 99);
    if (signal) q = q.abortSignal(signal);
    const r = await q;
    if (r.error) throw new EvidenceError('dossier_storage_unavailable', 503);
    const rows = z
      .array(
        z.object({
          dossier_id: uuid,
          report_id: uuid,
          status: z.enum(['pending', 'settled']),
          operation_key: uuid,
          created_at: instant,
        }),
      )
      .max(100)
      .parse(r.data);
    return {
      builds: rows.map((x) => ({
        dossierId: x.dossier_id,
        reportId: x.report_id,
        status: x.status,
        operationKey: x.operation_key,
        createdAt: x.created_at,
      })),
    };
  }
  private async pending(t: string, a: string, b: Build) {
    try {
      await this.rpc(
        'note_full_pramaan_failure',
        {
          p_tenant_id: t,
          p_actor_id: a,
          p_build_id: b.id,
          p_error_code: 'storage_or_settlement_unconfirmed',
          p_correlation_id: randomUUID(),
        },
        AbortSignal.timeout(5000),
      );
    } catch {
      /* Fixed build remains pending even if journaling is unavailable. */
    }
    return {
      dossierId: b.dossier_id,
      buildId: b.id,
      operationKey: b.operation_key,
      status: 'pending' as const,
    };
  }
  private async settle(
    t: string,
    a: string,
    b: Build,
    version: string,
    storage: Storage,
    signal?: AbortSignal,
  ) {
    const source = this.sourceFor(b);
    const verified = await storage.vault.verifyReceipt(
      {
        bucket: b.request.bucket,
        key: b.request.object_key,
        versionId: version,
        contentHash: b.request.archive_sha256,
        byteSize: b.request.archive_bytes,
        tenantId: t,
        engagementId: source.engagement_id,
        collectedByAgent: 'pramaan',
        operationId: b.id,
        retainUntil: b.retain_until,
        legalHold: false,
        encryption: 'AES256',
      },
      options(signal),
    );
    await this.rpc(
      'settle_full_pramaan',
      {
        p_tenant_id: t,
        p_actor_id: a,
        p_build_id: b.id,
        p_correlation_id: randomUUID(),
        p_receipt: {
          provider: b.request.provider,
          bucket: b.request.bucket,
          object_key: b.request.object_key,
          version_id: verified.versionId,
          content_hash: verified.contentHash,
          byte_size: verified.byteSize,
          tenant_id: t,
          engagement_id: source.engagement_id,
          collected_by_agent: 'pramaan',
          retain_until: verified.retainUntil,
          readback_at: verified.readbackAt,
          lock_mode: verified.lockMode,
          verified: true,
          legal_hold: verified.legalHold,
          encryption: verified.encryption,
          operation_id: b.id,
          correlation_id: b.correlation_id,
        },
      },
      signal,
    );
  }
  private async put(
    t: string,
    a: string,
    b: Build,
    archive: Buffer,
    storage: Storage,
    signal?: AbortSignal,
  ) {
    const source = this.sourceFor(b);
    try {
      const receipt = await storage.vault.seal(
        {
          bucket: b.request.bucket,
          key: b.request.object_key,
          body: archive,
          contentType: 'application/zip',
          retentionDays: 2555,
          retainUntil: b.retain_until,
          legalHold: false,
          encryption: 'AES256',
          tenantId: t,
          engagementId: source.engagement_id,
          collectedByAgent: 'pramaan',
          operationId: b.id,
          createOnly: true,
        },
        options(signal),
      );
      await this.settle(t, a, b, receipt.versionId, storage, signal);
      return {
        dossierId: b.dossier_id,
        buildId: b.id,
        operationKey: b.operation_key,
        status: 'settled' as const,
      };
    } catch {
      return this.pending(t, a, b);
    }
  }
  async create(
    t: string,
    a: string,
    input: {
      engagementId: string;
      reportId: string;
      dossierType: string;
      title: string;
      operationKey: string;
    },
    signal?: AbortSignal,
  ) {
    await this.manager(t, a, signal);
    if (input.dossierType !== 'full_closure')
      throw new EvidenceError('full_closure_source_required', 409);
    const prepared = await this.source(t, a, input.reportId, signal);
    if (prepared.source.engagement_id !== input.engagementId)
      throw new EvidenceError('source_version_conflict', 409);
    const storage = this.storage();
    const archive = await this.prepareArchive(
      {
        tenant_id: t,
        report_id: input.reportId,
        source_text: prepared.sourceText,
        source_sha256: prepared.sourceSha256,
      },
      input.title,
      storage,
      signal,
    );
    const result = await this.rpc(
      'begin_full_pramaan',
      {
        p_tenant_id: t,
        p_actor_id: a,
        p_report_id: input.reportId,
        p_operation_key: input.operationKey,
        p_title: input.title,
        p_source_text: prepared.sourceText,
        p_request: {
          provider: storage.config.provider,
          bucket: storage.config.bucket,
          source_sha256: prepared.sourceSha256,
          manifest_sha256: archive.manifestSha256,
          archive_sha256: archive.archiveSha256,
          archive_bytes: archive.byteSize,
          merkle_root: archive.merkleRoot,
          object_key: `tenants/${t}/pramaan/full/${input.reportId}/${input.operationKey}/${archive.archiveSha256}`,
        },
        p_correlation_id: randomUUID(),
      },
      signal,
    );
    const id = uuid.parse(result.dossierId);
    const build = await this.build(t, id, signal);
    if (
      !build ||
      build.operation_key !== input.operationKey ||
      build.source_sha256 !== prepared.sourceSha256
    )
      throw new EvidenceError('dossier_persistence_unconfirmed', 503);
    if (build.status === 'settled' || result.replayed === true)
      return {
        dossierId: id,
        buildId: build.id,
        operationKey: build.operation_key,
        status: build.status,
        replayed: true,
      };
    return this.put(t, a, build, archive.archive, storage, signal);
  }
  private async operation(t: string, a: string, id: string, key: string, signal?: AbortSignal) {
    const access = await this.manager(t, a, signal);
    const b = await this.build(t, id, signal);
    if (!b || b.operation_key !== key || (!access.founder && b.requested_by !== a))
      throw new EvidenceError('operation_not_found', 404);
    return b;
  }
  private async find(b: Build, storage: Storage, signal?: AbortSignal) {
    this.assertStorage(storage, b.request.provider, b.request.bucket);
    const source = this.sourceFor(b);
    return storage.vault.findEvidenceVersion(
      b.request.bucket,
      b.request.object_key,
      {
        tenantId: b.tenant_id,
        engagementId: source.engagement_id,
        contentHash: b.request.archive_sha256,
        byteSize: b.request.archive_bytes,
        operationId: b.id,
        collectedByAgent: 'pramaan',
      },
      options(signal),
    );
  }
  async reconcile(t: string, a: string, id: string, key: string, signal?: AbortSignal) {
    const b = await this.operation(t, a, id, key, signal);
    if (b.status === 'settled')
      return { dossierId: id, buildId: b.id, operationKey: key, status: 'settled' as const };
    const storage = this.storage();
    try {
      const candidate = await this.find(b, storage, signal);
      if (!candidate) return this.pending(t, a, b);
      await this.settle(t, a, b, candidate.versionId, storage, signal);
      return { dossierId: id, buildId: b.id, operationKey: key, status: 'settled' as const };
    } catch {
      return this.pending(t, a, b);
    }
  }
  async retryMissing(t: string, a: string, id: string, key: string, signal?: AbortSignal) {
    await this.founder(t, a, signal);
    const b = await this.operation(t, a, id, key, signal);
    if (b.status === 'settled')
      return { dossierId: id, buildId: b.id, operationKey: key, status: 'settled' as const };
    const storage = this.storage();
    let candidate: { versionId: string } | null;
    try {
      candidate = await this.find(b, storage, signal);
    } catch {
      return this.pending(t, a, b);
    }
    if (candidate) {
      try {
        await this.settle(t, a, b, candidate.versionId, storage, signal);
        return { dossierId: id, buildId: b.id, operationKey: key, status: 'settled' as const };
      } catch {
        return this.pending(t, a, b);
      }
    }
    const dossier = await this.row(
      'pramaan_dossiers',
      t,
      'id',
      id,
      z.object({ title: z.string(), status: z.literal('draft') }),
      signal,
    );
    if (!dossier) throw new EvidenceError('not_draft', 409);
    const rebuilt = await this.prepareArchive(b, dossier.title, storage, signal);
    if (
      rebuilt.archiveSha256 !== b.request.archive_sha256 ||
      rebuilt.byteSize !== b.request.archive_bytes ||
      rebuilt.manifestSha256 !== b.request.manifest_sha256
    )
      throw new EvidenceError('archive_hash_changed', 409);
    return this.put(t, a, b, rebuilt.archive, storage, signal);
  }
  private async exactArchive(t: string, a: string, id: string, signal?: AbortSignal) {
    await this.founder(t, a, signal);
    const b = await this.build(t, id, signal),
      archive = await this.storedArchive(t, id, signal);
    if (
      !b ||
      !archive ||
      b.status !== 'settled' ||
      archive.build_id !== b.id ||
      archive.content_hash !== b.request.archive_sha256 ||
      archive.byte_size !== b.request.archive_bytes
    )
      throw new EvidenceError('archive_unverified', 409);
    const source = this.sourceFor(b),
      storage = this.storage();
    this.assertStorage(storage, archive.provider, archive.bucket);
    await storage.vault.verifyReceipt(
      {
        bucket: archive.bucket,
        key: archive.object_key,
        versionId: archive.version_id,
        contentHash: archive.content_hash,
        byteSize: archive.byte_size,
        tenantId: t,
        engagementId: source.engagement_id,
        operationId: b.id,
        collectedByAgent: 'pramaan',
        retainUntil: archive.retain_until,
        legalHold: false,
        encryption: archive.encryption,
      },
      options(signal),
    );
    const exact = await storage.vault.retrieve(
      archive.bucket,
      archive.object_key,
      archive.version_id,
      options(signal),
    );
    if (exact.body.length !== archive.byte_size || sha(exact.body) !== archive.content_hash)
      throw new EvidenceError('provider_verification_failed', 503);
    return {
      build: b,
      archive,
      body: exact.body,
      sha256: archive.content_hash,
      byteSize: archive.byte_size,
    };
  }
  async preview(t: string, a: string, id: string, signal?: AbortSignal) {
    return this.exactArchive(t, a, id, signal);
  }
  async review(
    t: string,
    a: string,
    id: string,
    input: { expectedArchiveSha256: string; expectedVersionId: string; note: string },
    signal?: AbortSignal,
  ) {
    const exact = await this.exactArchive(t, a, id, signal);
    if (
      input.expectedArchiveSha256 !== exact.sha256 ||
      input.expectedVersionId !== exact.archive.version_id
    )
      throw new EvidenceError('archive_version_mismatch', 409);
    return this.rpc(
      'review_full_pramaan',
      {
        p_tenant_id: t,
        p_actor_id: a,
        p_dossier_id: id,
        p_expected_archive: input.expectedArchiveSha256,
        p_expected_version: input.expectedVersionId,
        p_note: input.note,
        p_correlation_id: randomUUID(),
      },
      signal,
    );
  }
  async seal(t: string, a: string, id: string, proof: string, signal?: AbortSignal) {
    await this.exactArchive(t, a, id, signal);
    return this.rpc(
      'seal_full_pramaan',
      {
        p_tenant_id: t,
        p_actor_id: a,
        p_dossier_id: id,
        p_expected_proof_seal: proof,
        p_correlation_id: randomUUID(),
      },
      signal,
    );
  }
  async release(
    t: string,
    a: string,
    id: string,
    input: { expectedArchiveSha256: string; expectedVersionId: string },
    signal?: AbortSignal,
  ) {
    const exact = await this.exactArchive(t, a, id, signal);
    if (
      input.expectedArchiveSha256 !== exact.sha256 ||
      input.expectedVersionId !== exact.archive.version_id
    )
      throw new EvidenceError('archive_version_mismatch', 409);
    return this.rpc(
      'release_full_pramaan',
      {
        p_tenant_id: t,
        p_actor_id: a,
        p_dossier_id: id,
        p_expected_archive: input.expectedArchiveSha256,
        p_expected_version: input.expectedVersionId,
        p_correlation_id: randomUUID(),
      },
      signal,
    );
  }
  async archive(t: string, a: string, id: string, signal?: AbortSignal) {
    await this.founder(t, a, signal);
    const released = await this.row(
      'pramaan_full_releases',
      t,
      'dossier_id',
      id,
      z.object({ archive_sha256: digest, archive_version_id: z.string() }),
      signal,
    );
    if (!released) throw new EvidenceError('full_closure_release_required', 409);
    const exact = await this.exactArchive(t, a, id, signal);
    if (
      released.archive_sha256 !== exact.sha256 ||
      released.archive_version_id !== exact.archive.version_id
    )
      throw new EvidenceError('release_version_mismatch', 409);
    return { body: exact.body, sha256: exact.sha256, byteSize: exact.byteSize };
  }
}
