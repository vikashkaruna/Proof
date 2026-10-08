import { expect, it } from 'vitest';
import { originalQuestionnaireMatches } from './assessment-original-request.js';
import { canonicalAssessmentInput } from '../workloads/assessment-input.js';
import { AssessmentRequestSchema } from '@axiom/types';
const expected = { libraryVersion: '0.1.1', questionnaireDigest: 'd'.repeat(64) };
it('requires exact review metadata presence and digest without upgrading legacy requests', () => {
  expect(originalQuestionnaireMatches(undefined, undefined)).toBe(true);
  expect(originalQuestionnaireMatches(undefined, expected)).toBe(false);
  expect(originalQuestionnaireMatches(expected, undefined)).toBe(false);
  expect(originalQuestionnaireMatches(expected, expected)).toBe(true);
});
it.each([
  null,
  { ...expected, libraryVersion: 'foreign' },
  { ...expected, questionnaireDigest: 'e'.repeat(64) },
  { ...expected, extra: true },
  { ...expected, questionnaireDigest: 'INVALID' },
])('refuses malformed or changed original reviewed metadata', (value) => {
  expect(originalQuestionnaireMatches(expected, value)).toBe(false);
});
it('keeps reviewed source preconditions outside the canonical worker declaration hash', () => {
  const input = AssessmentRequestSchema.parse({
    engagementId: '88880000-0000-4000-8000-000000000001',
    operationKey: '88880000-0000-4000-8000-000000000002',
  });
  const metadata = { ...input, expectedQuestionnaire: expected };
  expect(canonicalAssessmentInput('tenant', input.engagementId, '0.1.1', metadata)).toBe(
    canonicalAssessmentInput('tenant', input.engagementId, '0.1.1', input),
  );
});
