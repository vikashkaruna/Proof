import { expect, it } from 'vitest';
import {
  publicControlReviewSetRequestSchema,
  publicControlReviewSetRequestV2Schema,
  parsePublicControlReviewSetAnyRequestText,
  publicControlReviewSetAnyRowSchema,
  validatePublicControlReviewSet,
} from './public-control-review-set';
const tenantId = '11111111-1111-4111-8111-111111111111',
  engagementId = '22222222-2222-4222-8222-222222222222',
  checkId = '33333333-3333-4333-8333-333333333333';
const digest = 'a'.repeat(64);
const source = {
  version: 2,
  extractorVersion: 'public-static-evidence-1',
  tenantId,
  engagementId,
  checkId,
  assessmentDate: '2026-10-16',
  projectionSha256: digest,
  pages: [
    {
      page: 'root',
      state: 'examined',
      contentSha256: digest,
      truncated: false,
      coverageReasons: [],
    },
  ],
  candidates: [],
  candidatesTruncated: false,
  scope: 'bounded_public_pages',
  requiresHumanReview: true,
};
const questionnaire = {
  tenantId,
  engagementId,
  libraryVersion: '0.1.1',
  questionnaireDigest: digest,
  digestScope: 'ordered_questionnaire_projection_v1',
  controls: [
    {
      id: 'DPDPA-GOV-001',
      title: 'Governance',
      questions: [
        { id: 'q1', prompt: 'Question one', type: 'boolean' },
        { id: 'q2', prompt: 'Question two', type: 'boolean' },
        { id: 'text1', prompt: 'Free text', type: 'text' },
      ],
    },
  ],
  declarationsVerified: false,
};
const trusted = {
  tenantId,
  estateId: null,
  source,
  questionnaire,
  catalogueManifestSha256: digest,
};
const request = {
  version: 1,
  operationKey: '44444444-4444-4444-8444-444444444444',
  engagementId,
  checkId,
  expectedEstateId: null,
  expectedPreviousReviewId: null,
  expectedSource: {
    payloadSha256: digest,
    catalogueManifestSha256: digest,
    mappingVersion: 'public-evidence-1',
    libraryVersion: '0.1.1',
    questionnaireDigest: digest,
  },
  answers: {
    'DPDPA-GOV-001': {
      q1: {
        answer: null,
        rationale: 'Human cannot establish this from public evidence.',
        candidateOrdinals: [],
      },
    },
  },
  applicability: {
    sdfSelfAttested: null,
    processesChildren: null,
    processesHealth: null,
    rationale: 'No internal evidence supplied.',
  },
};
it('retains explicit null rationale separately from missing unreviewed answers while normalizing both unknown', () => {
  const result = validatePublicControlReviewSet(request, trusted);
  expect(result.answers).toEqual({ 'DPDPA-GOV-001': { q1: null, q2: null } });
  expect(result.request.answers['DPDPA-GOV-001']).toHaveProperty('q1.rationale');
  expect(result.request.answers['DPDPA-GOV-001']).not.toHaveProperty('q2');
  expect(result.declarationsVerified).toBe(false);
});
it.each(['payloadSha256', 'questionnaireDigest', 'catalogueManifestSha256'] as const)(
  'refuses incorrect %s',
  (field) => {
    expect(() =>
      validatePublicControlReviewSet(
        { ...request, expectedSource: { ...request.expectedSource, [field]: 'b'.repeat(64) } },
        trusted,
      ),
    ).toThrow();
  },
);
it.each(['unknown', 'text1'])('refuses unsupported question %s', (question) => {
  expect(() =>
    validatePublicControlReviewSet(
      {
        ...request,
        answers: { 'DPDPA-GOV-001': { [question]: request.answers['DPDPA-GOV-001'].q1 } },
      },
      trusted,
    ),
  ).toThrow();
});
it('refuses foreign scope, estate changes and nonexistent candidate ordinals', () => {
  expect(() =>
    validatePublicControlReviewSet(request, { ...trusted, tenantId: checkId }),
  ).toThrow();
  expect(() =>
    validatePublicControlReviewSet(request, { ...trusted, estateId: checkId }),
  ).toThrow();
  expect(() =>
    validatePublicControlReviewSet(
      {
        ...request,
        answers: {
          'DPDPA-GOV-001': {
            q1: { ...request.answers['DPDPA-GOV-001'].q1, candidateOrdinals: [1] },
          },
        },
      },
      trusted,
    ),
  ).toThrow();
});
it('rejects unknown keys, duplicate references, empty rationale and excessive total text', () => {
  expect(
    publicControlReviewSetRequestSchema.safeParse({ ...request, verified: true }).success,
  ).toBe(false);
  for (const entry of [
    { answer: true, rationale: ' ', candidateOrdinals: [] },
    { answer: null, rationale: 'Reason', candidateOrdinals: [1, 1] },
  ])
    expect(
      publicControlReviewSetRequestSchema.safeParse({ ...request, answers: { C: { Q: entry } } })
        .success,
    ).toBe(false);
  const answers = Object.fromEntries(
    Array.from({ length: 46 }, (_, i) => [
      'C' + i,
      Object.fromEntries(
        Array.from({ length: 3 }, (_, q) => [
          'Q' + q,
          { answer: null, rationale: 'x'.repeat(2000), candidateOrdinals: [] },
        ]),
      ),
    ]),
  );
  expect(publicControlReviewSetRequestSchema.safeParse({ ...request, answers }).success).toBe(
    false,
  );
});
it('rejects ambiguous duplicate-key and unknown-key canonical request bytes', async () => {
  const { parsePublicControlReviewSetRequestText } = await import('./public-control-review-set');
  expect(() => parsePublicControlReviewSetRequestText('{"version":1,"version":1}')).toThrow(
    'public_control_review_request_refused',
  );
  expect(() =>
    parsePublicControlReviewSetRequestText(
      JSON.stringify({ ...request, unexpected: 'private input' }),
    ),
  ).toThrow('public_control_review_request_refused');
});
it('accepts the exact canonical request codec and rejects whitespace or alternative decoded-key spelling', async () => {
  const { parsePublicControlReviewSetRequestText } = await import('./public-control-review-set');
  function canonical(v: unknown): string {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
    return (
      '{' +
      Object.keys(v)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonical((v as Record<string, unknown>)[k]))
        .join(',') +
      '}'
    );
  }
  const text = canonical(request);
  expect(parsePublicControlReviewSetRequestText(text)).toEqual(request);
  expect(() => parsePublicControlReviewSetRequestText(' ' + text)).toThrow();
  expect(() =>
    parsePublicControlReviewSetRequestText(
      text.replace('"version":1', '"version":1,"\\u0076ersion":1'),
    ),
  ).toThrow();
});
it('requires full unknown normalization without relabelling omitted judgments as reviewed', async () => {
  const { publicControlReviewSetSnapshotSchema } = await import('./public-control-review-set');
  const normalizedAnswers = Object.fromEntries(
    Array.from({ length: 46 }, (_, i) => [
      i === 0 ? 'DPDPA-GOV-001' : 'C' + i,
      i === 0 ? { q1: null, q2: null } : {},
    ]),
  );
  const snapshot = {
    version: 1,
    tenantId,
    engagementId,
    estateId: null,
    checkId,
    checkedAt: '2026-10-16T00:00:00+00:00',
    captureReceipt: '9223372036854775807',
    request,
    normalizedAnswers,
    declarationsVerified: false,
    requiresHumanReview: true,
  };
  expect(publicControlReviewSetSnapshotSchema.safeParse(snapshot).success).toBe(true);
  expect(
    publicControlReviewSetSnapshotSchema.safeParse({
      ...snapshot,
      normalizedAnswers: { ...normalizedAnswers, 'DPDPA-GOV-001': { q1: null, q2: true } },
    }).success,
  ).toBe(false);
  expect(
    publicControlReviewSetSnapshotSchema.safeParse({ ...snapshot, captureReceipt: 123 }).success,
  ).toBe(false);
});
it('requires a positive immutable cancellation receipt rather than treating notfound as cancellation', async () => {
  const {
    readPublicControlReviewOperationSchema,
    cancelPublicControlReviewOperationRequestSchema,
  } = await import('./public-control-review-set');
  expect(readPublicControlReviewOperationSchema.safeParse({ state: 'not_found' }).success).toBe(
    true,
  );
  expect(readPublicControlReviewOperationSchema.safeParse({ state: 'cancelled' }).success).toBe(
    false,
  );
  expect(
    cancelPublicControlReviewOperationRequestSchema.safeParse({
      request,
      reason: 'Operator explicitly abandons this pending review.',
    }).success,
  ).toBe(true);
  expect(
    cancelPublicControlReviewOperationRequestSchema.safeParse({ request, reason: ' ' }).success,
  ).toBe(false);
});

