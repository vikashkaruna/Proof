import { resolveControlLibrary } from './library-versions';

/** Schema-neutral catalogue foundation. The caller must validate its source using
 * the v2 public source codec, verify the published catalogue against this exact
 * manifest, and retain both hashes before evaluating any public evidence. */
const facets = {
  'GOV-001': ['entity'],
  'GOV-002': ['privacy_notice'],
  'GOV-003': ['processor_disclosure'],
  'GOV-004': ['accountability_statement'],
  'GOV-005': [],
  'CNS-001': ['consent_ui', 'notice_at_collection', 'withdrawal'],
  'CNS-002': ['notice_at_collection', 'data_items_purposes'],
  'CNS-003': ['retention_statement'],
  'CNS-004': ['withdrawal', 'correction_erasure'],
  'CNS-005': ['data_items_purposes'],
  'DAT-001': ['access_right'],
  'DAT-002': ['correction_erasure'],
  'DAT-003': ['grievance_contact'],
  'DAT-004': ['nomination'],
  'DAT-005': ['identity_verification'],
  'DAT-006': ['portability'],
  'RCD-001': ['data_items_purposes'],
  'RCD-002': ['data_items_purposes'],
  'RCD-003': ['processor_disclosure'],
  'BRCH-001': ['breach_statement'],
  'BRCH-002': ['breach_statement'],
  'BRCH-003': ['breach_statement'],
  'XBR-001': ['transfer_statement'],
  'XBR-002': ['transfer_statement'],
  'XBR-003': ['transfer_statement'],
  'CHD-001': ['children_statement', 'parental_consent_ui'],
  'CHD-002': ['children_statement'],
  'SDF-001': ['dpo_contact'],
  'SDF-002': ['dpia_statement'],
  'SDF-003': ['audit_statement'],
  'SEC-001': ['security_statement'],
  'SEC-002': [],
  'SEC-003': [],
  'SEC-004': ['security_statement'],
  'SEC-005': ['security_statement'],
  'SEC-006': ['security_statement'],
  'SEC-007': ['security_statement'],
  'RTN-001': ['retention_statement'],
  'RTN-002': ['correction_erasure'],
  'RTN-003': ['retention_statement'],
  'DPF-001': ['privacy_contact'],
  'DPF-002': ['accountability_statement'],
  'AUD-001': [],
  'AUD-002': ['audit_statement'],
  'DPIA-001': ['dpia_statement'],
  'DPIA-002': [],
} as const;

/** Explicit question facets avoid turning public contact details into proof of
 * actual appointment, retention, completed execution, or response performance. */
const questionFacets: Readonly<Record<string, readonly string[]>> = {
  'GOV-001/Q1': ['entity'],
  'GOV-002/Q1': ['privacy_notice'],
  'GOV-002/Q2': ['privacy_notice'],
  'GOV-003/Q1': ['processor_disclosure'],
  'CNS-001/Q1': ['consent_ui'],
  'CNS-001/Q2': ['notice_at_collection'],
  'CNS-001/Q3': ['withdrawal'],
  'CNS-002/Q1': ['data_items_purposes', 'notice_at_collection'],
  'CNS-002/Q2': ['access_right', 'grievance_contact'],
  'CNS-004/Q1': ['withdrawal'],
  'CNS-005/Q1': ['data_items_purposes'],
  'DAT-001/Q1': ['access_right'],
  'DAT-002/Q1': ['correction_erasure'],
  'DAT-002/Q2': ['correction_erasure'],
  'DAT-003/Q1': ['grievance_contact'],
  'DAT-004/Q1': ['nomination'],
  'XBR-001/Q1': ['transfer_statement'],
  'CHD-001/Q1': ['children_statement'],
  'CHD-001/Q2': ['parental_consent_ui'],
  'CHD-002/Q1': ['children_statement'],
  'SDF-001/Q2': ['dpo_contact'],
  'RTN-001/Q1': ['retention_statement'],
  'DPF-001/Q1': ['privacy_contact'],
  'DPF-002/Q1': ['accountability_statement'],
};

// Individually reviewed partial public facets. No static HTML screenshot proof,
// signed processor contracts, private logs or operational configurations inferred.
const requirementFacets: Readonly<Record<string, readonly string[]>> = {
  'GOV-002/0': ['privacy_notice'],
  'CNS-002/0': ['notice_at_collection', 'data_items_purposes'],
  'CNS-005/0': ['data_items_purposes'],
  'DAT-003/0': ['grievance_contact'],
  'DAT-004/1': ['nomination'],
  'CHD-001/1': ['children_statement'],
  'SDF-001/1': ['dpo_contact'],
  'RTN-001/0': ['retention_statement'],
};

