import { z } from 'zod';

export const PUBLIC_CONTROL_V2_IDS = [
  'DPDPA-GOV-001',
  'DPDPA-GOV-002',
  'DPDPA-GOV-003',
  'DPDPA-CNS-001',
  'DPDPA-CNS-002',
  'DPDPA-CNS-003',
  'DPDPA-CNS-004',
  'DPDPA-CNS-005',
  'DPDPA-DAT-001',
  'DPDPA-DAT-002',
  'DPDPA-DAT-003',
  'DPDPA-DAT-004',
  'DPDPA-RCD-001',
  'DPDPA-RCD-002',
  'DPDPA-BRCH-001',
  'DPDPA-BRCH-002',
  'DPDPA-XBR-001',
  'DPDPA-XBR-002',
  'DPDPA-CHD-001',
  'DPDPA-CHD-002',
  'DPDPA-SDF-001',
  'DPDPA-SDF-002',
  'DPDPA-SDF-003',
  'DPDPA-SEC-001',
  'DPDPA-SEC-002',
  'DPDPA-SEC-003',
  'DPDPA-SEC-004',
  'DPDPA-SEC-005',
  'DPDPA-RTN-001',
  'DPDPA-RTN-002',
  'DPDPA-RTN-003',
  'DPDPA-DPF-001',
  'DPDPA-DPF-002',
  'DPDPA-AUD-001',
  'DPDPA-AUD-002',
  'DPDPA-DPIA-001',
  'DPDPA-DPIA-002',
  'DPDPA-GOV-004',
  'DPDPA-GOV-005',
  'DPDPA-BRCH-003',
  'DPDPA-RCD-003',
  'DPDPA-XBR-003',
  'DPDPA-SEC-006',
  'DPDPA-SEC-007',
  'DPDPA-DAT-005',
  'DPDPA-DAT-006',
] as const;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.uuid().transform((value) => value.toLowerCase());
export const publicEvidenceFacetV2Schema = z.enum([
  'entity',
  'privacy_notice',
  'processor_disclosure',
  'consent_ui',
  'notice_at_collection',
  'withdrawal',
  'data_items_purposes',
  'access_right',
  'correction_erasure',
  'grievance_contact',
  'nomination',
  'identity_verification',
  'portability',
  'breach_statement',
  'transfer_statement',
  'children_statement',
  'parental_consent_ui',
  'dpo_contact',
  'dpia_statement',
  'audit_statement',
  'security_statement',
  'retention_statement',
  'privacy_contact',
  'accountability_statement',
]);
const pageKind = z.enum(['root', 'privacy', 'contact', 'terms']);
export const publicCoverageReasonV2Schema = z.enum([
  'unsupported_foreign_markup',
  'node_budget',
  'text_node_budget',
  'text_length_budget',
  'excerpt_limit',
  'unsafe_text_suppressed',
  'sensitive_control_suppressed',
  'candidate_limit',
]);
const page = z
  .object({
    page: pageKind,
    state: z.enum(['examined', 'unavailable', 'unexamined']),
    contentSha256: digest.optional(),
    truncated: z.boolean(),
    coverageReasons: z
      .array(publicCoverageReasonV2Schema)
      .max(8)
      .refine((reasons) => new Set(reasons).size === reasons.length),
  })
  .strict()
  .refine(
    (value) =>
      value.truncated === value.coverageReasons.length > 0 &&
      (value.state === 'examined'
        ? value.contentSha256 !== undefined
        : value.contentSha256 === undefined && !value.truncated),
  );

/** Trusted extractor output only: text is public, redacted and excludes input values,
 * scripts, hidden markup and secrets. Quoted content remains explicitly qualified;
 * schema validation does not prove redaction. */
export const publicEvidenceCandidateV2Schema = z
  .object({
    ordinal: z.number().int().min(1).max(128),
    facet: publicEvidenceFacetV2Schema,
    kind: z.enum(['static_observation', 'public_declaration']),
    context: z.enum(['ordinary_public_content', 'demo', 'quoted', 'ambiguous']),
    locator: z
      .object({
        page: pageKind,
        contentSha256: digest,
        elementOrdinal: z.number().int().min(1).max(524288),
      })
      .strict(),
    staticControl: z
      .object({
        element: z.enum(['input', 'select', 'textarea', 'button']),
        inputType: z.enum(['text', 'email', 'tel', 'checkbox', 'radio', 'other']).optional(),
        likelyDataCategory: z.enum([
          'name',
          'email',
          'telephone',
          'address',
          'identifier',
          'free_text',
          'other',
          'unknown',
        ]),
        checkedAttribute: z.boolean(),
        requiredAttribute: z.boolean(),
        disabledAttribute: z.boolean(),
      })
      .strict()
      .optional(),
    excerpt: z
      .string()
      .min(1)
      .max(512)
      .refine(
        (value) =>
          !/[\uD800-\uDFFF]/u.test(value) &&
          new TextEncoder().encode(value).byteLength <= 2048 &&
          !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value) &&
          !/-----BEGIN|\bBearer\s|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu.test(value),
      ),
    textDisposition: z.literal('redacted_public_text'),
    requiresHumanReview: z.literal(true),
  })
  .strict();

