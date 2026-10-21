import { BrandedSourceV6Schema, verifyBrandedSource } from './branded-report';
import { ClarifiedSourceV8Schema, verifyClarifiedSource } from './clarified-report';
import {
  CoverageFirstSourceV4Schema,
  parseCoverageFirstJson,
  verifyCoverageFirstSource,
} from './coverage-first-source';
import {
  QuestionnaireEvidenceSourceV5Schema,
  verifyQuestionnaireEvidenceSource,
} from './questionnaire-evidence-report';
import { parseCatalogueJson } from '@axiom/control-library';
/** Exact-version derivative archives for published, source-bound reports. */
import { createHash } from 'node:crypto';
import { zipSync, type Zippable } from 'fflate';
import { z } from 'zod';
import { FrozenBoardSourceSchema } from './board-source';
import { FrozenAuditorSourceSchema } from './auditor-source';
import {
  verifyFrozenHumanControlReviewWithAsset,
  verifyFrozenHumanControlReview,
} from './public-control-provenance';
import { BRANDING } from './branding';

const uuid = z.uuid();
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const inputSchema = z.object({
  tenantId: uuid,
  engagementId: uuid,
  reportId: uuid,
  requestId: uuid,
  title: z.string().trim().min(1).max(300),
  source: z.object({ id: uuid, versionId: z.string().min(1).max(1024), sha256: digest }),
  pdf: z.object({ id: uuid, versionId: z.string().min(1).max(1024), sha256: digest }),
});

export type PramaanSourceArchiveInput = z.infer<typeof inputSchema> & {
  sourceBytes: Uint8Array;
  pdfBytes: Uint8Array;
};
export type PramaanBoardArchiveInput = PramaanSourceArchiveInput;

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Versioned envelopes are unwrapped only for validation; the ZIP retains the original
 * exact provider source bytes and digest, never this derived inner view. */
