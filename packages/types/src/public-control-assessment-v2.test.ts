import { expect, it } from 'vitest';
import {
  PUBLIC_CONTROL_V2_IDS,
  publicControlSourceV2Schema,
  publicControlAssessmentV2Schema,
} from './public-control-assessment-v2';
const hash = 'a'.repeat(64);
function source() {
  return {
    version: 2,
    tenantId: '11111111-1111-4111-8111-111111111111',
    engagementId: '22222222-2222-4222-8222-222222222222',
    checkId: '33333333-3333-4333-8333-333333333333',
    projectionSha256: hash,
    assessmentDate: '2026-10-15',
    extractorVersion: 'static-public-2',
    pages: [
      {
        page: 'root',
        state: 'examined',
        contentSha256: hash,
        coverageReasons: [] as string[],
        truncated: false,
      },
    ],
    candidates: [
      {
        ordinal: 1,
        facet: 'consent_ui',
        kind: 'static_observation',
        context: 'demo',
        locator: { page: 'root', contentSha256: hash, elementOrdinal: 1 },
        excerpt: 'Accept optional analytics',
        textDisposition: 'redacted_public_text',
        requiresHumanReview: true,
      },
    ],
    candidatesTruncated: false,
    scope: 'bounded_public_pages',
    requiresHumanReview: true,
  };
}
const evidence = () => ({
  state: 'internal_unknown',
  candidateOrdinals: [],
  requiresHumanReview: true,
});
function assessment() {
  return {
    version: 2,
    source: source(),
    catalogue: {
      libraryVersion: '0.1.1',
      baseline: 'IN-DPDP@2026-09-20',
      manifestSha256: hash,
      mappingVersion: 'public-evidence-1',
      defaultEffectiveFrom: '2027-05-13',
      perControlEffectiveDates: 'not_present_in_source',
      effectiveStatus: 'requires_assessment_date_and_legal_review',
    },
    controls: PUBLIC_CONTROL_V2_IDS.map((controlId) => ({
      controlId,
      applicability: /^DPDPA-(CHD|SDF)-/.test(controlId) ? 'conditional_unknown' : 'general',
      questions: [{ questionId: 'Q1', evidence: evidence() }],
      evidenceRequirements: [
        { index: 0, evidence: evidence(), internalVerificationRequired: true },
      ],
      requiresHumanReview: true,
    })),
    requiresHumanReview: true,
  };
}
it('accepts bounded source-bound demo evidence without asserting operational consent', () => {
  expect(publicControlSourceV2Schema.parse(source()).candidates[0]!.context).toBe('demo');
  expect(publicControlAssessmentV2Schema.safeParse(assessment()).success).toBe(true);
});
it.each([
  'page_hash',
  'missing_page',
  'unavailable',
  'duplicate_ordinal',
  'duplicate_page',
  'raw_value',
  'raw_url',
  'secret',
  'email',
  'text_limit',
  'review_false',
  'unknown_key',
  'bad_date',
  'v1',
])('rejects adversarial source %s', (mode) => {
  const value = source();
  switch (mode) {
    case 'page_hash':
      value.candidates[0]!.locator.contentSha256 = 'b'.repeat(64);
      break;
    case 'missing_page':
      value.pages = [];
      break;
    case 'unavailable':
      value.pages[0]!.state = 'unavailable';
      break;
    case 'duplicate_ordinal':
      value.candidates.push(value.candidates[0]!);
      break;
    case 'duplicate_page':
      value.pages.push(value.pages[0]!);
      break;
    case 'raw_value':
      Object.assign(value.candidates[0]!, { value: 'private' });
      break;
    case 'raw_url':
      Object.assign(value.candidates[0]!.locator, { url: 'https://site/?secret=raw' });
      break;
    case 'secret':
      value.candidates[0]!.excerpt = 'Bearer private-token';
      break;
    case 'email':
      value.candidates[0]!.excerpt = 'Contact alice@example.com';
      break;
    case 'text_limit':
      value.candidates[0]!.excerpt = 'x'.repeat(513);
      break;
    case 'review_false':
      value.requiresHumanReview = false;
      break;
    case 'unknown_key':
      Object.assign(value, { compliant: true });
      break;
    case 'bad_date':
      value.assessmentDate = '2026-02-30';
      break;
    case 'v1':
      value.version = 1;
      break;
  }
  expect(publicControlSourceV2Schema.safeParse(value).success).toBe(false);
});
it.each([
  'pass',
  'unknown_candidate',
  'duplicate_control',
  'fake_control',
  'conditional_pass',
  'question_duplicate',
  'requirement_index',
  'declared_mismatch',
  'missing_control',
  'internal_verified',
])('rejects unsupported assessment %s', (mode) => {
  const value = assessment();
  const c = value.controls[0]!;
  switch (mode) {
    case 'pass':
      c.questions[0]!.evidence.state = 'pass';
      break;
    case 'unknown_candidate':
      Object.assign(c.questions[0]!.evidence, {
        state: 'public_candidate',
        candidateOrdinals: [2],
      });
      break;
    case 'duplicate_control':
      value.controls[1] = value.controls[0]!;
      break;
    case 'fake_control':
      c.controlId = 'DPDPA-FAKE-001' as typeof c.controlId;
      break;
    case 'conditional_pass':
      value.controls.find((c) => c.controlId === 'DPDPA-CHD-001')!.applicability = 'general';
      break;
    case 'question_duplicate':
      c.questions.push(c.questions[0]!);
      break;
    case 'requirement_index':
      c.evidenceRequirements[0]!.index = 2;
      break;
    case 'declared_mismatch':
      Object.assign(c.questions[0]!.evidence, { state: 'declared_only', candidateOrdinals: [1] });
      break;
    case 'missing_control':
      value.controls.pop();
      break;
    case 'internal_verified':
      c.evidenceRequirements[0]!.internalVerificationRequired = false;
      break;
  }
  expect(publicControlAssessmentV2Schema.safeParse(value).success).toBe(false);
});
it('keeps unavailable, unexamined and truncated source states distinct', () => {
  const value = source();
  value.pages.push({
    page: 'privacy',
    state: 'unavailable',
    coverageReasons: [] as string[],
    truncated: false,
  } as (typeof value.pages)[number]);
  value.pages.push({
    page: 'terms',
    state: 'unexamined',
    coverageReasons: [] as string[],
    truncated: false,
  } as (typeof value.pages)[number]);
  value.pages[0]!.truncated = true;
  value.pages[0]!.coverageReasons = ['excerpt_limit'];
  value.candidatesTruncated = true;
  expect(publicControlSourceV2Schema.parse(value).pages.map((p) => p.state)).toEqual([
    'examined',
    'unavailable',
    'unexamined',
  ]);
});
it('requires candidate references for partial evidence and permits explicitly qualified declarations', () => {
  const value = assessment();
  Object.assign(value.controls[0]!.questions[0]!.evidence, {
    state: 'public_candidate',
    candidateOrdinals: [1],
  });
  expect(publicControlAssessmentV2Schema.safeParse(value).success).toBe(true);
  Object.assign(value.controls[0]!.questions[0]!.evidence, { state: 'declared_only' });
  value.source.candidates[0]!.kind = 'public_declaration';
  expect(publicControlAssessmentV2Schema.safeParse(value).success).toBe(true);
  Object.assign(value.controls[0]!.questions[0]!.evidence, { candidateOrdinals: [] });
  expect(publicControlAssessmentV2Schema.safeParse(value).success).toBe(false);
});

