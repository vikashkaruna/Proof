import { expect, it } from 'vitest';
import { AssessmentRequestSchema } from './assessment-request.js';
const base = {
  operationKey: '11111111-1111-4111-8111-111111111111',
  engagementId: '22222222-2222-4222-8222-222222222222',
};
it('preserves the legacy unknown-only body without adding reviewed metadata', () => {
  expect(JSON.stringify(AssessmentRequestSchema.parse(base))).toBe(
    JSON.stringify({
      ...base,
      answers: {},
      applicability: { sdfSelfAttested: null, processesChildren: null, processesHealth: null },
    }),
  );
});
it('accepts explicit reviewed precondition separately from unchanged declarations', () => {
  const expectedQuestionnaire = { libraryVersion: 'v1', questionnaireDigest: 'a'.repeat(64) };
  expect(
    AssessmentRequestSchema.parse({ ...base, answers: { C: { Q: false } }, expectedQuestionnaire })
      .expectedQuestionnaire,
  ).toEqual(expectedQuestionnaire);
});
it.each([
  { libraryVersion: 'v1', questionnaireDigest: 'bad' },
  { libraryVersion: '', questionnaireDigest: 'a'.repeat(64) },
  { libraryVersion: 'v1', questionnaireDigest: 'a'.repeat(64), confidential: 'extra' },
])('refuses malformed or widened reviewed preconditions', (expectedQuestionnaire) => {
  expect(AssessmentRequestSchema.safeParse({ ...base, expectedQuestionnaire }).success).toBe(false);
});
it('accepts a retained review reference without browser declaration overrides', () => {
  const ref = {
    reviewId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    requestSha256: 'a'.repeat(64),
    snapshotSha256: 'b'.repeat(64),
  };
  const request = {
    operationKey: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    engagementId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    reviewRef: ref,
  };
  expect(AssessmentRequestSchema.parse(request).reviewRef).toEqual(ref);
  expect(
    AssessmentRequestSchema.safeParse({ ...request, answers: { C: { Q: true } } }).success,
  ).toBe(false);
  expect(
    AssessmentRequestSchema.safeParse({ ...request, applicability: { processesHealth: true } })
      .success,
  ).toBe(false);
  expect(
    AssessmentRequestSchema.safeParse({
      ...request,
      expectedQuestionnaire: { libraryVersion: '0.1.1', questionnaireDigest: 'c'.repeat(64) },
    }).success,
  ).toBe(false);
});
