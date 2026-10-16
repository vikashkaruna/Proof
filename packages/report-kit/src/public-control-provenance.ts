/** Pure verification of a database-frozen human-review appendix. This does not
 * authenticate publication or live ledger custody; the source-freezing writer
 * must verify those before retaining the outer source bytes. No network calls. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { canonicalJson } from '@axiom/ledger';
import {
  parseCatalogueJson,
  PUBLIC_CONTROL_CATALOGUE_V2_MANIFEST_TEXT,
  publicControlCatalogueV2Manifest,
  buildLibrarySeed,
} from '@axiom/control-library';
import {
  PUBLIC_CONTROL_REVIEW_REQUEST_CODEC,
  PUBLIC_CONTROL_REVIEW_SNAPSHOT_CODEC,
  parsePublicControlReviewSetRequestText,
  publicControlReviewSetSnapshotSchema,
  PUBLIC_CONTROL_REVIEW_REQUEST_CODEC_V2,
  PUBLIC_CONTROL_REVIEW_SNAPSHOT_CODEC_V2,
  parsePublicControlReviewSetAnyRequestText,
  publicControlReviewSetSnapshotV2Schema,
  publicControlPayloadV2Schema,
  publicEvidenceCandidateV2Schema,
  validateQuestionnaireProvenance,
} from '@axiom/types';

import { verifyFrozenPublicWebsiteAssetProvenance } from './public-website-asset-provenance';

const uuid = z.uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const receipt = z
  .object({
    id: z
      .string()
      .regex(/^[1-9][0-9]{0,18}$/)
      .refine((s) => BigInt(s) <= 9223372036854775807n),
    entry_hash: digest,
  })
  .strict();
const timestamp = z.iso.datetime({ offset: true });
const text = (max: number) =>
  z
    .string()
    .min(2)
    .refine((s) => Buffer.byteLength(s, 'utf8') <= max);
const pageKind = z.enum(['root', 'privacy', 'contact', 'terms', 'consent']);
const pageSource = z
  .object({
    page: pageKind,
    requestedUrl: z.string().max(8192).nullable(),
    finalUrl: z.string().max(8192).nullable(),
    state: z.enum(['examined', 'unavailable', 'unexamined']),
    contentSha256: digest.nullable(),
  })
  .strict();
export const FrozenHumanControlReviewSchema = z
  .object({
    schema_version: z.literal(1),
    kind: z.literal('public_control_review'),
    tenant_id: uuid,
    engagement_id: uuid,
    estate_id: uuid.nullable(),
    job_id: uuid,
    assessment_run_id: uuid,
    requested_by: uuid,
    worker_input: z
      .object({
        codec: z.literal('axiom-assessment-input-canonical-json-1'),
        text: text(131072),
        sha256: digest,
      })
      .strict(),
    requested_receipt: receipt,
    review: z
      .object({
        id: uuid,
        actor_id: uuid,
        operation_key: uuid,
        request_codec: z.literal(PUBLIC_CONTROL_REVIEW_REQUEST_CODEC),
        request_text: text(131072),
        request_sha256: digest,
        snapshot_codec: z.literal(PUBLIC_CONTROL_REVIEW_SNAPSHOT_CODEC),
        snapshot_text: text(524288),
        snapshot_sha256: digest,
        receipt,
        created_at: timestamp,
      })
      .strict(),
    capture: z
      .object({
        check_id: uuid,
        checked_at: timestamp,
        codec: z.literal('axiom-public-evidence-v2-canonical-json-1'),
        payload_text: text(524288),
        payload_sha256: digest,
        page_sources: z.array(pageSource).min(1).max(5),
        page_sources_text: text(131072),
        page_sources_sha256: digest,
        capture_receipt: receipt,
      })
      .strict(),
    catalogue: z
      .object({
        library_version: z.literal('0.1.1'),
        questionnaire_digest: digest,
        mapping_version: z.literal('public-evidence-1'),
        manifest_text: text(2 * 1024 * 1024),
        manifest_sha256: digest,
      })
      .strict(),
    declarations_verified: z.literal(false),
    evidence_verified: z.literal(false),
    review_required: z.literal(true),
  })
  .strict();
/** Source3 carries the asset packet exclusively inside the exact review2 snapshot. */
export const FrozenHumanControlReviewV2Schema = FrozenHumanControlReviewSchema.extend({
  schema_version: z.literal(2),
  estate_id: uuid,
  review: FrozenHumanControlReviewSchema.shape.review
    .extend({
      request_codec: z.literal(PUBLIC_CONTROL_REVIEW_REQUEST_CODEC_V2),
      snapshot_codec: z.literal(PUBLIC_CONTROL_REVIEW_SNAPSHOT_CODEC_V2),
    })
    .strict(),
}).strict();
export const PublicWebsiteAssetScopeSchema = z
  .object({
    label: z.literal('human-declared asset scope'),
    tenant_id: uuid,
    estate: z
      .object({ id: uuid, name: z.string().max(200), version: z.number().int().positive() })
      .strict(),
    system: z
      .object({ id: uuid, name: z.string().max(200), version: z.number().int().positive() })
      .strict(),
    target: z
      .object({
        id: uuid,
        version: z.number().int().positive(),
        url: z.string().max(2048),
        sha256: digest,
        declared_by: uuid,
        receipt,
      })
      .strict(),
    association: z
      .object({
        id: uuid,
        sha256: digest,
        declared_by: uuid,
        receipt,
        check_id: uuid,
        payload_sha256: digest,
        capture_receipt: z.object({ id: receipt.shape.id, entryHash: digest }).strict(),
        requested_url: z.string().max(2048),
        final_url: z.string().max(2048),
        checked_at: timestamp,
      })
      .strict(),
    ownership_verified: z.literal(false),
    connector_access_granted: z.literal(false),
    review_required: z.literal(true),
    qualification: z.literal(
      'Human-declared asset scope retained with this review. It does not verify website ownership, grant connector access, or establish current inventory or authority.',
    ),
  })
  .strict();
