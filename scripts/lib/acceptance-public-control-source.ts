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
  publicControlReviewSetAnyRowSchema,
  publicControlReviewSetAnySnapshotSchema,
  publicControlReviewSetSnapshotSchema,
  publicControlReviewSetRequestSchema,
} from '../../packages/types/src/index.js';
import type { RegisteredBrowserSubmission } from './acceptance-public-asset-browser.js';
import { registeredBrowserRequested } from './acceptance-public-asset-browser.js';
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
          registeredBrowserRequested()
            ? registeredPage(url.pathname)
            : '<!doctype html><html><body><h1>Synthetic organisation</h1><a href="/privacy">Privacy policy</a><p>Privacy policy: we collect contact data to answer enquiries. Contact our grievance officer for access, correction and erasure.</p></body></html>',
        ),
      };
    },
  });

function registeredPage(path: string) {
  const page = {
    '/': '<h1>Synthetic organisation</h1><a href="/privacy">Privacy policy</a><a href="/contact">Contact</a><a href="/terms">Terms</a><a href="/consent">Consent choices</a><p>Privacy notice for contact enquiries.</p>',
    '/privacy':
      '<h1>Privacy notice</h1><p>We collect contact data for the purpose of answering enquiries. You may request access, correction and erasure. Contact our grievance officer for complaints. Personal data is retained only for the stated purpose.</p>',
    '/contact':
      '<h1>Contact enquiries</h1><p>Before collecting contact information, this collection notice explains the purpose of answering your enquiry.</p><form><label>Name<input autocomplete="name"></label><label>Email<input autocomplete="email" type="email"></label><label>Message<textarea name="message"></textarea></label></form>',
    '/terms':
      '<h1>Terms of service</h1><p>Our service providers process personal data for the stated purpose. Personal data is retained for that purpose. You may request correction and erasure.</p>',
    '/consent':
      '<h1>Consent controls — demo only</h1><p>Withdraw consent at any time.</p><form><label><input type="checkbox" checked required>I agree to analytics cookies</label></form>',
  }[path];
  assert(page, 'synthetic public page refused');
  return '<!doctype html><html><body>' + page + '</body></html>';
}

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
  onPhase: (phase: string) => void;
  browserSubmit?: (scope: {
    estateId: string;
    systemId: string;
    engagementId: string;
  }) => Promise<RegisteredBrowserSubmission>;
}) {
  z.uuid().parse(deps.tenantId);
  z.uuid().parse(deps.actorId);
  deps.onPhase('fixture-library-current');
  // Only this engineering-owned disposable parity fixture is selected by the
  // guard. Published controls/metadata stay unchanged; intake needs a current
  // library, while the shared report seed deliberately leaves it noncurrent.
  assert.equal(
    guardedParitySql(
      `do $$begin
    if exists(select 1 from public.control_libraries where is_current and version<>'0.1.1')
      or not exists(select 1 from public.control_libraries where version='0.1.1' and status='published' and control_count=46)
      or (select count(*) from public.controls where library_version='0.1.1')<>46
    then raise exception 'owned fixture catalogue selection refused'; end if;
    update public.control_libraries set is_current=true where version='0.1.1' and status='published' and control_count=46;
  end$$;
  select count(*)=1 and bool_and(version='0.1.1' and control_count=46 and status='published') from public.control_libraries where is_current;`,
      'postgres',
    ).trim(),
    't',
  );
  const engagementId = randomUUID();
  const post = (body: unknown, key: string = randomUUID()): RequestInit => ({
    method: 'POST',
    headers: { ...deps.headers, 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(body),
  });
  deps.onPhase('estate-create');
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
  deps.onPhase('system-create');
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
  deps.onPhase('inventory-readback');
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
  deps.onPhase('intake-create');
  const saved = verifyEngagementIntakeReceipt(
    await (await deps.request('/v1/engagements', 201, post(intake, intakeKey))).json(),
    { tenantId: deps.tenantId, actorId: deps.actorId, request: intake },
  );
  assert.equal(saved.estate_id, estateId);
  assert.equal(saved.legacy, false);
  assert.equal(saved.replayed, false);
  assert(saved.receipt);
  // Intake bypasses generic response caching: replay returns the current full
  // saved row and original atomic creation receipt with replayed=true.
  deps.onPhase('intake-replay');
  const replayedIntake = verifyEngagementIntakeReceipt(
    await (await deps.request('/v1/engagements', 200, post(intake, intakeKey))).json(),
    { tenantId: deps.tenantId, actorId: deps.actorId, request: intake },
  );
  assert.equal(replayedIntake.replayed, true);
  assert.equal(replayedIntake.legacy, false);
  assert.deepEqual({ ...replayedIntake, replayed: false }, saved);
  deps.onPhase('creation-receipts');
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
  if (deps.browserSubmit)
    return verifyRegisteredSource(deps, {
      estateId,
      systemId: system.id,
      engagementId,
      intakeReceipt: saved.receipt,
    });
  deps.onPhase('capture');
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
  deps.onPhase('capture-review-read');
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
  deps.onPhase('questionnaire-read');
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
  deps.onPhase('human-review-save');
  const reviewReply = await deps.request('/v1/public-control-review-sets', 201, {
    ...post(request, request.operationKey),
    body: canonicalJson(request),
  });
  const review = z
    .object({
      data: z.object({
        review: publicControlReviewSetRowSchema.extend({
          snapshot: publicControlReviewSetSnapshotSchema,
        }),
        isCurrent: z.literal(true),
        contextCurrent: z.literal(true),
      }),
    })
    .parse(await reviewReply.json()).data.review;
  const reviewSnapshot = publicControlReviewSetSnapshotSchema.parse(
    JSON.parse(review.snapshot_text),
  );
  assert.deepEqual(review.snapshot, reviewSnapshot);
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
  deps.onPhase('request-source');
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
  deps.onPhase('forged-digest-refusal');
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
  deps.onPhase('controller-finalize');
  await deps.execute(jobId);
  assert.equal(deps.launchCount(), before + 1);
  deps.onPhase('finalized-http-readback');
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
  deps.onPhase('immutable-source-provenance');
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
  deps.onPhase('source-replay');
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
  deps.onPhase('final-receipts-chain');
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

async function verifyRegisteredSource(
  deps: Parameters<typeof verifyPublicControlSourceThroughController>[0],
  scope: { estateId: string; systemId: string; engagementId: string; intakeReceipt: string },
) {
  assert(deps.browserSubmit);
  deps.onPhase('browser-register-capture-review-request');
  const submitted = await deps.browserSubmit(scope);
  assert.equal(submitted.tenantId, deps.tenantId);
  assert.equal(submitted.actorId, deps.actorId);
  assert.equal(submitted.engagementId, scope.engagementId);
  const head = z
    .object({
      data: z.object({
        review: publicControlReviewSetAnyRowSchema.safeExtend({
          snapshot: publicControlReviewSetAnySnapshotSchema,
        }),
      }),
    })
    .parse(
      await (
        await deps.request(
          `/v1/public-control-review-sets/current?engagementId=${scope.engagementId}&checkId=${submitted.checkId}`,
          200,
          { headers: deps.headers },
        )
      ).json(),
    ).data.review;
  assert.equal(head.id, submitted.reviewId);
  assert.equal(head.request_sha256, submitted.reviewRequestSha256);
  assert.equal(head.snapshot_sha256, submitted.reviewSnapshotSha256);
  assert.equal(head.snapshot.version, 2);
  assert.equal(head.snapshot.request.version, 2);
  if (head.snapshot.request.version !== 2) throw new Error('registered review downgrade refused');
  assert.equal(head.snapshot.request.associationRef.associationId, submitted.associationId);
  assert.equal(head.snapshot.request.associationRef.associationSha256, submitted.associationSha256);
  assert.equal(head.snapshot.request.associationRef.targetId, submitted.targetId);
  assert.equal(head.snapshot.request.associationRef.targetSha256, submitted.targetSha256);
  assert.equal(head.snapshot.normalizedAnswers['DPDPA-GOV-001']?.Q1, true);
  const observations = await deps.db
    .from('public_source_observations')
    .select(
      'id,tenant_id,engagement_id,binding_id,actor_id,agent,output_utf8,output_sha256,completion_receipt,dispatch_id',
    )
    .eq('tenant_id', deps.tenantId)
    .eq('binding_id', submitted.bindingId);
  assert.equal(observations.error, null);
  const observed = z
    .array(
      z.object({
        id: z.uuid(),
        tenant_id: z.uuid(),
        engagement_id: z.uuid(),
        binding_id: z.uuid(),
        actor_id: z.uuid(),
        agent: z.enum(['drishti', 'vibhaag']),
        output_utf8: z.string(),
        output_sha256: digest,
        completion_receipt: z.coerce.string(),
        dispatch_id: z.uuid(),
      }),
    )
    .length(2)
    .parse(observations.data);
  assert.deepEqual(
    new Set(observed.map((o) => o.id)),
    new Set([submitted.drishtiObservationId, submitted.vibhaagObservationId]),
  );
  for (const observation of observed) {
    assert.equal(observation.actor_id, deps.actorId);
    assert.equal(observation.engagement_id, scope.engagementId);
    assert.equal(
      createHash('sha256').update(observation.output_utf8).digest('hex'),
      observation.output_sha256,
    );
    const claim = await deps.db
      .from('public_source_dispatch_claims')
      .select('dispatch_id')
      .eq('tenant_id', deps.tenantId)
      .eq('dispatch_id', observation.dispatch_id)
      .single();
    assert.equal(claim.error, null);
    assert.equal(claim.data?.dispatch_id, observation.dispatch_id);
    const receipt = await deps.db
      .from('audit_ledger')
      .select('actor_type,actor_id,action_type,output_hash')
      .eq('tenant_id', deps.tenantId)
      .eq('id', observation.completion_receipt)
      .single();
    assert.equal(receipt.error, null);
    assert.equal(receipt.data?.actor_type, 'agent');
    assert.equal(receipt.data?.actor_id, observation.agent);
    assert.equal(receipt.data?.action_type, 'agent.completed');
    assert.equal(receipt.data?.output_hash, observation.output_sha256);
  }
  const before = deps.launchCount();
  const accepted = z
    .object({ jobId: z.uuid(), runId: z.uuid(), status: z.literal('unconfirmed') })
    .parse(
      await (
        await deps.request(`/v1/assessment/jobs/${submitted.jobId}`, 200, { headers: deps.headers })
      ).json(),
    );
  assert.equal(accepted.jobId, submitted.jobId);
  assert.equal(accepted.runId, submitted.runId);
  // No controller starts merely by navigating or receiving the human request.
  const packets = await deps.db
    .from('workload_assessment_packets')
    .select('run_id')
    .eq('run_id', submitted.runId);
  assert.equal(packets.error, null);
  assert.deepEqual(packets.data, []);
  deps.onPhase('browser-source-real-controller-finalize');
  await deps.execute(submitted.jobId);
  assert.equal(deps.launchCount(), before + 1);
  const terminal = z
    .object({
      status: z.literal('finalization_recorded'),
      finalization: z.object({ resultDigest: digest }),
    })
    .parse(
      await (
        await deps.request(`/v1/assessment/jobs/${submitted.jobId}`, 200, { headers: deps.headers })
      ).json(),
    );
  const snapshot = AssessmentSnapshotSchema.parse(
    await (
      await deps.request(`/v1/assessment?engagementId=${scope.engagementId}`, 200, {
        headers: deps.headers,
      })
    ).json(),
  );
  assert.equal(snapshot.provenance?.runId, submitted.runId);
  assert.equal(snapshot.controls.length, 46);
  assert.equal(
    snapshot.controls.reduce((n, c) => n + (c.answerCounts?.callerAffirmed ?? 0), 0),
    1,
  );
  assert.equal(
    snapshot.controls.reduce((n, c) => n + (c.answerCounts?.unknown ?? 0), 0),
    64,
  );
  const rows = z
    .array(sourceRow)
    .length(1)
    .parse(
      JSON.parse(
        guardedParitySql(
          `select coalesce(json_agg(s),'[]'::json)::text from public.public_control_assessment_sources s where tenant_id='${deps.tenantId}' and job_id='${submitted.jobId}';`,
          'postgres',
        ).trim(),
      ),
    );
  const source = rows[0]!;
  assert.equal(source.actor_id, deps.actorId);
  assert.equal(source.estate_id, scope.estateId);
  assert.equal(source.engagement_id, scope.engagementId);
  assert.equal(source.run_id, submitted.runId);
  assert.equal(source.review_id, head.id);
  assert.equal(source.request_sha256, head.request_sha256);
  assert.equal(source.snapshot_sha256, head.snapshot_sha256);
  assert.equal(source.review_receipt, head.receipt_id);
  assert.equal(source.capture_receipt, head.snapshot.captureReceipt);
  assert.equal(createHash('sha256').update(source.input_text).digest('hex'), source.input_sha256);
  assert.deepEqual(
    z.object({ answers: z.unknown() }).parse(JSON.parse(source.input_text)).answers,
    head.snapshot.normalizedAnswers,
  );
  const replay = AssessmentRequestReceiptSchema.parse(
    await (
      await deps.request('/v1/assessment/jobs', 202, {
        method: 'POST',
        headers: {
          ...deps.headers,
          'content-type': 'application/json',
          'idempotency-key': submitted.jobId,
        },
        body: submitted.requestText,
      })
    ).json(),
  );
  assert.equal(replay.jobId, submitted.jobId);
  assert.equal(replay.runId, submitted.runId);
  assert.equal(deps.launchCount(), before + 1);
  const chain = await deps.db.rpc('verify_ledger', {
    p_tenant_id: deps.tenantId,
    p_from_sequence: 1,
  });
  assert.equal(chain.error, null);
  assert.deepEqual(chain.data, []);
  assert(terminal.finalization.resultDigest);
  return {
    kind: 'isolated-reviewed-public-source-real-controller',
    ...scope,
    jobId: submitted.jobId,
    runId: submitted.runId,
    reviewId: head.id,
    inputSha256: source.input_sha256,
    captureReceipt: source.capture_receipt,
    reviewReceipt: source.review_receipt,
    requestedReceipt: source.requested_receipt,
    network: 'synthetic-dns-and-page-bytes',
    kms: 'fixture-only-no-cloud-iam-proof',
    publicSourceAgents: {
      bindingId: submitted.bindingId,
      drishtiObservationId: submitted.drishtiObservationId,
      vibhaagObservationId: submitted.vibhaagObservationId,
      verifiedRetainedOutputs: observed.map((o) => ({
        agent: o.agent,
        observationId: o.id,
        outputSha256: o.output_sha256,
        completionReceipt: o.completion_receipt,
      })),
    },
    asset: {
      targetId: submitted.targetId,
      targetSha256: submitted.targetSha256,
      associationId: submitted.associationId,
      associationSha256: submitted.associationSha256,
      checkId: submitted.checkId,
    },
  };
}

/** Allowlisted diagnostics only: never retain assertion actual/expected, raw
 * exception text, payload values or arbitrary schema property names. */
export function publicControlAcceptanceFailure(error: unknown) {
  if (error instanceof z.ZodError) {
    const fields = new Set([
      'data',
      'id',
      'tenant_id',
      'estate_id',
      'receipt',
      'legacy',
      'replayed',
      'review',
      'snapshot_text',
      'source',
      'controls',
      'finalization',
      'resultDigest',
      'request_sha256',
      'snapshot_sha256',
      'input_text',
      'input_sha256',
    ]);
    return {
      kind: 'schema' as const,
      path:
        error.issues[0]?.path.map((key) =>
          typeof key === 'number' ? 'index' : fields.has(String(key)) ? String(key) : 'field',
        ) ?? [],
    };
  }
  return {
    kind:
      error instanceof assert.AssertionError
        ? ('assertion' as const)
        : error instanceof Error
          ? ('error' as const)
          : ('non_error' as const),
    path: [],
  };
}
