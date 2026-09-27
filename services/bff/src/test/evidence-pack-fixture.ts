import { createHash, randomUUID } from 'node:crypto';
import { UserRole } from '@axiom/types';
import { EvidenceIngestionService, type EvidenceDatabase } from '../services/evidence-ingestion.js';
import { EvidencePackService } from '../services/evidence-packs.js';
import { abortableResult } from './abortable-result.js';
import { evidenceFixture, tenant, actor, config, upload, dataBody } from './evidence-fixture.js';

type Row = Record<string, unknown>;
const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
export async function packFixture() {
  const base = evidenceFixture();
  await new EvidenceIngestionService(base.db, base.vault, config).ingest(tenant, actor, upload);
  const owner = actor;
  const founder = randomUUID();
  const viewer = randomUUID();
  for (const [user, role] of [
    [owner, UserRole.OWNER],
    [founder, UserRole.FOUNDER],
    [viewer, UserRole.VIEWER],
  ] as const) {
    base.rows('tenant_users').push({ tenant_id: tenant, user_id: user, role });
    base.rows('users').push({ id: user, is_axiom_internal: user === founder });
  }
  const calls: { fn: string; args: Row }[] = [];
  const faults = {
    begin: false,
    stallBegin: false,
    settle: false,
    settleResponseLost: false,
    note: false,
  };
  let storedArchive: Buffer | null = null;
  const now = '2026-09-27T00:00:00.000Z';
  const rpc = async (fn: string, args: Row) => {
    calls.push({ fn, args });
    if (fn === 'prepare_evidence_pack') {
      const old = base.rows('evidence_packs').find((p) => p.operation_key === args.p_operation_key);
      if (old) return { data: { pack_id: old.id, replayed: true }, error: null };
      const id = randomUUID();
      const reportId = randomUUID();
      const evidence = base.rows('evidence')[0]!;
      const receipt = base.rows('evidence_object_versions')[0]!;
      const manifest = {
        schema_version: 1,
        serialization: 'postgres-jsonb-text-v1',
        kind: 'evidence_pack',
        pack_id: id,
        tenant_id: tenant,
        engagement_id: null,
        title: args.p_title,
        created_at: now,
        library_version: '0.1.1',
        branding: {
          product: 'Axiom Proof',
          company: 'Axiom Minds Private Limited',
          company_url: 'https://axiomminds.ai',
        },
        generator: { name: 'evidence-pack-builder', version: '1' },
        members: [
          {
            evidence_id: evidence.id,
            receipt_id: receipt.id,
            version_id: receipt.version_id,
            path: `evidence/${evidence.id}.bin`,
            content_hash: receipt.content_hash,
            byte_size: receipt.byte_size,
            filename: 'fixture.txt',
            mime_type: 'text/plain',
            description: 'Synthetic fixture',
            evidence_type: 'document',
            collected_by_agent: 'human',
            collected_at: now,
            control_ids: [],
            provenance: 'human_submitted',
          },
        ],
        limitations: ['Human-submitted material; no inferred production provenance.'],
      };
      const text = JSON.stringify(manifest);
      const digest = hash(text);
      base.rows('reports').push({
        id: reportId,
        tenant_id: tenant,
        engagement_id: null,
        kind: 'evidence_pack',
        title: args.p_title,
        library_version: '0.1.1',
        generated_by_agent: 'evidence-pack-builder',
        generated_at: now,
        created_by: args.p_actor_id,
        status: 'draft',
        content: manifest,
        content_text: text,
        content_sha256: digest,
        reviewed_content_hash: null,
        published_at: null,
        released_by: null,
        released_archive_hash: null,
      });
      base.rows('evidence_packs').push({
        id,
        tenant_id: tenant,
        report_id: reportId,
        operation_key: args.p_operation_key,
        created_by: args.p_actor_id,
        created_at: now,
        engagement_id: null,
        library_version: '0.1.1',
        title: args.p_title,
        manifest_text: text,
        manifest_sha256: digest,
        member_count: 1,
        total_member_bytes: dataBody.length,
      });
      return { data: { pack_id: id, report_id: reportId, replayed: false }, error: null };
    }
    if (fn === 'review_report') {
      const report = base.rows('reports').find((r) => r.id === args.p_report_id)!;
      const pack = base.rows('evidence_packs').find((p) => p.report_id === report.id)!;
      if (args.p_expected_content_hash !== report.content_sha256)
        return { data: { error: 'manifest_changed' }, error: null };
      const text = JSON.stringify({
        schema_version: 1,
        pack_id: pack.id,
        manifest_sha256: pack.manifest_sha256,
        decision: args.p_decision,
        reviewer: { id: founder, display_name: 'Fixture founder' },
        reviewed_at: now,
      });
      const review = {
        id: randomUUID(),
        tenant_id: tenant,
        report_id: report.id,
        decision: args.p_decision,
        content_sha256: report.content_sha256,
        reviewed_by: founder,
        reviewer_name: 'Fixture founder',
        reviewed_at: now,
        note: args.p_note ?? null,
        review_text: text,
        review_sha256: hash(text),
      };
      base.rows('report_reviews').push(review);
      report.status = args.p_decision;
      report.reviewed_content_hash = report.content_sha256;
      return {
        data: { reportId: report.id, status: report.status, contentHash: report.content_sha256 },
        error: null,
      };
    }
    if (fn === 'begin_evidence_pack_build') {
      if (faults.stallBegin) return new Promise<never>(() => {});
      if (faults.begin) return { data: null, error: { message: 'private diagnostic' } };
      const old = base.rows('evidence_pack_builds').find((b) => b.pack_id === args.p_pack_id);
      if (old) return { data: { build_id: old.id, replayed: true }, error: null };
      const build = {
        id: randomUUID(),
        tenant_id: tenant,
        pack_id: args.p_pack_id,
        operation_key: args.p_operation_key,
        actor_id: args.p_actor_id,
        status: 'pending',
        request: args.p_request,
        retain_until: '2033-09-27T00:00:01.000Z',
        correlation_id: args.p_correlation_id,
        last_error_code: null,
        created_at: now,
        settled_at: null,
      };
      base.rows('evidence_pack_builds').push(build);
      return { data: { build_id: build.id, replayed: false }, error: null };
    }
    if (fn === 'settle_evidence_pack_build') {
      if (faults.settle) return { data: null, error: { message: 'private diagnostic' } };
      const build = base.rows('evidence_pack_builds').find((b) => b.id === args.p_build_id)!;
      const receipt = args.p_receipt as Row;
      if (build.status !== 'settled')
        base.rows('evidence_pack_archives').push({
          id: randomUUID(),
          tenant_id: tenant,
          pack_id: build.pack_id,
          build_id: build.id,
          ...receipt,
        });
      build.status = 'settled';
      build.settled_at = now;
      build.last_error_code = null;
      if (faults.settleResponseLost) return { data: null, error: { message: 'response lost' } };
      return { data: { build_id: build.id, status: 'settled' }, error: null };
    }
    if (fn === 'note_evidence_pack_build_failure') {
      if (faults.note) return { data: null, error: { message: 'response lost' } };
      const build = base.rows('evidence_pack_builds').find((b) => b.id === args.p_build_id)!;
      if (build.status !== 'settled') build.last_error_code = args.p_error_code;
      return { data: { status: build.status }, error: null };
    }
    if (fn === 'release_report') {
      const report = base.rows('reports').find((r) => r.id === args.p_report_id)!;
      const pack = base.rows('evidence_packs').find((p) => p.report_id === report.id)!;
      const archive = base.rows('evidence_pack_archives').find((a) => a.pack_id === pack.id);
      if (!archive) return { data: { error: 'build_not_settled' }, error: null };
      if (
        args.p_expected_content_hash !== report.content_sha256 ||
        args.p_expected_archive_hash !== archive.content_hash
      )
        return { data: { error: 'archive_hash_mismatch' }, error: null };
      report.status = 'published';
      report.released_archive_hash = archive.content_hash;
      report.released_by = founder;
      report.published_at = now;
      return {
        data: { reportId: report.id, status: 'published', archiveHash: archive.content_hash },
        error: null,
      };
    }
    throw new Error(`Unexpected fixture RPC ${fn}`);
  };
  const db = {
    ...base.db,
    rpc: (fn: string, args: Row) => abortableResult(rpc(fn, args)),
  } as unknown as EvidenceDatabase;
  base.vault.seal.mockImplementation(async (input) => {
    storedArchive = Buffer.from(input.body);
    return {
      ...base.verified,
      bucket: input.bucket,
      key: input.key,
      versionId: 'archive-version',
      contentHash: hash(storedArchive),
      byteSize: storedArchive.length,
      retainUntil: input.retainUntil!,
    };
  });
  base.vault.verifyReceipt.mockImplementation(async (input) => ({
    ...base.verified,
    bucket: input.bucket,
    key: input.key,
    versionId: input.versionId,
    contentHash: input.contentHash,
    byteSize: input.byteSize,
    retainUntil: input.retainUntil,
    readbackAt: now,
  }));
  base.vault.retrieve.mockImplementation(async (_bucket, _key, versionId) => {
    const body = Buffer.from(versionId === 'archive-version' ? storedArchive! : dataBody);
    return {
      body,
      contentHash: hash(body),
      metadata: {},
      contentType: 'application/octet-stream',
      retainUntil: new Date(base.verified.retainUntil),
      lockMode: 'COMPLIANCE',
      versionId,
      encryption: 'AES256',
    };
  });
  base.vault.findEvidenceVersion.mockResolvedValue({ versionId: 'archive-version' });
  base.vault.seal.mockClear();
  base.vault.verifyReceipt.mockClear();
  const service = new EvidencePackService(db, () => ({ vault: base.vault, config }));
  const input = {
    operationKey: randomUUID(),
    title: 'Fixture pack',
    evidenceReceiptIds: [String(base.rows('evidence_object_versions')[0]!.id)],
  };
  const prepare = async () => service.prepare(await service.access(tenant, owner), input);
  const approve = async () => {
    const pack = await prepare();
    await service.rpc('review_report', {
      p_report_id: pack.report.id,
      p_expected_content_hash: pack.pack.manifest_sha256,
      p_decision: 'approved',
    });
    return service.detail(await service.access(tenant, owner), pack.pack.id);
  };
  return {
    base,
    db,
    service,
    owner,
    founder,
    viewer,
    input,
    prepare,
    approve,
    calls,
    faults,
    storedArchive: () => storedArchive,
  };
}