function archiveValidationSource(
  kind: 'board' | 'auditor',
  input: PramaanSourceArchiveInput,
  scope: z.infer<typeof inputSchema>,
): string {
  const text = Buffer.from(input.sourceBytes).toString('utf8');
  const version = JSON.parse(text).schema_version;
  if (version === 8) {
    const envelope = ClarifiedSourceV8Schema.parse(parseCoverageFirstJson(text, 4 * 1024 * 1024));
    if (envelope.report_kind !== kind) throw Error('Clarified archive kind refused');
    z.object({ schema_version: z.literal(6) }).parse(
      parseCoverageFirstJson(envelope.retained_source.text, 4 * 1024 * 1024),
    );
    const validation = archiveValidationSource(
      kind,
      { ...input, sourceBytes: Buffer.from(envelope.retained_source.text) },
      { ...scope, source: { ...scope.source, sha256: envelope.retained_source.sha256 } },
    );
    const original = z.object({ assessment_run_id: uuid }).parse(JSON.parse(validation));
    verifyClarifiedSource(text, scope.source.sha256, {
      tenantId: scope.tenantId,
      engagementId: scope.engagementId,
      requestId: scope.requestId,
      assessmentRunId: original.assessment_run_id,
    });
    return validation;
  }
  if (version === 6) {
    const envelope = BrandedSourceV6Schema.parse(parseCoverageFirstJson(text, 4 * 1024 * 1024));
    if (
      envelope.report_kind !== kind ||
      ![4, 5].includes(
        Number(
          (
            parseCoverageFirstJson(envelope.retained_source.text, 4 * 1024 * 1024) as {
              schema_version?: unknown;
            }
          ).schema_version,
        ),
      )
    )
      throw Error('Branded archive kind refused');
    const validation = archiveValidationSource(
      kind,
      { ...input, sourceBytes: Buffer.from(envelope.retained_source.text) },
      { ...scope, source: { ...scope.source, sha256: envelope.retained_source.sha256 } },
    );
    const original = z.object({ assessment_run_id: z.uuid() }).parse(JSON.parse(validation));
    verifyBrandedSource(text, scope.source.sha256, {
      tenantId: scope.tenantId,
      engagementId: scope.engagementId,
      requestId: scope.requestId,
      assessmentRunId: original.assessment_run_id,
    });
    return validation;
  }
  if (version === 5) {
    const envelope = QuestionnaireEvidenceSourceV5Schema.parse(
      parseCoverageFirstJson(text, 4 * 1024 * 1024),
    );
    if (envelope.report_kind !== kind) throw Error('Questionnaire archive kind refused');
    const original = z
      .object({ assessment_run_id: z.uuid() })
      .parse(JSON.parse(envelope.retained_source.text));
    verifyQuestionnaireEvidenceSource(text, scope.source.sha256, {
      tenantId: scope.tenantId,
      engagementId: scope.engagementId,
      requestId: scope.requestId,
      assessmentRunId: original.assessment_run_id,
    });
    return envelope.retained_source.text;
  }
  if (version !== 4) return text;
  const envelope = CoverageFirstSourceV4Schema.parse(parseCoverageFirstJson(text, 4 * 1024 * 1024));
  if (envelope.report_kind !== kind) throw Error('Coverage archive kind refused');
  const original = z
    .object({ assessment_run_id: z.uuid() })
    .parse(JSON.parse(envelope.retained_source.text));
  verifyCoverageFirstSource(text, scope.source.sha256, {
    tenantId: scope.tenantId,
    engagementId: scope.engagementId,
    requestId: scope.requestId,
    assessmentRunId: original.assessment_run_id,
  });
  return envelope.retained_source.text;
}
/** The archive contains the exact source and PDF bytes, plus a bounded claim manifest. */
export function buildPramaanBoardArchive(input: PramaanBoardArchiveInput) {
  const parsed = inputSchema.parse(input);
  if (
    input.sourceBytes.length < 1 ||
    input.sourceBytes.length > 4 * 1024 * 1024 ||
    input.pdfBytes.length < 500 ||
    input.pdfBytes.length > 32 * 1024 * 1024 ||
    sha(input.sourceBytes) !== parsed.source.sha256 ||
    sha(input.pdfBytes) !== parsed.pdf.sha256 ||
    !Buffer.from(input.pdfBytes.subarray(0, 5)).equals(Buffer.from('%PDF-'))
  ) {
    throw new Error('Pramaan source bytes do not match exact provider versions');
  }
  const validationText = archiveValidationSource('board', input, parsed);
  const source = z
    .object({
      schema_version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      kind: z.literal('board_source'),
      tenant_id: uuid,
      engagement_id: uuid,
      request_id: uuid,
    })
    .parse(JSON.parse(validationText));
  if (
    source.tenant_id !== parsed.tenantId ||
    source.engagement_id !== parsed.engagementId ||
    source.request_id !== parsed.requestId
  )
    throw new Error('Pramaan source belongs to a different tenant, engagement, or board request');
  const rawSource = (
    source.schema_version !== 1
      ? parseCatalogueJson(validationText, 4 * 1024 * 1024)
      : JSON.parse(validationText)
  ) as Record<string, unknown>;
  if (source.schema_version !== 1) {
    const frozen = FrozenBoardSourceSchema.parse(rawSource);
    if (frozen.schema_version === 1) throw new Error('Public review archive source refused');
    (frozen.schema_version === 3
      ? verifyFrozenHumanControlReviewWithAsset
      : verifyFrozenHumanControlReview)(frozen.human_control_review, {
      tenantId: parsed.tenantId,
      engagementId: parsed.engagementId,
      assessmentRunId: frozen.assessment_run_id,
      libraryVersion: frozen.library_version,
      controlsText: frozen.controls_text,
      resultText: frozen.result_text,
    });
  } else if (Object.hasOwn(rawSource, 'human_control_review'))
    throw new Error('Public review archive downgrade refused');
  const manifest = {
    schema_version: 1,
    kind: 'pramaan_board_executive_source_archive',
    title: parsed.title,
    branding: {
      product: BRANDING.product,
      company: BRANDING.company,
      company_url: BRANDING.company_url,
    },
    tenant_id: parsed.tenantId,
    engagement_id: parsed.engagementId,
    source_report_id: parsed.reportId,
    source_request_id: parsed.requestId,
    source_merkle_root: sha(
      Buffer.concat([
        Buffer.from([1]),
        Buffer.from(parsed.source.sha256, 'hex'),
        Buffer.from(parsed.pdf.sha256, 'hex'),
      ]),
    ),
    source: {
      path: 'source/assessment.json',
      ...parsed.source,
      byte_size: input.sourceBytes.length,
    },
    board_pdf: { path: 'source/board-report.pdf', ...parsed.pdf, byte_size: input.pdfBytes.length },
    limitations: [
      'This is a derivative of a published board report, not an auditor attestation or DPB submission.',
      'Source/version identifiers and hashes support verification; they do not assert statutory completeness.',
      'Founder sealing is recorded outside this archive and must be checked against the audit ledger.',
    ],
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
  const fixed = {
    level: 0 as const,
    // fflate encodes ZIP DOS date fields with local Date getters. Supplying
    // the same local calendar fields yields identical archive bytes in every TZ.
    mtime: new Date(1980, 0, 1),
    os: 3 as const,
    attrs: 0o100644 << 16,
  };
  const files: Zippable = Object.create(null) as Zippable;
  files['manifest.json'] = [manifestBytes, fixed];
  files['source/assessment.json'] = [input.sourceBytes, fixed];
  files['source/board-report.pdf'] = [input.pdfBytes, fixed];
  const archive = Buffer.from(zipSync(files, { level: 0 }));
  if (archive.length > 64 * 1024 * 1024) throw new Error('Pramaan archive exceeds byte limit');
  return {
    manifest,
    manifestSha256: sha(manifestBytes),
    archive,
    archiveSha256: sha(archive),
    byteSize: archive.length,
  };
}

/** Assessment-derived auditor archive. This does not assert independent audit assurance. */
export function buildPramaanAuditorArchive(input: PramaanSourceArchiveInput) {
  const parsed = inputSchema.parse(input);
  if (
    input.sourceBytes.length < 1 ||
    input.sourceBytes.length > 4 * 1024 * 1024 ||
    input.pdfBytes.length < 500 ||
    input.pdfBytes.length > 32 * 1024 * 1024 ||
    sha(input.sourceBytes) !== parsed.source.sha256 ||
    sha(input.pdfBytes) !== parsed.pdf.sha256 ||
    !Buffer.from(input.pdfBytes.subarray(0, 5)).equals(Buffer.from('%PDF-'))
  )
    throw new Error('Pramaan source bytes do not match exact provider versions');
  const validationText = archiveValidationSource('auditor', input, parsed);
  const source = z
    .object({
      schema_version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      kind: z.literal('statutory_source'),
      report_kind: z.literal('auditor'),
      tenant_id: uuid,
      engagement_id: uuid,
      request_id: uuid,
    })
    .parse(JSON.parse(validationText));
  if (
    source.tenant_id !== parsed.tenantId ||
    source.engagement_id !== parsed.engagementId ||
    source.request_id !== parsed.requestId
  )
    throw new Error('Pramaan source belongs to a different tenant, engagement, or auditor request');
  const rawSource = (
    source.schema_version !== 1
      ? parseCatalogueJson(validationText, 4 * 1024 * 1024)
      : JSON.parse(validationText)
  ) as Record<string, unknown>;
  if (source.schema_version !== 1) {
    const frozen = FrozenAuditorSourceSchema.parse(rawSource);
    if (frozen.schema_version === 1) throw new Error('Public review archive source refused');
    (frozen.schema_version === 3
      ? verifyFrozenHumanControlReviewWithAsset
      : verifyFrozenHumanControlReview)(frozen.human_control_review, {
      tenantId: parsed.tenantId,
      engagementId: parsed.engagementId,
      assessmentRunId: frozen.assessment_run_id,
      libraryVersion: frozen.library_version,
      controlsText: frozen.controls_text,
      resultText: frozen.result_text,
    });
  } else if (Object.hasOwn(rawSource, 'human_control_review'))
    throw new Error('Public review archive downgrade refused');
  const manifest = {
    schema_version: 1,
    kind: 'pramaan_auditor_assurance_source_archive',
    title: parsed.title,
    branding: {
      product: BRANDING.product,
      company: BRANDING.company,
      company_url: BRANDING.company_url,
    },
    tenant_id: parsed.tenantId,
    engagement_id: parsed.engagementId,
    source_report_id: parsed.reportId,
    source_request_id: parsed.requestId,
    source_merkle_root: sha(
      Buffer.concat([
        Buffer.from([1]),
        Buffer.from(parsed.source.sha256, 'hex'),
        Buffer.from(parsed.pdf.sha256, 'hex'),
      ]),
    ),
    source: {
      path: 'source/assessment.json',
      ...parsed.source,
      byte_size: input.sourceBytes.length,
    },
    auditor_pdf: {
      path: 'source/auditor-review-pack.pdf',
      ...parsed.pdf,
      byte_size: input.pdfBytes.length,
    },
    limitations: [
      'This assessment-derived archive is not an independent audit, auditor attestation, or evidence certification.',
      'Source/version identifiers and hashes support verification; they do not assert statutory completeness.',
      'Founder sealing is recorded outside this archive and must be checked against the audit ledger.',
    ],
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
  const fixed = {
    level: 0 as const,
    mtime: new Date(1980, 0, 1),
    os: 3 as const,
    attrs: 0o100644 << 16,
  };
  const files: Zippable = Object.create(null) as Zippable;
  files['manifest.json'] = [manifestBytes, fixed];
  files['source/assessment.json'] = [input.sourceBytes, fixed];
  files['source/auditor-review-pack.pdf'] = [input.pdfBytes, fixed];
  const archive = Buffer.from(zipSync(files, { level: 0 }));
  if (archive.length > 64 * 1024 * 1024) throw new Error('Pramaan archive exceeds byte limit');
  return {
    manifest,
    manifestSha256: sha(manifestBytes),
    archive,
    archiveSha256: sha(archive),
    byteSize: archive.length,
  };
}

/** A derivative of a released technical plan review pack, not execution assurance. */
export function buildPramaanTechnicalArchive(input: PramaanSourceArchiveInput) {
  const parsed = inputSchema.parse(input);
  if (
    input.sourceBytes.length < 1 ||
    input.sourceBytes.length > 4 * 1024 * 1024 ||
    input.pdfBytes.length < 500 ||
    input.pdfBytes.length > 32 * 1024 * 1024 ||
    sha(input.sourceBytes) !== parsed.source.sha256 ||
    sha(input.pdfBytes) !== parsed.pdf.sha256 ||
    !Buffer.from(input.pdfBytes.subarray(0, 5)).equals(Buffer.from('%PDF-'))
  )
    throw new Error('Pramaan source bytes do not match exact provider versions');
  const source = z
    .object({
      schema_version: z.literal(1),
      kind: z.literal('technical_plan_source'),
      tenant_id: uuid,
      request_id: uuid,
      plan: z.object({ engagement_id: uuid }).passthrough(),
    })
    .parse(JSON.parse(Buffer.from(input.sourceBytes).toString('utf8')));
  if (
    source.tenant_id !== parsed.tenantId ||
    source.request_id !== parsed.requestId ||
    source.plan.engagement_id !== parsed.engagementId
  )
    throw new Error(
      'Pramaan source belongs to a different tenant, engagement, or technical request',
    );
  const manifest = {
    schema_version: 1,
    kind: 'pramaan_technical_register_source_archive',
    title: parsed.title,
    branding: {
      product: BRANDING.product,
      company: BRANDING.company,
      company_url: BRANDING.company_url,
    },
    tenant_id: parsed.tenantId,
    engagement_id: parsed.engagementId,
    source_report_id: parsed.reportId,
    source_request_id: parsed.requestId,
    source_merkle_root: sha(
      Buffer.concat([
        Buffer.from([1]),
        Buffer.from(parsed.source.sha256, 'hex'),
        Buffer.from(parsed.pdf.sha256, 'hex'),
      ]),
    ),
    source: {
      path: 'source/recorded-plan.json',
      ...parsed.source,
      byte_size: input.sourceBytes.length,
    },
    technical_pdf: {
      path: 'source/technical-review-pack.pdf',
      ...parsed.pdf,
      byte_size: input.pdfBytes.length,
    },
    limitations: [
      'This archive repeats recorded plan and action claims; it does not independently certify execution, rollback, verification, or closure.',
      'Source/version identifiers and hashes support verification; they do not assert statutory completeness.',
      'Founder sealing is recorded outside this archive and must be checked against the audit ledger.',
    ],
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
  const fixed = {
    level: 0 as const,
    mtime: new Date(1980, 0, 1),
    os: 3 as const,
    attrs: 0o100644 << 16,
  };
  const files: Zippable = Object.create(null) as Zippable;
  files['manifest.json'] = [manifestBytes, fixed];
  files['source/recorded-plan.json'] = [input.sourceBytes, fixed];
  files['source/technical-review-pack.pdf'] = [input.pdfBytes, fixed];
  const archive = Buffer.from(zipSync(files, { level: 0 }));
  if (archive.length > 64 * 1024 * 1024) throw new Error('Pramaan archive exceeds byte limit');
  return {
    manifest,
    manifestSha256: sha(manifestBytes),
    archive,
    archiveSha256: sha(archive),
    byteSize: archive.length,
  };
}

/** Tenant-level derivative of a released breach/notification review pack, not regulator receipt. */
export function buildPramaanDpbArchive(
  input: Omit<PramaanSourceArchiveInput, 'engagementId'> & { engagementId: null },
) {
  const parsed = inputSchema.omit({ engagementId: true }).parse(input);
  if (
    input.sourceBytes.length < 1 ||
    input.sourceBytes.length > 4 * 1024 * 1024 ||
    input.pdfBytes.length < 500 ||
    input.pdfBytes.length > 32 * 1024 * 1024 ||
    sha(input.sourceBytes) !== parsed.source.sha256 ||
    sha(input.pdfBytes) !== parsed.pdf.sha256 ||
    !Buffer.from(input.pdfBytes.subarray(0, 5)).equals(Buffer.from('%PDF-'))
  )
    throw new Error('Pramaan source bytes do not match exact provider versions');
  const source = z
    .object({
      schema_version: z.literal(1),
      kind: z.literal('dpb_breach_source'),
      tenant_id: uuid,
      request_id: uuid,
      breach: z.object({ id: uuid }).passthrough(),
      notification: z.object({ id: uuid }).passthrough(),
    })
    .parse(JSON.parse(Buffer.from(input.sourceBytes).toString('utf8')));
  if (source.tenant_id !== parsed.tenantId || source.request_id !== parsed.requestId)
    throw new Error('Pramaan source belongs to a different tenant or DPB request');
  const manifest = {
    schema_version: 1,
    kind: 'pramaan_dpb_recorded_notification_source_archive',
    title: parsed.title,
    branding: {
      product: BRANDING.product,
      company: BRANDING.company,
      company_url: BRANDING.company_url,
    },
    tenant_id: parsed.tenantId,
    engagement_id: null,
    source_report_id: parsed.reportId,
    source_request_id: parsed.requestId,
    breach_id: source.breach.id,
    notification_id: source.notification.id,
    source_merkle_root: sha(
      Buffer.concat([
        Buffer.from([1]),
        Buffer.from(parsed.source.sha256, 'hex'),
        Buffer.from(parsed.pdf.sha256, 'hex'),
      ]),
    ),
    source: {
      path: 'source/recorded-breach-notification.json',
      ...parsed.source,
      byte_size: input.sourceBytes.length,
    },
    dpb_pdf: {
      path: 'source/dpb-review-pack.pdf',
      ...parsed.pdf,
      byte_size: input.pdfBytes.length,
    },
    limitations: [
      'This archive contains a recorded breach and reviewed notification; it does not verify regulator receipt, acceptance, or statutory filing.',
      'Source/version identifiers and hashes support verification; they do not assert forensic truth or statutory completeness.',
      'Founder sealing is recorded outside this archive and must be checked against the audit ledger.',
    ],
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
  const fixed = {
    level: 0 as const,
    mtime: new Date(1980, 0, 1),
    os: 3 as const,
    attrs: 0o100644 << 16,
  };
  const files: Zippable = Object.create(null) as Zippable;
  files['manifest.json'] = [manifestBytes, fixed];
  files['source/recorded-breach-notification.json'] = [input.sourceBytes, fixed];
  files['source/dpb-review-pack.pdf'] = [input.pdfBytes, fixed];
  const archive = Buffer.from(zipSync(files, { level: 0 }));
  if (archive.length > 64 * 1024 * 1024) throw new Error('Pramaan archive exceeds byte limit');
  return {
    manifest,
    manifestSha256: sha(manifestBytes),
    archive,
    archiveSha256: sha(archive),
    byteSize: archive.length,
  };
}