export const publicControlPayloadV2Schema = z
  .object({
    version: z.literal(2),
    extractorVersion: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,63}$/),
    pages: z.array(page).min(1).max(4),
    candidates: z.array(publicEvidenceCandidateV2Schema).max(128),
    candidatesTruncated: z.boolean(),
    scope: z.literal('bounded_public_pages'),
    requiresHumanReview: z.literal(true),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.pages[0]?.page !== 'root' ||
      value.pages[0].state !== 'examined' ||
      new Set(value.pages.map((p) => p.page)).size !== value.pages.length ||
      new Set(value.candidates.map((c) => c.ordinal)).size !== value.candidates.length
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid public source coverage' });
    for (const candidate of value.candidates) {
      if (
        !value.pages.some(
          (p) =>
            p.page === candidate.locator.page &&
            p.state === 'examined' &&
            p.contentSha256 === candidate.locator.contentSha256,
        )
      )
        ctx.addIssue({ code: 'custom', message: 'Candidate is not bound to examined source' });
    }
  });
export const publicControlBindingV2Schema = z
  .object({
    tenantId: id,
    engagementId: id,
    checkId: id,
    assessmentDate: z.iso.date(),
  })
  .strict();
export const publicControlSourceV2Schema = publicControlPayloadV2Schema.safeExtend({
  ...publicControlBindingV2Schema.shape,
  projectionSha256: digest,
});
export type PublicControlPayloadV2 = z.infer<typeof publicControlPayloadV2Schema>;
export type PublicControlBindingV2 = z.infer<typeof publicControlBindingV2Schema>;
export type PublicControlSourceV2 = z.infer<typeof publicControlSourceV2Schema>;
export type PublicEvidenceFacetV2 = z.infer<typeof publicEvidenceFacetV2Schema>;

const evidenceState = z.enum([
  'public_candidate',
  'declared_only',
  'mixed_public_evidence',
  'internal_unknown',
  'source_unavailable',
  'source_truncated',
  'not_observed_in_scope',
]);
const assessmentFacet = z
  .object({
    state: evidenceState,
    candidateOrdinals: z.array(z.number().int().min(1).max(128)).max(128),
    requiresHumanReview: z.literal(true),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.candidateOrdinals).size === value.candidateOrdinals.length &&
      (['public_candidate', 'declared_only', 'mixed_public_evidence'].includes(value.state)
        ? value.candidateOrdinals.length > 0
        : value.candidateOrdinals.length === 0),
  );

/** Assessment rows are evidence disposition only, never a compliance score,
 * statutory-breach conclusion, or verification of internal processing. */
export const publicControlAssessmentV2Schema = z
  .object({
    version: z.literal(2),
    source: publicControlSourceV2Schema,
    catalogue: z
      .object({
        libraryVersion: z.literal('0.1.1'),
        baseline: z.literal('IN-DPDP@2026-09-20'),
        manifestSha256: digest,
        mappingVersion: z.literal('public-evidence-1'),
        defaultEffectiveFrom: z.literal('2027-05-13'),
        perControlEffectiveDates: z.literal('not_present_in_source'),
        effectiveStatus: z.literal('requires_assessment_date_and_legal_review'),
      })
      .strict(),
    controls: z
      .array(
        z
          .object({
            controlId: z.enum(PUBLIC_CONTROL_V2_IDS),
            applicability: z.enum(['general', 'conditional_unknown']),
            questions: z
              .array(
                z
                  .object({
                    questionId: z.string().regex(/^Q[1-9][0-9]*$/),
                    evidence: assessmentFacet,
                  })
                  .strict(),
              )
              .min(1)
              .max(20),
            evidenceRequirements: z
              .array(
                z
                  .object({
                    index: z.number().int().min(0).max(30),
                    evidence: assessmentFacet,
                    internalVerificationRequired: z.literal(true),
                  })
                  .strict(),
              )
              .min(1)
              .max(30),
            requiresHumanReview: z.literal(true),
          })
          .strict(),
      )
      .length(46),
    requiresHumanReview: z.literal(true),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.controls.map((c) => c.controlId)).size !== 46)
      ctx.addIssue({ code: 'custom', message: 'Duplicate catalogue control' });
    const candidates = new Map(
      value.source.candidates.map((candidate) => [candidate.ordinal, candidate]),
    );
    for (const control of value.controls) {
      const conditional = /^DPDPA-(CHD|SDF)-/.test(control.controlId);
      if (control.applicability !== (conditional ? 'conditional_unknown' : 'general'))
        ctx.addIssue({
          code: 'custom',
          message: 'Conditional applicability is not verified in this foundation',
        });
      if (
        new Set(control.questions.map((q) => q.questionId)).size !== control.questions.length ||
        control.evidenceRequirements.some((e, i) => e.index !== i)
      )
        ctx.addIssue({ code: 'custom', message: 'Invalid question or requirement identities' });
      for (const facet of [
        ...control.questions.map((q) => q.evidence),
        ...control.evidenceRequirements.map((e) => e.evidence),
      ]) {
        if (
          facet.candidateOrdinals.some((ordinal) => !candidates.has(ordinal)) ||
          (facet.state === 'public_candidate' &&
            facet.candidateOrdinals.some(
              (ordinal) => candidates.get(ordinal)?.kind !== 'static_observation',
            )) ||
          (facet.state === 'mixed_public_evidence' &&
            (!facet.candidateOrdinals.some(
              (ordinal) => candidates.get(ordinal)?.kind === 'static_observation',
            ) ||
              !facet.candidateOrdinals.some(
                (ordinal) => candidates.get(ordinal)?.kind === 'public_declaration',
              ))) ||
          (facet.state === 'declared_only' &&
            facet.candidateOrdinals.some(
              (ordinal) => candidates.get(ordinal)?.kind !== 'public_declaration',
            ))
        )
          ctx.addIssue({ code: 'custom', message: 'Evidence does not match retained candidates' });
      }
    }
  });
export type PublicControlAssessmentV2 = z.infer<typeof publicControlAssessmentV2Schema>;