it.each(['declaration', 'mixed'])(
  'refuses to promote %s evidence to static public observation',
  (kind) => {
    const value = assessment();
    value.source.candidates[0]!.kind = 'public_declaration';
    if (kind === 'mixed') {
      value.source.candidates.push({
        ...value.source.candidates[0]!,
        ordinal: 2,
        kind: 'static_observation',
      });
    }
    Object.assign(value.controls[0]!.questions[0]!.evidence, {
      state: 'public_candidate',
      candidateOrdinals: kind === 'mixed' ? [1, 2] : [1],
    });
    expect(publicControlAssessmentV2Schema.safeParse(value).success).toBe(false);
  },
);

it.each(['both', 'static_only', 'declaration_only', 'unknown_reference'])(
  'qualifies mixed evidence only when both retained kinds exist: %s',
  (kinds) => {
    const value = assessment();
    value.source.candidates.push({
      ...value.source.candidates[0]!,
      ordinal: 2,
      kind: 'public_declaration',
      context: 'ambiguous',
    });
    Object.assign(value.controls[0]!.questions[0]!.evidence, {
      state: 'mixed_public_evidence',
      candidateOrdinals:
        kinds === 'both'
          ? [1, 2]
          : kinds === 'static_only'
            ? [1]
            : kinds === 'declaration_only'
              ? [2]
              : [1, 2, 3],
    });
    const result = publicControlAssessmentV2Schema.safeParse(value);
    expect(result.success).toBe(kinds === 'both');
    if (result.success) {
      expect(result.data.source.candidates.map((candidate) => candidate.context)).toEqual([
        'demo',
        'ambiguous',
      ]);
      expect(result.data.requiresHumanReview).toBe(true);
    }
  },
);

