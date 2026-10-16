import { expect, it } from 'vitest';
import { assessmentReviewSelectionSchema as schema } from './review-selection';
const selection = {
  engagement: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  reviewId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  requestSha256: 'a'.repeat(64),
  snapshotSha256: 'b'.repeat(64),
};
it('accepts a complete exact review selection without carrying declarations or private text', () => {
  expect(schema.parse(selection)).toEqual({
    engagement: selection.engagement,
    reviewRef: {
      reviewId: selection.reviewId,
      requestSha256: selection.requestSha256,
      snapshotSha256: selection.snapshotSha256,
    },
  });
  expect(schema.parse({})).toEqual({});
  expect(schema.parse({ engagement: selection.engagement }).reviewRef).toBeUndefined();
});
it.each([
  { ...selection, engagement: [selection.engagement, selection.engagement] },
  { ...selection, reviewId: [selection.reviewId, selection.reviewId] },
  { ...selection, requestSha256: [selection.requestSha256] },
  { ...selection, snapshotSha256: 'wrong' },
  { ...selection, engagement: undefined },
  { ...selection, requestSha256: undefined },
  { ...selection, reviewId: undefined },
  { ...selection, rationale: 'Never propagate human text in a selection URL' },
])('refuses ambiguous, incomplete, malformed or extra URL data', (value) =>
  expect(schema.safeParse(value).success).toBe(false),
);
