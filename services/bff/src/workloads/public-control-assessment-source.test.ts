import { expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { canonicalJson } from '@axiom/ledger';
import { AssessmentRequestSchema } from '@axiom/types';
import { createFakeDb } from '../test/fake-postgrest.js';
import {
  publicControlReviewSetFixture,
  reviewIds as ids,
} from '../test/public-control-review-set-fixture.js';
import { canonicalAssessmentInput } from './assessment-input.js';
import { resolvePublicControlAssessmentSource } from './public-control-assessment-source.js';
const hash = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
function setup() {
  const f = publicControlReviewSetFixture();
  const request = AssessmentRequestSchema.parse({
    operationKey: ids.operation,
    engagementId: ids.engagement,
    reviewRef: {
      reviewId: ids.review,
      requestSha256: f.row.request_sha256,
      snapshotSha256: f.row.snapshot_sha256,
    },
  });
  const inputText = canonicalAssessmentInput(ids.tenant, ids.engagement, '0.1.1', {
    ...request,
    answers: f.snapshot.normalizedAnswers,
    applicability: { sdfSelfAttested: null, processesChildren: null, processesHealth: null },
  });
  const db = createFakeDb();
  const response = { review: f.row, inputText, inputSha256: hash(inputText) };
  db.onRpc('resolve_public_control_assessment_source', () => response);
  return { f, request, db, response };
}
it('derives all questions from the immutable retained snapshot and proves exact unchanged worker bytes', async () => {
  const { request, db, f } = setup();
  const result = await resolvePublicControlAssessmentSource(
    db.client as unknown as SupabaseClient,
    ids.tenant,
    ids.actor,
    request,
  );
  expect(result.derived.answers).toEqual(f.snapshot.normalizedAnswers);
  expect(result.derived.applicability).toEqual({
    sdfSelfAttested: null,
    processesChildren: null,
    processesHealth: null,
  });
  expect(result.derived.expectedQuestionnaire).toEqual({
    libraryVersion: '0.1.1',
    questionnaireDigest: f.request.expectedSource.questionnaireDigest,
  });
  expect(JSON.parse(result.inputText)).not.toHaveProperty('reviewRef');
  expect(JSON.parse(result.inputText)).not.toHaveProperty('evidence_ids');
  expect(result.review.snapshot.request.answers).toEqual(f.request.answers);
});
it.each(['foreign-tenant', 'foreign-review', 'changed-bytes', 'changed-input', 'refused'] as const)(
  'withholds derived input after %s',
  async (kind) => {
    const { request, db, response } = setup();
    if (kind === 'foreign-tenant') response.review.tenant_id = ids.check;
    if (kind === 'foreign-review') response.review.id = ids.check;
    if (kind === 'changed-bytes') response.review.snapshot_text += ' ';
    if (kind === 'changed-input') {
      response.inputText = canonicalJson({
        ...JSON.parse(response.inputText),
        sdf_self_attested: true,
      });
      response.inputSha256 = hash(response.inputText);
    }
    if (kind === 'refused')
      db.onRpc('resolve_public_control_assessment_source', () => ({ error: 'forbidden' }));
    await expect(
      resolvePublicControlAssessmentSource(
        db.client as unknown as SupabaseClient,
        ids.tenant,
        ids.actor,
        request,
      ),
    ).rejects.toThrow();
  },
);
it('does not accept direct browser declarations alongside a retained review reference', () => {
  const { request } = setup();
  expect(
    AssessmentRequestSchema.safeParse({ ...request, answers: { X: { Q: true } } }).success,
  ).toBe(false);
  expect(
    AssessmentRequestSchema.safeParse({
      ...request,
      applicability: { ...request.applicability, processesChildren: true },
    }).success,
  ).toBe(false);
  expect(
    AssessmentRequestSchema.safeParse({
      ...request,
      expectedQuestionnaire: { libraryVersion: '0.1.1', questionnaireDigest: 'a'.repeat(64) },
    }).success,
  ).toBe(false);
});