it('requires explicit unique bounded coverage reasons exactly when examined content is partial', () => {
  const value = source();
  Object.assign(value.pages[0]!, { truncated: true, coverageReasons: ['excerpt_limit'] });
  expect(publicControlSourceV2Schema.safeParse(value).success).toBe(true);
  for (const delta of [
    { truncated: true, coverageReasons: [] },
    { truncated: false, coverageReasons: ['excerpt_limit'] },
    { truncated: true, coverageReasons: ['excerpt_limit', 'excerpt_limit'] },
    { truncated: true, coverageReasons: ['unbounded_attacker_reason'] },
  ])
    expect(
      publicControlSourceV2Schema.safeParse({ ...value, pages: [{ ...value.pages[0], ...delta }] })
        .success,
    ).toBe(false);
  for (const state of ['unavailable', 'unexamined'])
    expect(
      publicControlSourceV2Schema.safeParse({
        ...value,
        pages: [
          value.pages[0],
          { page: 'contact', state, truncated: true, coverageReasons: ['excerpt_limit'] },
        ],
      }).success,
    ).toBe(false);
});

it.each(['\ud800', '\udc00', 'text\ud800tail'])(
  'rejects lone surrogate evidence text',
  (invalid) => {
    const input = source();
    input.candidates[0]!.excerpt = invalid;
    expect(publicControlSourceV2Schema.safeParse(input).success).toBe(false);
  },
);
it('retains multilingual text and valid emoji without Unicode normalization', () => {
  const input = source();
  input.candidates[0]!.excerpt = 'गोपनीयता नीति — সম্মতি 😀 e\u0301';
  expect(publicControlSourceV2Schema.parse(input).candidates[0]!.excerpt).toBe(
    input.candidates[0]!.excerpt,
  );
});

it('binds each public-evidence baseline to its supported catalogue version', () => {
  const candidate = assessment();
  candidate.catalogue.libraryVersion = '0.2.0';
  expect(publicControlAssessmentV2Schema.safeParse(candidate).success).toBe(false);
  candidate.catalogue.baseline = 'IN-DPDP@2026-10-17';
  expect(publicControlAssessmentV2Schema.safeParse(candidate).success).toBe(true);
  candidate.catalogue.libraryVersion = '0.1.1';
  expect(publicControlAssessmentV2Schema.safeParse(candidate).success).toBe(false);
});
