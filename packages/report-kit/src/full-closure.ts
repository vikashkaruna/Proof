/** Deterministic closure composition. SQL/provider custody and founder release
 * are verified by the authoritative lifecycle, never inferred from this builder. */
import { createHash } from 'node:crypto';
import { zipSync, unzipSync, type Zippable } from 'fflate';
import { z } from 'zod';
import { FULL_CLOSURE_OFFLINE_VERIFIER } from './full-closure-verifier.js';
import { parseCatalogueJson } from '@axiom/control-library';
const uuid = z.uuid(),
  digest = z.string().regex(/^[a-f0-9]{64}$/);
export const FullClosureComponentSchema = z
  .object({
    id: uuid,
    kind: z.enum([
      'board_executive',
      'auditor_assurance',
      'technical_register',
      'approval_proof',
      'evidence',
    ]),
    tenant_id: uuid,
    engagement_id: uuid,
    provider_engagement_id: uuid.nullable(),
    legal_hold: z.boolean(),
    operation_id: uuid,
    provider: z.enum(['s3', 's3-compatible']),
    bucket: z.string().min(3),
    object_key: z.string().min(1),
    version_id: z
      .string()
      .min(1)
      .max(1024)
      .refine((v) => v !== 'null'),
    content_hash: digest,
    byte_size: z
      .number()
      .int()
      .positive()
      .max(64 * 1024 * 1024),
    retain_until: z.iso.datetime({ offset: true }),
    encryption: z.enum(['AES256', 'aws:kms']),
    collected_by_agent: z.string().min(1),
  })
  .passthrough();
