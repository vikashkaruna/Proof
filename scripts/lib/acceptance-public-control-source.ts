/** Synthetic network bytes only. Production URL/DNS policy, extractor, codec,
 * capture persistence, human review and controller remain in the real path.
 * This proves neither public networking nor cloud KMS/IAM readiness. */
import assert from 'node:assert/strict';
import { verifyEngagementIntakeReceipt } from '../../services/bff/src/routes/engagement-intake.js';
import { guardedParitySql } from './parity-fixture-target.js';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  AssessmentQuestionnaireSchema,
  AssessmentRequestReceiptSchema,
  AssessmentSnapshotSchema,
  publicControlAssessmentV2Schema,
  publicControlReviewSetRowSchema,
  publicControlReviewSetSnapshotSchema,
  publicControlReviewSetRequestSchema,
} from '../../packages/types/src/index.js';
import { canonicalJson } from '../../packages/ledger/src/canonicalise.js';
import { checkPublicWebsiteEvidenceV2 } from '../../services/bff/src/connectors/public-website.js';

export const acceptancePublicWebsiteCapture: typeof checkPublicWebsiteEvidenceV2 = (url, signal) =>
  checkPublicWebsiteEvidenceV2(url, signal, {
    resolve4: async (hostname) => {
      assert.equal(hostname, 'fixture.axiomproof.ai');
      return ['93.184.216.34'];
    },
    fetchPage: async (url, address) => {
      assert.equal(address, '93.184.216.34');
      assert.equal(url.origin, 'https://fixture.axiomproof.ai');
      return {
        status: 200,
        contentType: 'text/html',
        body: Buffer.from(
          '<!doctype html><html><body><h1>Synthetic organisation</h1><a href="/privacy">Privacy policy</a><p>Privacy policy: we collect contact data to answer enquiries. Contact our grievance officer for access, correction and erasure.</p></body></html>',
        ),
      };
    },
  });