export function createPublicControlCatalogueManifest(libraryVersion = '0.1.1') {
  const library = resolveControlLibrary(libraryVersion);
  const controls = library.controls;
  const controlIds = controls.map((c) => c.id.replace('DPDPA-', ''));
  if (
    controlIds.length !== 46 ||
    new Set(controlIds).size !== 46 ||
    controlIds.some((id) => !Object.hasOwn(facets, id)) ||
    Object.keys(facets).length !== 46
  )
    throw new Error('public_catalogue_mapping_mismatch');
  const knownQuestions = new Set(
    controls.flatMap((c) =>
      c.assessmentQuestions.map((q) => `${c.id.replace('DPDPA-', '')}/${q.id}`),
    ),
  );
  if (Object.keys(questionFacets).some((key) => !knownQuestions.has(key)))
    throw new Error('public_catalogue_question_mismatch');
  const knownRequirements = new Set(
    controls.flatMap((c) =>
      c.evidenceRequired.map((_, index) => `${c.id.replace('DPDPA-', '')}/${index}`),
    ),
  );
  if (Object.keys(requirementFacets).some((key) => !knownRequirements.has(key)))
    throw new Error('public_catalogue_requirement_mismatch');
  return {
    schemaVersion: 2,
    mappingVersion: 'public-evidence-1',
    provenance: {
      libraryVersion: library.version,
      publishedAt: library.publishedAt,
      publisher: library.publishedBy,
      baseline: library.baseline,
      defaultEffectiveFrom: library.defaultEffectiveFrom,
      perControlEffectiveDates: 'not_present_in_source',
      effectiveStatus: 'requires_assessment_date_and_legal_review',
      publicationVerification: 'requires_exact_published_catalogue_comparison',
    },
    controls: controls.map((c) => ({
      control: c,
      applicability: c.sdfOnly
        ? 'sdf_status_requires_verification'
        : c.childrenOnly
          ? 'children_processing_requires_verification'
          : 'general',
      publicCandidateFacets: facets[c.id.replace('DPDPA-', '') as keyof typeof facets],
      questions: c.assessmentQuestions.map((q) => ({
        questionId: q.id,
        publicCandidateFacets: questionFacets[`${c.id.replace('DPDPA-', '')}/${q.id}`] ?? [],
        internalVerificationRequired: true,
      })),
      evidenceRequirements: c.evidenceRequired.map((requirement, index) => ({
        index,
        requirement,
        publicCandidateFacets: requirementFacets[`${c.id.replace('DPDPA-', '')}/${index}`] ?? [],
        publicEvidenceSufficiency: 'never_automatically_sufficient',
        internalVerificationRequired: true,
      })),
      requiresHumanReview: true,
    })),
  };
}

/** Codec: JSON.stringify of the construction above, UTF-8, no whitespace or newline.
 * This freezes full control rows, their order, questions and evidence requirements.
 * Consumers must not reserialize PostgreSQL JSONB and call that the same hash. */
export const PUBLIC_CONTROL_CATALOGUE_V2_MANIFEST_TEXT = JSON.stringify(
  createPublicControlCatalogueManifest(),
);

export async function publicControlCatalogueV2ManifestSha256(): Promise<string> {
  const bytes = new TextEncoder().encode(PUBLIC_CONTROL_CATALOGUE_V2_MANIFEST_TEXT);
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

/** Fresh defensive copy: callers cannot mutate the frozen manifest text or
 * subsequently generated requirements. This is not a database publication proof. */
export function publicControlCatalogueV2Manifest(
  libraryVersion = '0.1.1',
): ReturnType<typeof createPublicControlCatalogueManifest> {
  return JSON.parse(publicControlCatalogueManifestText(libraryVersion)) as ReturnType<
    typeof createPublicControlCatalogueManifest
  >;
}

/** Run after the strict v2 codec. Checks exact retained catalogue identities and
 * completeness; it does not verify publication custody, source or authority. */
export function publicEvidenceCatalogueRowsMatchV2(
  rows: readonly {
    controlId: string;
    applicability: string;
    questions: readonly { questionId: string }[];
    evidenceRequirements: readonly { index: number }[];
  }[],
  libraryVersion = '0.1.1',
): boolean {
  const expected = publicControlCatalogueV2Manifest(libraryVersion).controls;
  return (
    rows.length === expected.length &&
    rows.every((row, index) => {
      const control = expected[index]!;
      return (
        row.controlId === control.control.id &&
        row.applicability ===
          (control.applicability === 'general' ? 'general' : 'conditional_unknown') &&
        row.questions.length === control.questions.length &&
        row.questions.every(
          (question, i) => question.questionId === control.questions[i]!.questionId,
        ) &&
        row.evidenceRequirements.length === control.evidenceRequirements.length &&
        row.evidenceRequirements.every((requirement, i) => requirement.index === i)
      );
    })
  );
}

/** Exact versioned bytes; no publication or approval side effect. */
export function publicControlCatalogueManifestText(libraryVersion: string): string {
  return JSON.stringify(createPublicControlCatalogueManifest(libraryVersion));
}