export type FullClosureComponent = z.infer<typeof FullClosureComponentSchema>;
export const FullClosureSourceSchema = z
  .object({
    schema_version: z.literal(1),
    kind: z.literal('full_closure_source'),
    tenant_id: uuid,
    engagement_id: uuid,
    board_report_id: uuid,
    assessment_run_id: uuid,
    library_version: z.string().min(1),
    findings: z
      .array(z.object({ id: uuid, status: z.literal('closed') }).passthrough())
      .min(1)
      .max(500),
    plans: z
      .array(z.object({ id: uuid, status: z.literal('completed') }).passthrough())
      .min(1)
      .max(50),
    components: z.array(FullClosureComponentSchema).min(5).max(128),
    reconciliations: z
      .array(
        z
          .object({
            archive_id: uuid,
            plan_id: uuid,
            batch_id: uuid,
            source_sha256: digest,
            reconciliation: z.record(z.string(), z.unknown()),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    ledger_chain: z
      .array(
        z
          .object({
            sequence_no: z.string().regex(/^[1-9][0-9]*$/),
            payload_text: z.string().max(262144),
            entry_hash: digest,
            previous_hash: digest.nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(5000),
    ledger_head: digest,
    as_of_sequence: z.string().regex(/^[1-9][0-9]*$/),
    statutory_completeness_asserted: z.literal(false),
    independent_audit_asserted: z.literal(false),
  })
  .strict();
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
export function verifyFullClosureSource(
  text: string,
  expectedSha256: string,
  scope: { tenantId: string; engagementId: string; reportId: string },
) {
  if (sha(text) !== expectedSha256) throw Error('full_closure_source_digest_refused');
  const source = FullClosureSourceSchema.parse(parseCatalogueJson(text, 8 * 1024 * 1024));
  if (
    source.tenant_id !== scope.tenantId ||
    source.engagement_id !== scope.engagementId ||
    source.board_report_id !== scope.reportId ||
    source.components.some(
      (c) => c.tenant_id !== scope.tenantId || c.engagement_id !== scope.engagementId,
    ) ||
    new Set(source.components.map((c) => c.id)).size !== source.components.length ||
    source.components.reduce((n, c) => n + c.byte_size, 0) > 48 * 1024 * 1024
  )
    throw Error('full_closure_scope_refused');
  for (const kind of [
    'board_executive',
    'auditor_assurance',
    'technical_register',
    'approval_proof',
    'evidence',
  ])
    if (!source.components.some((c) => c.kind === kind))
      throw Error('full_closure_sources_incomplete');
  let previous: string | null = null;
  for (const [index, entry] of source.ledger_chain.entries()) {
    if (
      entry.sequence_no !== String(index + 1) ||
      entry.previous_hash !== previous ||
      sha(entry.payload_text) !== entry.entry_hash
    )
      throw Error('full_closure_ledger_refused');
    // The DB codec includes the sequence first and predecessor immediately before
    // detail. Do not let a valid payload hash stand in for a different chain link.
    const parts = entry.payload_text.split('|');
    if (parts[0] !== entry.sequence_no || parts[17] !== (previous ?? ''))
      throw Error('full_closure_ledger_binding_refused');
    previous = entry.entry_hash;
  }
  if (
    previous !== source.ledger_head ||
    source.as_of_sequence !== String(source.ledger_chain.length)
  )
    throw Error('full_closure_ledger_head_refused');
  return source;
}
export function fullClosureMerkleRoot(
  sourceSha256: string,
  components: readonly FullClosureComponent[],
) {
  let nodes: Buffer[] = [sourceSha256, ...components.map((c) => c.content_hash)].map((hash) =>
    Buffer.from(sha(Buffer.concat([Buffer.from([0]), Buffer.from(hash, 'hex')])), 'hex'),
  );
  while (nodes.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < nodes.length; i += 2)
      next.push(
        Buffer.from(
          sha(Buffer.concat([Buffer.from([1]), nodes[i]!, nodes[i + 1] ?? nodes[i]!])),
          'hex',
        ),
      );
    nodes = next;
  }
  return nodes[0]!.toString('hex');
}
export function buildPramaanFullClosureArchive(input: {
  tenantId: string;
  engagementId: string;
  reportId: string;
  title: string;
  sourceText: string;
  sourceSha256: string;
  members: readonly { id: string; bytes: Uint8Array }[];
}) {
  const source = verifyFullClosureSource(input.sourceText, input.sourceSha256, input);
  if (
    input.title.trim().length < 1 ||
    input.title.length > 300 ||
    input.members.length !== source.components.length ||
    new Set(input.members.map((m) => m.id)).size !== input.members.length
  )
    throw Error('full_closure_members_refused');
  const files: Zippable = Object.create(null) as Zippable;
  const fixed = {
    level: 0 as const,
    mtime: new Date(1980, 0, 1),
    os: 3 as const,
    attrs: 0o100644 << 16,
  };
  const entries: { path: string; sha256: string; byte_size: number }[] = [];
  function add(path: string, bytes: Uint8Array) {
    entries.push({ path, sha256: sha(bytes), byte_size: bytes.length });
    files[path] = [bytes, fixed];
  }
  add('closure-source.json', Buffer.from(input.sourceText));
  add('reconciliation_statement.json', Buffer.from(JSON.stringify(source.reconciliations)));
  add(
    'ledger_chain_receipt.json',
    Buffer.from(
      JSON.stringify({
        tenant_id: source.tenant_id,
        as_of_sequence: source.as_of_sequence,
        head: source.ledger_head,
        entries: source.ledger_chain,
      }),
    ),
  );
  for (const component of source.components) {
    const member = input.members.find((m) => m.id === component.id);
    if (
      !member ||
      member.bytes.length !== component.byte_size ||
      sha(member.bytes) !== component.content_hash
    )
      throw Error('full_closure_exact_version_refused');
    const extension =
      component.kind === 'approval_proof' ? 'json' : component.kind === 'evidence' ? 'bin' : 'zip';
    add(`components/${component.id}.${extension}`, member.bytes);
  }
  add('verify_full_closure.py', Buffer.from(FULL_CLOSURE_OFFLINE_VERIFIER));
  add(
    'README.txt',
    Buffer.from(
      'Axiom Proof full closure dossier\nThis pack binds the recorded engagement, released assessment/technical sources, retained evidence, approval/execution/reconciliation proofs and a verified ledger prefix. It does not assert independent audit, legal certification or completeness outside the recorded scope. Obtain archive/manifest digests and ledger head independently. Offline verification: python3 verify_full_closure.py PACK.zip --archive-sha256 SHA256 --manifest-sha256 SHA256 --tenant UUID --engagement UUID --report UUID. Use a trusted copy of this verifier and independently supplied digests; a script inside an untrusted archive is not a trust anchor. Founder review, sealing and release are separate ledger events after archive creation and are not self-certified by this ZIP.\n',
    ),
  );
  const manifest = {
    schema_version: 1,
    kind: 'pramaan_full_closure_archive',
    tenant_id: input.tenantId,
    engagement_id: input.engagementId,
    board_report_id: input.reportId,
    title: input.title.trim(),
    source_sha256: input.sourceSha256,
    merkle_root: fullClosureMerkleRoot(input.sourceSha256, source.components),
    members: entries,
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  files['manifest.json'] = [manifestBytes, fixed];
  const archive = Buffer.from(zipSync(files, { level: 0 }));
  if (archive.length > 64 * 1024 * 1024) throw Error('full_closure_archive_too_large');
  return {
    manifest,
    manifestSha256: sha(manifestBytes),
    archive,
    archiveSha256: sha(archive),
    byteSize: archive.length,
    merkleRoot: manifest.merkle_root,
  };
}

/** Offline integrity verification requires independently supplied archive and
 * manifest digests. It verifies recorded bytes, never external legal claims. */
export function verifyPramaanFullClosureArchive(input: {
  archive: Uint8Array;
  archiveSha256: string;
  manifestSha256: string;
  tenantId: string;
  engagementId: string;
  reportId: string;
}) {
  if (input.archive.length > 64 * 1024 * 1024 || sha(input.archive) !== input.archiveSha256)
    throw Error('full_closure_archive_digest_refused');
  const names = new Set<string>();
  let expanded = 0;
  const files = unzipSync(input.archive, {
    filter(file) {
      expanded += file.originalSize;
      if (
        names.has(file.name) ||
        names.size >= 140 ||
        expanded > 64 * 1024 * 1024 ||
        file.compression !== 0 ||
        !/^(manifest\.json|closure-source\.json|reconciliation_statement\.json|ledger_chain_receipt\.json|README\.txt|verify_full_closure\.py|components\/[a-f0-9-]{36}\.(zip|json|bin))$/.test(
          file.name,
        )
      )
        throw Error('full_closure_zip_members_refused');
      names.add(file.name);
      return true;
    },
  });
  const manifestBytes = files['manifest.json'];
  if (!manifestBytes || sha(manifestBytes) !== input.manifestSha256)
    throw Error('full_closure_manifest_digest_refused');
  const manifest = z
    .object({
      schema_version: z.literal(1),
      kind: z.literal('pramaan_full_closure_archive'),
      tenant_id: uuid,
      engagement_id: uuid,
      board_report_id: uuid,
      title: z.string().min(1).max(300),
      source_sha256: digest,
      merkle_root: digest,
      members: z
        .array(
          z
            .object({ path: z.string(), sha256: digest, byte_size: z.number().int().positive() })
            .strict(),
        )
        .max(139),
    })
    .strict()
    .parse(parseCatalogueJson(Buffer.from(manifestBytes).toString('utf8'), 65536));
  const sourceBytes = files['closure-source.json'];
  if (!sourceBytes) throw Error('full_closure_source_missing');
  const source = verifyFullClosureSource(
    Buffer.from(sourceBytes).toString('utf8'),
    manifest.source_sha256,
    input,
  );
  if (
    manifest.tenant_id !== input.tenantId ||
    manifest.engagement_id !== input.engagementId ||
    manifest.board_report_id !== input.reportId ||
    fullClosureMerkleRoot(manifest.source_sha256, source.components) !== manifest.merkle_root ||
    manifest.members.length !== names.size - 1 ||
    new Set(manifest.members.map((m) => m.path)).size !== manifest.members.length
  )
    throw Error('full_closure_manifest_binding_refused');
  for (const member of manifest.members) {
    const bytes = files[member.path];
    if (
      member.path === 'manifest.json' ||
      !bytes ||
      bytes.length !== member.byte_size ||
      sha(bytes) !== member.sha256
    )
      throw Error('full_closure_member_digest_refused');
  }
  const rebuilt = buildPramaanFullClosureArchive({
    ...input,
    title: manifest.title,
    sourceText: Buffer.from(sourceBytes).toString('utf8'),
    sourceSha256: manifest.source_sha256,
    members: source.components.map((component) => ({
      id: component.id,
      bytes:
        files[
          `components/${component.id}.${component.kind === 'approval_proof' ? 'json' : component.kind === 'evidence' ? 'bin' : 'zip'}`
        ] ?? new Uint8Array(),
    })),
  });
  if (
    rebuilt.archiveSha256 !== input.archiveSha256 ||
    rebuilt.manifestSha256 !== input.manifestSha256
  )
    throw Error('full_closure_canonical_archive_refused');
  return { source, manifest };
}
