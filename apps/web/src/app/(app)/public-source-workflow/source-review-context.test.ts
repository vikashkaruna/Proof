import { expect, it } from 'vitest';
import { currentReviewTarget, reviewTargets, validateReviewContext } from './source-review-context';
import { reviewFixture, reviewIds as i } from './source-review-fixture.test-helper';
import { reviewOperationSchema } from './source-review-request';
it('uses only current flags, never latest timestamp, independently for whole and indicators', async () => {
  const { observation, row } = await reviewFixture();
  const targets = reviewTargets(observation);
  expect(targets).toHaveLength(2);
  const rows = [
    row,
    { ...row, review_id: i.check, created_at: '2026-10-06T01:00:00Z', is_current: false },
  ];
  expect(currentReviewTarget(rows, targets[0]!.target, true).previousId).toBe(row.review_id);
  expect(currentReviewTarget(rows, targets[1]!.target, true).resolved).toBe(false);
  expect(currentReviewTarget(rows, targets[1]!.target, false).previousId).toBeNull();
  expect(
    currentReviewTarget([{ ...row, is_current: false }], targets[0]!.target, false).resolved,
  ).toBe(false);
  expect(
    currentReviewTarget([row, { ...row, review_id: i.check }], targets[0]!.target, false).resolved,
  ).toBe(false);
});
it.each([
  'tenant_id',
  'engagement_id',
  'binding_id',
  'observation_id',
  'check_id',
  'run_id',
  'dispatch_id',
  'root_content_sha256',
  'projection_sha256',
  'output_sha256',
  'completion_receipt',
])('refuses a review with mismatched %s', async (field) => {
  const { observation, row } = await reviewFixture();
  const value = field.includes('sha256')
    ? 'f'.repeat(64)
    : field === 'completion_receipt'
      ? '22'
      : i.review;
  expect(() => validateReviewContext({ ...row, [field]: value }, observation, i.tenant)).toThrow();
});
it.each([
  'reviewed_by',
  'operation_key',
  'decision',
  'justification',
  'previous_review_id',
  'target',
])('refuses a retained result with changed request %s', async (field) => {
  const { observation, row } = await reviewFixture();
  const body = {
    engagementId: i.engagement,
    expectedOutputSha256: row.output_sha256,
    expectedProjectionSha256: row.projection_sha256,
    target: { kind: 'whole_observation' },
    decision: row.decision,
    justification: row.justification,
    expectedPreviousReviewId: null,
  };
  const op = reviewOperationSchema.parse({
    version: 1,
    tenantId: i.tenant,
    actorId: i.actor,
    operationKey: i.check,
    engagementId: i.engagement,
    bindingId: i.binding,
    observationId: i.observation,
    checkId: i.check,
    agent: 'vibhaag',
    rootSha256: row.root_content_sha256,
    outputSha256: row.output_sha256,
    projectionSha256: row.projection_sha256,
    bodyUtf8: JSON.stringify(body),
  });
  const changed = { ...row };
  if (field === 'reviewed_by') changed.reviewed_by = i.review;
  if (field === 'operation_key') changed.operation_key = i.review;
  if (field === 'decision') changed.decision = 'disputed';
  if (field === 'justification') changed.justification = row.justification.trim();
  if (field === 'previous_review_id') changed.previous_review_id = i.check;
  if (field === 'target') {
    changed.target_kind = 'vibhaag_indicator';
    changed.page = 'root';
    changed.form_ordinal = 1;
    changed.control_ordinal = 2;
    changed.content_sha256 = 'a'.repeat(64);
    changed.source_indicator =
      observation.agent === 'vibhaag' ? observation.output.indicators[0]! : null;
  }
  expect(() => validateReviewContext(changed, observation, i.tenant, op)).toThrow();
});