export type PublicWebsiteAssetScope = z.infer<typeof PublicWebsiteAssetScopeSchema>;
export type FrozenHumanControlReviewV2 = z.infer<typeof FrozenHumanControlReviewV2Schema>;
export type FrozenHumanControlReview = z.infer<typeof FrozenHumanControlReviewSchema>;
const hash = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const same = (a: unknown, b: unknown) => {
  if (!isDeepStrictEqual(a, b)) throw new Error('public_review_source_refused');
};
function parsedCanonical<T>(raw: string, schema: z.ZodType<T>, max: number): T {
  const value = schema.parse(parseCatalogueJson(raw, max));
  same(canonicalJson(value), raw);
  return value;
}
function safeUrl(value: string) {
  const parsed = new URL(value);
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  )
    throw new Error('public_review_url_refused');
  return parsed;
}
/** The exact frozen source, not a caller-selected live review, derives every
 * appendix claim. Omitted questions stay Unknown and have no invented rationale. */
function verifyReview(
  raw: unknown,
  scope: {
    tenantId: string;
    engagementId: string;
    assessmentRunId: string;
    libraryVersion: string;
    controlsText: string;
    resultText: string;
  },
  assetBound = false,
) {
  const v = assetBound
    ? FrozenHumanControlReviewV2Schema.parse(raw)
    : FrozenHumanControlReviewSchema.parse(raw);
  same(
    [v.tenant_id, v.engagement_id, v.assessment_run_id, v.catalogue.library_version],
    [scope.tenantId, scope.engagementId, scope.assessmentRunId, scope.libraryVersion],
  );
  for (const [bytes, digestValue] of [
    [v.worker_input.text, v.worker_input.sha256],
    [v.review.request_text, v.review.request_sha256],
    [v.review.snapshot_text, v.review.snapshot_sha256],
    [v.capture.payload_text, v.capture.payload_sha256],
    [v.capture.page_sources_text, v.capture.page_sources_sha256],
    [v.catalogue.manifest_text, v.catalogue.manifest_sha256],
  ])
    same(hash(bytes!), digestValue);
  same(v.catalogue.manifest_text, PUBLIC_CONTROL_CATALOGUE_V2_MANIFEST_TEXT);
  const request = assetBound
    ? parsePublicControlReviewSetAnyRequestText(v.review.request_text)
    : parsePublicControlReviewSetRequestText(v.review.request_text);
  const snapshot = assetBound
    ? parsedCanonical(v.review.snapshot_text, publicControlReviewSetSnapshotV2Schema, 524288)
    : parsedCanonical(v.review.snapshot_text, publicControlReviewSetSnapshotSchema, 524288);
  const payload = parsedCanonical(v.capture.payload_text, publicControlPayloadV2Schema, 524288);
  if (assetBound) {
    if (snapshot.version !== 2 || request.version !== 2 || !v.estate_id)
      throw new Error('public_review_asset_source_refused');
    const asset = verifyFrozenPublicWebsiteAssetProvenance(snapshot.assetProvenance, {
      tenantId: v.tenant_id,
      estateId: v.estate_id,
      checkId: v.capture.check_id,
      payloadSha256: v.capture.payload_sha256,
      captureReceipt: v.capture.capture_receipt,
      associationRef: request.associationRef,
    });
    const root = v.capture.page_sources.find((p) => p.page === 'root');
    same(root?.requestedUrl, asset.target.url);
    same(root?.finalUrl, asset.association.final_url);
    same(asset.association.checked_at, v.capture.checked_at);
  }

  same(canonicalJson(snapshot.request), v.review.request_text);
  same(
    [
      snapshot.tenantId,
      snapshot.engagementId,
      snapshot.estateId,
      snapshot.checkId,
      snapshot.checkedAt,
      snapshot.captureReceipt,
    ],
    [
      v.tenant_id,
      v.engagement_id,
      v.estate_id,
      v.capture.check_id,
      v.capture.checked_at,
      v.capture.capture_receipt.id,
    ],
  );
  same(request.operationKey, v.review.operation_key);
  same(
    [
      request.expectedSource.payloadSha256,
      request.expectedSource.catalogueManifestSha256,
      request.expectedSource.mappingVersion,
      request.expectedSource.libraryVersion,
      request.expectedSource.questionnaireDigest,
    ],
    [
      v.capture.payload_sha256,
      v.catalogue.manifest_sha256,
      v.catalogue.mapping_version,
      v.catalogue.library_version,
      v.catalogue.questionnaire_digest,
    ],
  );
  const seed = buildLibrarySeed();
  const questionnaire = {
    libraryVersion: seed.version,
    controls: seed.controls
      .map((c) => ({
        id: c.id,
        title: c.title,
        questions: c.assessment_questions.map((q) => ({
          id: q.id,
          prompt: q.prompt,
          type: q.type,
        })),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
  same(hash(canonicalJson(questionnaire)), v.catalogue.questionnaire_digest);
  const pages = z
    .array(pageSource)
    .min(1)
    .max(5)
    .parse(parseCatalogueJson(v.capture.page_sources_text, 131072));
  same(pages, v.capture.page_sources);
  same(pages.map((p) => p.page).sort(), payload.pages.map((p) => p.page).sort());
  if (new Set(pages.map((p) => p.page)).size !== pages.length)
    throw new Error('public_review_pages_refused');
  const root = pages.find((p) => p.page === 'root');
  if (!root?.requestedUrl) throw new Error('public_review_root_refused');
  const origin = safeUrl(root.requestedUrl).origin;
  for (const page of pages) {
    const retained = payload.pages.find((p) => p.page === page.page)!;
    same([page.state, page.contentSha256], [retained.state, retained.contentSha256 ?? null]);
    if (page.state === 'unexamined')
      same([page.requestedUrl, page.finalUrl, page.contentSha256], [null, null, null]);
    else {
      if (!page.requestedUrl || safeUrl(page.requestedUrl).origin !== origin)
        throw new Error('public_review_pages_refused');
      if (page.finalUrl && safeUrl(page.finalUrl).origin !== origin)
        throw new Error('public_review_pages_refused');
      if (page.state === 'examined' && !page.finalUrl)
        throw new Error('public_review_pages_refused');
    }
  }
  const controls = parseCatalogueJson(scope.controlsText, 2 * 1024 * 1024);
  const packetControls = z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        sdf_only: z.boolean(),
        children_only: z.boolean(),
        assessment_questions: z.array(
          z.object({ id: z.string(), prompt: z.string(), type: z.string() }),
        ),
      }),
    )
    .parse(controls);
  const packetQuestionnaire = {
    libraryVersion: v.catalogue.library_version,
    controls: packetControls
      .map((c) => ({ id: c.id, title: c.title, questions: c.assessment_questions }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
  same(canonicalJson(packetQuestionnaire), canonicalJson(questionnaire));
  same(
    packetControls
      .map((c) => ({ id: c.id, sdf_only: c.sdf_only, children_only: c.children_only }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    seed.controls
      .map((c) => ({ id: c.id, sdf_only: c.sdf_only, children_only: c.children_only }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  );

  const result = parseCatalogueJson(scope.resultText, 2 * 1024 * 1024);
  const provenance = validateQuestionnaireProvenance(
    result,
    controls,
    hash(scope.controlsText),
  ).provenance;
  if (!provenance) throw new Error('public_review_questionnaire_refused');
  const input = parsedCanonical(
    v.worker_input.text,
    z
      .object({
        tenant_id: uuid,
        engagement_id: uuid,
        library_version: z.literal('0.1.1'),
        answers: z.record(z.string(), z.record(z.string(), z.boolean().nullable())),
        sdf_self_attested: z.boolean().nullable(),
        processes_children: z.boolean().nullable(),
        processes_health: z.boolean().nullable(),
      })
      .strict(),
    131072,
  );
  same(input, {
    tenant_id: v.tenant_id,
    engagement_id: v.engagement_id,
    library_version: v.catalogue.library_version,
    answers: snapshot.normalizedAnswers,
    sdf_self_attested: request.applicability.sdfSelfAttested,
    processes_children: request.applicability.processesChildren,
    processes_health: request.applicability.processesHealth,
  });
  const manifest = publicControlCatalogueV2Manifest();
  same(
    Object.keys(snapshot.normalizedAnswers).sort(),
    manifest.controls.map((c) => c.control.id).sort(),
  );
  const appendixControls = manifest.controls.map((row) => {
    const id = row.control.id;
    const normalized = snapshot.normalizedAnswers[id]!;
    const questions = row.control.assessmentQuestions;
    same(
      Object.keys(normalized).sort(),
      questions
        .filter((q) => q.type === 'boolean')
        .map((q) => q.id)
        .sort(),
    );
    const packet = provenance.controls.find((c) => c.control_id === id);
    if (!packet) throw new Error('public_review_questionnaire_refused');
    for (const q of packet.questions)
      same(
        q.declaration,
        normalized[q.question_id] === true
          ? 'caller_affirmed'
          : normalized[q.question_id] === false
            ? 'caller_denied'
            : 'unknown',
      );
    return {
      controlId: id,
      title: row.control.title,
      questions: questions.map((q) => {
        const judgment = request.answers[id]?.[q.id];
        const allowed = row.questions.find(
          (item) => item.questionId === q.id,
        )!.publicCandidateFacets;
        if (judgment && q.type !== 'boolean') throw new Error('public_review_judgment_refused');
        const candidates = (judgment?.candidateOrdinals ?? []).map((ordinal) => {
          const candidate = payload.candidates.find((c) => c.ordinal === ordinal);
          if (!candidate || !allowed.includes(candidate.facet))
            throw new Error('public_review_candidate_refused');
          return candidate;
        });
        return {
          questionId: q.id,
          prompt: q.prompt,
          type: q.type,
          judgment: judgment ? 'explicit' : 'omitted',
          answer: q.type === 'boolean' ? (normalized[q.id] ?? null) : null,
          rationale: judgment?.rationale ?? null,
          candidates,
          availableCandidateOrdinals: payload.candidates
            .filter((c) => allowed.includes(c.facet))
            .map((c) => c.ordinal),
        };
      }),
      evidenceRequirements: row.evidenceRequirements.map((r) => ({
        index: r.index,
        requirement: r.requirement,
        state: 'internal_verification_required' as const,
        availableCandidateOrdinals: payload.candidates
          .filter((c) => r.publicCandidateFacets.includes(c.facet))
          .map((c) => c.ordinal),
      })),
    };
  });
  for (const [control, qs] of Object.entries(request.answers)) {
    const row = manifest.controls.find((c) => c.control.id === control);
    if (
      !row ||
      Object.keys(qs).some(
        (q) =>
          !row.control.assessmentQuestions.some((item) => item.id === q && item.type === 'boolean'),
      )
    )
      throw new Error('public_review_judgment_refused');
  }
  for (const [key, packetKey] of [
    ['sdfSelfAttested', 'sdf_self_attested'],
    ['processesChildren', 'processes_children'],
    ['processesHealth', 'processes_health'],
  ] as const)
    same(provenance.applicability[packetKey].value, request.applicability[key]);
  return PublicControlReportAppendixSchema.parse({
    version: 1 as const,
    reviewId: v.review.id,
    reviewActorId: v.review.actor_id,
    reviewedAt: v.review.created_at,
    requestedBy: v.requested_by,
    jobId: v.job_id,
    assessmentRunId: v.assessment_run_id,
    estateId: v.estate_id,
    reviewRequestSha256: v.review.request_sha256,
    reviewSnapshotSha256: v.review.snapshot_sha256,
    capturePayloadSha256: v.capture.payload_sha256,
    captureCheckedAt: v.capture.checked_at,
    captureReceipt: v.capture.capture_receipt,
    reviewReceipt: v.review.receipt,
    requestedReceipt: v.requested_receipt,
    captureAssessmentDate: new Date(v.capture.checked_at).toISOString().slice(0, 10),
    catalogue: {
      baseline: manifest.provenance.baseline,
      defaultEffectiveFrom: manifest.provenance.defaultEffectiveFrom,
      perControlEffectiveDates: manifest.provenance.perControlEffectiveDates,
      effectiveStatus: manifest.provenance.effectiveStatus,
      library_version: v.catalogue.library_version,
      questionnaire_digest: v.catalogue.questionnaire_digest,
      mapping_version: v.catalogue.mapping_version,
      manifest_sha256: v.catalogue.manifest_sha256,
    },
    pages: payload.pages,
    pageSources: pages,
    candidatesTruncated: payload.candidatesTruncated,
    publicCandidates: payload.candidates,
    applicability: request.applicability,
    controls: appendixControls,
    declarationsVerified: false as const,
    evidenceVerified: false as const,
    requiresHumanReview: true as const,
  });
}
export function verifyFrozenHumanControlReview(
  raw: unknown,
  scope: Parameters<typeof verifyReview>[1],
) {
  return verifyReview(raw, scope);
}
export function verifyFrozenHumanControlReviewWithAsset(
  raw: unknown,
  scope: Parameters<typeof verifyReview>[1],
) {
  const public_review_appendix = verifyReview(raw, scope, true);
  const v = FrozenHumanControlReviewV2Schema.parse(raw);
  const snapshot = parsedCanonical(
    v.review.snapshot_text,
    publicControlReviewSetSnapshotV2Schema,
    524288,
  );
  const asset_scope = PublicWebsiteAssetScopeSchema.parse(
    verifyFrozenPublicWebsiteAssetProvenance(snapshot.assetProvenance, {
      tenantId: v.tenant_id,
      estateId: v.estate_id,
      checkId: v.capture.check_id,
      payloadSha256: v.capture.payload_sha256,
      captureReceipt: v.capture.capture_receipt,
      associationRef: snapshot.request.associationRef,
    }),
  );
  return { public_review_appendix, asset_scope };
}
const evidenceRequirement = z
  .object({
    type: z.enum([
      'attestation',
      'config',
      'document',
      'interview',
      'inventory',
      'log',
      'report',
      'screenshot',
    ]),
    description: z.string().min(1).max(10000),
    retention: z.string().max(2000).optional(),
  })
  .strict();
export const PublicControlReportAppendixSchema = z
  .object({
    version: z.literal(1),
    reviewId: uuid,
    reviewActorId: uuid,
    reviewedAt: timestamp,
    requestedBy: uuid,
    jobId: uuid,
    assessmentRunId: uuid,
    estateId: uuid.nullable(),
    reviewRequestSha256: digest,
    reviewSnapshotSha256: digest,
    capturePayloadSha256: digest,
    captureCheckedAt: timestamp,
    captureReceipt: receipt,
    reviewReceipt: receipt,
    requestedReceipt: receipt,
    captureAssessmentDate: z.iso.date(),
    catalogue: FrozenHumanControlReviewSchema.shape.catalogue.omit({ manifest_text: true }).extend({
      baseline: z.string().min(1).max(200),
      defaultEffectiveFrom: z.iso.date(),
      perControlEffectiveDates: z.literal('not_present_in_source'),
      effectiveStatus: z.literal('requires_assessment_date_and_legal_review'),
    }),
    pages: publicControlPayloadV2Schema.shape.pages,
    pageSources: z.array(pageSource).min(1).max(5),
    candidatesTruncated: z.boolean(),
    publicCandidates: z.array(publicEvidenceCandidateV2Schema).max(128),
    applicability: z
      .object({
        sdfSelfAttested: z.boolean().nullable(),
        processesChildren: z.boolean().nullable(),
        processesHealth: z.boolean().nullable(),
        rationale: z.string().min(1).max(8000),
      })
      .strict(),
    controls: z
      .array(
        z
          .object({
            controlId: z.string().min(1).max(200),
            title: z.string().min(1).max(2000),
            questions: z
              .array(
                z
                  .object({
                    questionId: z.string().min(1).max(200),
                    prompt: z.string().min(1).max(10000),
                    type: z.enum(['boolean', 'scale', 'text', 'multi', 'evidence']),
                    judgment: z.enum(['explicit', 'omitted']),
                    answer: z.boolean().nullable(),
                    rationale: z.string().max(8000).nullable(),
                    candidates: z.array(publicEvidenceCandidateV2Schema).max(128),
                    availableCandidateOrdinals: z.array(z.number().int().min(1).max(128)).max(128),
                  })
                  .strict(),
              )
              .max(1000),
            evidenceRequirements: z
              .array(
                z
                  .object({
                    index: z.number().int().nonnegative(),
                    requirement: evidenceRequirement,
                    state: z.literal('internal_verification_required'),
                    availableCandidateOrdinals: z.array(z.number().int().min(1).max(128)).max(128),
                  })
                  .strict(),
              )
              .max(1000),
          })
          .strict(),
      )
      .length(46),
    declarationsVerified: z.literal(false),
    evidenceVerified: z.literal(false),
    requiresHumanReview: z.literal(true),
  })
  .strict();
export type PublicControlReportAppendix = z.infer<typeof PublicControlReportAppendixSchema>;
const escape = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
export function renderPublicControlReportAppendix(
  raw: PublicControlReportAppendix,
  asset?: PublicWebsiteAssetScope,
) {
  const value = PublicControlReportAppendixSchema.parse(raw);
  const scope = asset === undefined ? null : PublicWebsiteAssetScopeSchema.parse(asset);
  if (
    scope &&
    (scope.estate.id !== value.estateId ||
      scope.association.payload_sha256 !== value.capturePayloadSha256 ||
      !isDeepStrictEqual(scope.association.capture_receipt, {
        id: value.captureReceipt.id,
        entryHash: value.captureReceipt.entry_hash,
      }))
  )
    throw new Error('public_review_asset_scope_refused');
  const controls = value.controls
    .map(
      (c) =>
        `<section><h3>${escape(c.controlId)} · ${escape(c.title)}</h3>${c.questions.map((q) => `<p><strong>${escape(q.questionId)}: ${escape(q.prompt)}</strong> — ${q.type !== 'boolean' ? 'Unsupported by Boolean questionnaire; internal verification required' : q.judgment === 'omitted' ? 'Omitted judgment — Unknown' : q.answer === null ? 'Explicit Unknown' : q.answer ? 'Human declaration: Yes (unverified)' : 'Human declaration: No (unverified)'}. ${q.rationale ? escape(q.rationale) : 'No human rationale recorded.'} Available mapped public candidates (partial only): ${q.availableCandidateOrdinals.join(', ') || 'none captured'}.</p>${q.candidates.map((a) => `<blockquote>Candidate ${a.ordinal}: ${escape(a.facet)}; ${escape(a.kind)}; context ${escape(a.context)}; page ${escape(a.locator.page)}; body SHA-256 ${a.locator.contentSha256}. ${escape(a.excerpt)}</blockquote>`).join('')}`).join('')}<p>Internal evidence requirements remain unverified: ${c.evidenceRequirements.map((r) => escape(r.requirement.description) + ' (available partial public candidates: ' + (r.availableCandidateOrdinals.join(', ') || 'none captured') + ')').join('; ')}.</p></section>`,
    )
    .join('');
  return `<section aria-label="Recorded public-source human review"><h2>Recorded public-source human review</h2><p>Human declarations and public signals remain unverified. This appendix establishes neither implementation, statutory breach, verified evidence, independent audit nor compliance certification. Public excerpts may describe demonstrations, quotations or ambiguous content. Scores and exposure are provisional. Internal evidence and legal review are required.</p>${scope ? renderPublicWebsiteAssetScope(scope) : '<p>Estate context comes from the reviewed engagement. This website capture has no retained system or registered connector association and does not verify asset ownership.</p>'}<p>Review ${escape(value.reviewId)} · actor ${escape(value.reviewActorId)} · ${escape(value.reviewedAt)} · capture ${escape(value.captureCheckedAt)} · payload SHA-256 ${value.capturePayloadSha256}.</p><p>Catalogue ${escape(value.catalogue.library_version)} · baseline ${escape(value.catalogue.baseline)} · default commencement ${escape(value.catalogue.defaultEffectiveFrom)} · capture assessment date ${escape(value.captureAssessmentDate)}. Per-control effective dates are not present in this catalogue; current statutory applicability requires assessment-date and legal review. This is not a declaration of an enforceable breach.</p><p>Applicability: ${escape(JSON.stringify(value.applicability))}. Unavailable or unexamined pages do not establish absence. Candidates truncated: ${value.candidatesTruncated}.</p>${value.pages.map((p) => `<p>${escape(p.page)}: ${escape(p.state)}; partial ${p.truncated}; reasons ${escape(p.coverageReasons.join(', ') || 'none recorded')}.</p>`).join('')}<h3>All retained public candidates (including uncited signals)</h3>${value.publicCandidates.map((a) => `<blockquote>Candidate ${a.ordinal}: ${escape(a.facet)}; ${escape(a.kind)}; context ${escape(a.context)}; page ${escape(a.locator.page)}; body SHA-256 ${a.locator.contentSha256}. ${escape(a.excerpt)}</blockquote>`).join('')}${controls}</section>`;
}

export function renderPublicWebsiteAssetScope(raw: PublicWebsiteAssetScope) {
  const v = PublicWebsiteAssetScopeSchema.parse(raw);
  return `<section aria-label="Human-declared asset scope"><h2>Human-declared asset scope</h2><p>${escape(v.qualification)}</p><p>Estate: ${escape(v.estate.name)} (${escape(v.estate.id)}), recorded version ${v.estate.version}. System: ${escape(v.system.name)} (${escape(v.system.id)}), recorded version ${v.system.version}.</p><p>Declared public URL: ${escape(v.target.url)}. Target ${escape(v.target.id)}; association ${escape(v.association.id)}. Ownership verified: false. Connector access granted: false. Human review required: true.</p></section>`;
}