const associationRef = {
  associationId: '55555555-5555-4555-8555-555555555555',
  associationSha256: digest,
  targetId: '66666666-6666-4666-8666-666666666666',
  targetSha256: digest,
  associationReceipt: { id: '12', entryHash: digest },
};
const linkedRequest = () => ({
  ...request,
  version: 2,
  expectedEstateId: tenantId,
  associationRef,
});
it('keeps the v1 object/parser contract while explicitly admitting exact canonical v2', () => {
  const v2 = linkedRequest();
  expect(publicControlReviewSetRequestSchema.safeParse(v2).success).toBe(false);
  expect(publicControlReviewSetRequestV2Schema.parse(v2)).toEqual(v2);
  const canonical = (v: unknown): string => {
    if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
    if (v && typeof v === 'object')
      return (
        '{' +
        Object.entries(v)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([k, x]) => JSON.stringify(k) + ':' + canonical(x))
          .join(',') +
        '}'
      );
    return JSON.stringify(v);
  };
  const text = canonical(v2);
  expect(parsePublicControlReviewSetAnyRequestText(text)).toEqual(v2);
  expect(() =>
    parsePublicControlReviewSetAnyRequestText(text.replace('{', '{"version":2,')),
  ).toThrow();
  expect(() => parsePublicControlReviewSetAnyRequestText(text + ' ')).toThrow();
});
it.each([
  null,
  undefined,
  { ...associationRef, associationReceipt: undefined },
  { ...associationRef, associationSha256: 'bad' },
  { ...associationRef, invented: true },
])('requires full retained association commitments %#', (ref) => {
  expect(
    publicControlReviewSetRequestV2Schema.safeParse({ ...linkedRequest(), associationRef: ref })
      .success,
  ).toBe(false);
});
it('refuses v2 estate omission and version masquerading', () => {
  expect(
    publicControlReviewSetRequestV2Schema.safeParse({ ...linkedRequest(), expectedEstateId: null })
      .success,
  ).toBe(false);
  expect(
    publicControlReviewSetRequestSchema.safeParse({ ...linkedRequest(), version: 1 }).success,
  ).toBe(false);
  expect(
    publicControlReviewSetAnyRowSchema.safeParse({
      request_codec: 'axiom-public-control-review-request-canonical-json-2',
      snapshot_codec: 'axiom-public-control-review-snapshot-pg-canonical-json-1',
    }).success,
  ).toBe(false);
});