type Request = (path: string, expected: number, options?: RequestInit) => Promise<Response>;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sourceRow = z.object({
  estate_id: z.uuid(),
  job_id: z.uuid(),
  run_id: z.uuid(),
  tenant_id: z.uuid(),
  actor_id: z.uuid(),
  engagement_id: z.uuid(),
  review_id: z.uuid(),
  request_sha256: digest,
  snapshot_sha256: digest,
  input_text: z.string(),
  input_sha256: digest,
  requested_receipt: z.coerce.string(),
  review_receipt: z.coerce.string(),
  capture_receipt: z.coerce.string(),
});
export async function verifyPublicControlSourceThroughController(deps: {
  request: Request;
  headers: Record<string, string>;
  db: SupabaseClient;
  tenantId: string;
  actorId: string;
  libraryVersion: string;
  execute: (jobId: string) => Promise<void>;
  launchCount: () => number;
}) {
  z.uuid().parse(deps.tenantId);
  z.uuid().parse(deps.actorId);
  const engagementId = randomUUID();
  const post = (body: unknown, key: string = randomUUID()): RequestInit => ({
    method: 'POST',
    headers: { ...deps.headers, 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(body),
  });
  const estate = z
    .object({ data: z.object({ id: z.uuid(), tenant_id: z.uuid(), slug: z.string() }) })
    .parse(
      await (
        await deps.request(
          '/v1/estates',
          201,
          post({
            slug: `synthetic-${engagementId}`,
            name: 'Synthetic controller acceptance estate',
            description: 'Disposable test inventory, no client data.',
          }),
        )
      ).json(),
    ).data;
  assert.equal(estate.tenant_id, deps.tenantId);
  const estateId = estate.id;
  const system = z
    .object({ data: z.object({ id: z.uuid(), estate_id: z.uuid(), tenant_id: z.uuid() }) })
    .parse(
      await (
        await deps.request(
          `/v1/estates/${estateId}/systems`,
          201,
          post({
            name: 'Synthetic public website inventory',
            systemKind: 'application',
            externalRef: 'https://fixture.axiomproof.ai/',
            description: 'Declared inventory only; no capture-to-system ownership asserted.',
            dataCategories: [],
          }),
        )
      ).json(),
    ).data;
  assert.equal(system.tenant_id, deps.tenantId);
  assert.equal(system.estate_id, estateId);
  const inventory = z
    .object({
      data: z.object({
        id: z.uuid(),
        systems: z.array(z.object({ id: z.uuid(), estate_id: z.uuid() })),
      }),
    })
    .parse(
      await (await deps.request(`/v1/estates/${estateId}`, 200, { headers: deps.headers })).json(),
    ).data;
  assert.equal(inventory.id, estateId);
  assert.deepEqual(
    inventory.systems.map((v) => ({ id: v.id, estate_id: v.estate_id })),
    [{ id: system.id, estate_id: estateId }],
  );
  const intake = {
    requestKey: engagementId,
    estateId,
    libraryVersion: deps.libraryVersion,
    title: 'Synthetic reviewed-source controller assessment',
  };
  const intakeKey = randomUUID();
  const saved = verifyEngagementIntakeReceipt(
    await (await deps.request('/v1/engagements', 201, post(intake, intakeKey))).json(),
    { tenantId: deps.tenantId, actorId: deps.actorId, request: intake },
  );
  assert.equal(saved.estate_id, estateId);
  assert.equal(saved.legacy, false);
  assert.equal(saved.replayed, false);
  assert(saved.receipt);
  // The real idempotency middleware may return its retained 201 response. This
  // proves HTTP replay without fabricating a second intake or creation receipt.
  const replayedIntake = verifyEngagementIntakeReceipt(
    await (await deps.request('/v1/engagements', 201, post(intake, intakeKey))).json(),
    { tenantId: deps.tenantId, actorId: deps.actorId, request: intake },
  );
  assert.deepEqual(replayedIntake, saved);
  for (const [action, target] of [
    ['estate.created', estateId],
    ['estate.system.created', system.id],
    ['engagement.created', engagementId],
  ]) {
    const receipt = await deps.db
      .from('audit_ledger')
      .select('id,actor_id,actor_type')
      .eq('tenant_id', deps.tenantId)
      .eq('target_ref', target!)
      .eq('action_type', action!);
    assert.equal(receipt.error, null);
    assert.equal(receipt.data?.length, 1);
    assert.equal(receipt.data?.[0]?.actor_id, deps.actorId);
    assert.equal(receipt.data?.[0]?.actor_type, 'human');
    if (action === 'engagement.created') assert.equal(String(receipt.data?.[0]?.id), saved.receipt);
  }
  const captured = z
    .object({ data: z.object({ id: z.uuid() }) })
    .parse(
      await (
        await deps.request(
          '/v1/public-website-checks',
          201,
          post({ url: 'https://fixture.axiomproof.ai/' }),
        )
      ).json(),
    );
  const checkId = captured.data.id;
  const retained = z
    .object({
      data: z.object({ assessment: publicControlAssessmentV2Schema, captureReceipt: z.string() }),
    })
    .parse(
      await (
        await deps.request(
          `/v1/public-website-checks/${checkId}/control-review?engagementId=${engagementId}`,
          200,
          { headers: deps.headers },
        )
      ).json(),
    ).data;
  const questionnaire = AssessmentQuestionnaireSchema.parse(
    await (
      await deps.request(`/v1/assessment/questionnaire?engagementId=${engagementId}`, 200, {
        headers: deps.headers,
      })
    ).json(),
  );
  const request = publicControlReviewSetRequestSchema.parse({
    version: 1,
    operationKey: randomUUID(),
    engagementId,
    checkId,
    expectedEstateId: estateId,
    expectedPreviousReviewId: null,
    expectedSource: {
      payloadSha256: retained.assessment.source.projectionSha256,
      catalogueManifestSha256: retained.assessment.catalogue.manifestSha256,
      mappingVersion: 'public-evidence-1',
      libraryVersion: deps.libraryVersion,
      questionnaireDigest: questionnaire.questionnaireDigest,
    },
    answers: {
      'DPDPA-GOV-001': {
        Q1: {
          answer: true,
          rationale: 'Synthetic human declaration, not verified evidence.',
          candidateOrdinals: [],
        },
      },
    },
    applicability: {
      sdfSelfAttested: null,
      processesChildren: null,
      processesHealth: null,
      rationale: 'Synthetic human has no internal applicability evidence.',
    },
  });
  const reviewReply = await deps.request('/v1/public-control-review-sets', 201, {
    ...post(request, request.operationKey),
    body: canonicalJson(request),
  });
  const review = z
    .object({
      data: z.object({
        review: publicControlReviewSetRowSchema,
        isCurrent: z.literal(true),
        contextCurrent: z.literal(true),
      }),
    })
    .parse(await reviewReply.json()).data.review;
  const reviewSnapshot = publicControlReviewSetSnapshotSchema.parse(
    JSON.parse(review.snapshot_text),
  );
  assert.equal(reviewSnapshot.normalizedAnswers['DPDPA-GOV-001']?.Q1, true);
  assert.equal(reviewSnapshot.captureReceipt, retained.captureReceipt);
  const jobId = randomUUID();
  const intent = {
    operationKey: jobId,
    engagementId,
    answers: {},
    applicability: { sdfSelfAttested: null, processesChildren: null, processesHealth: null },
    reviewRef: {
      reviewId: review.id,
      requestSha256: review.request_sha256,
      snapshotSha256: review.snapshot_sha256,
    },
  };
  const before = deps.launchCount();
  const accepted = AssessmentRequestReceiptSchema.parse(
    await (await deps.request('/v1/assessment/jobs', 202, post(intent, jobId))).json(),
  );
  assert.equal(deps.launchCount(), before);
  const beforePackets = await deps.db
    .from('workload_assessment_packets')
    .select('run_id')
    .eq('run_id', accepted.runId);
  assert.equal(beforePackets.error, null);
  assert.deepEqual(beforePackets.data, []);
  const forgedId = randomUUID();
  const forged = await deps.request(
    '/v1/assessment/jobs',
    503,
    post(
      {
        ...intent,
        operationKey: forgedId,
        reviewRef: { ...intent.reviewRef, snapshotSha256: 'f'.repeat(64) },
      },
      forgedId,
    ),
  );
  assert.equal(
    z
      .object({ error: z.object({ code: z.literal('assessment_request_unconfirmed') }) })
      .parse(await forged.json()).error.code,
    'assessment_request_unconfirmed',
  );
  assert.equal(deps.launchCount(), before);
  await deps.execute(jobId);
  assert.equal(deps.launchCount(), before + 1);
  const final = z
    .object({
      status: z.literal('finalization_recorded'),
      finalization: z.object({ resultDigest: digest }),
    })
    .parse(
      await (
        await deps.request(`/v1/assessment/jobs/${jobId}`, 200, { headers: deps.headers })
      ).json(),
    );
  const snapshot = AssessmentSnapshotSchema.parse(
    await (
      await deps.request(`/v1/assessment?engagementId=${engagementId}`, 200, {
        headers: deps.headers,
      })
    ).json(),
  );
  assert.equal(snapshot.controls.length, 46);
  assert.equal(snapshot.provenance?.runId, accepted.runId);
  assert.equal(
    snapshot.controls.reduce((n, c) => n + (c.answerCounts?.callerAffirmed ?? 0), 0),
    1,
  );
  assert.equal(
    snapshot.controls.reduce((n, c) => n + (c.answerCounts?.unknown ?? 0), 0),
    64,
  );
  // Source sidecars deliberately have no service-role SELECT grant. Inspect only
  // through the existing disposable-fixture guarded SQL observer, never add a grant.
  const sourceSql = () =>
    guardedParitySql(
      `select coalesce(json_agg(s),'[]'::json)::text from public.public_control_assessment_sources s where tenant_id='${deps.tenantId}' and job_id='${jobId}';`,
      'postgres',
    ).trim();
  const [source] = z.array(sourceRow).length(1).parse(JSON.parse(sourceSql()));
  assert(source);
  assert.equal(source.run_id, accepted.runId);
  assert.equal(source.actor_id, deps.actorId);
  assert.equal(source.engagement_id, engagementId);
  assert.equal(source.estate_id, estateId);
  assert.equal(source.review_id, review.id);
  assert.equal(source.request_sha256, review.request_sha256);
  assert.equal(source.snapshot_sha256, review.snapshot_sha256);
  assert.equal(source.review_receipt, review.receipt_id);
  assert.equal(source.capture_receipt, retained.captureReceipt);
  assert.equal(createHash('sha256').update(source.input_text).digest('hex'), source.input_sha256);
  const workerInput = z
    .object({ answers: z.record(z.string(), z.record(z.string(), z.boolean().nullable())) })
    .parse(JSON.parse(source.input_text));
  assert.deepEqual(workerInput.answers, reviewSnapshot.normalizedAnswers);
  const packet = await deps.db
    .from('workload_assessment_packets')
    .select('result_digest,finalized_receipt')
    .eq('tenant_id', deps.tenantId)
    .eq('run_id', accepted.runId)
    .single();
  assert.equal(packet.error, null);
  assert.equal(packet.data?.result_digest, final.finalization.resultDigest);
  assert(packet.data?.finalized_receipt);
  const replay = AssessmentRequestReceiptSchema.parse(
    await (await deps.request('/v1/assessment/jobs', 202, post(intent, jobId))).json(),
  );
  assert.deepEqual(replay, accepted);
  assert.equal(deps.launchCount(), before + 1);
  assert.deepEqual(z.array(sourceRow).length(1).parse(JSON.parse(sourceSql())), [source]);
  assert.equal(
    guardedParitySql(
      `select r.metadata->>'assessment_request_receipt'=s.requested_receipt::text and r.output_redacted_hash=p.result_digest and p.result_digest=encode(sha256(convert_to(p.result::text,'UTF8')),'hex') from public.public_control_assessment_sources s join public.agent_runs r on r.tenant_id=s.tenant_id and r.id=s.run_id join public.workload_assessment_packets p on p.tenant_id=s.tenant_id and p.run_id=s.run_id where s.tenant_id='${deps.tenantId}' and s.job_id='${jobId}';`,
      'postgres',
    ).trim(),
    't',
  );
  const requests = await deps.db
    .from('audit_ledger')
    .select('id')
    .eq('tenant_id', deps.tenantId)
    .eq('target_ref', jobId)
    .eq('action_type', 'assessment.requested');
  assert.equal(requests.error, null);
  assert.equal(requests.data?.length, 1);
  const chain = await deps.db.rpc('verify_ledger', {
    p_tenant_id: deps.tenantId,
    p_from_sequence: 1,
  });
  assert.equal(chain.error, null);
  assert.deepEqual(chain.data, []);
  return {
    kind: 'isolated-reviewed-public-source-real-controller',
    estateId,
    systemId: system.id,
    engagementId,
    intakeReceipt: saved.receipt,
    jobId,
    runId: accepted.runId,
    reviewId: review.id,
    inputSha256: source.input_sha256,
    captureReceipt: source.capture_receipt,
    reviewReceipt: source.review_receipt,
    requestedReceipt: source.requested_receipt,
    network: 'synthetic-dns-and-page-bytes',
    kms: 'fixture-only-no-cloud-iam-proof',
  };
}
