import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import {
  AssessmentTools,
  assessmentResult,
  validateAssessmentProvenance,
} from './assessment-tools.js';
import type { AuthorizedTask } from './tasks.js';
import { workloadToolsRoutes } from '../routes/workload-tools.js';
const id = (n: number) => `50500000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const proof = Buffer.alloc(32, 9).toString('base64url');
const authorization = {
  tenantId: id(1),
  runId: id(2),
  taskProof: proof,
  workloadProof: 'private-svid',
};
const task: AuthorizedTask = {
  tenantId: id(1),
  runId: id(2),
  workloadId: id(3),
  agentName: 'parikshan',
  createdBy: id(4),
  estateId: null,
  engagementId: id(5),
  correlationId: id(6),
  inputHash: 'a'.repeat(64),
  spiffeId: 'spiffe://local.axiomproof.test/agent/parikshan',
  trustDomain: 'local.axiomproof.test',
  audience: 'axiom-assessment-tools',
  bundleRevision: 'live',
  expiresAt: Date.now() + 60000,
  declaredScopes: ['control_library.read', 'findings.write'],
  grantedScopes: ['control_library.read', 'findings.write'],
};
const packet = {
  engagement_id: id(5),
  library_version: 'test',
  library_digest: 'b'.repeat(64),
  controls: [
    {
      id: 'test',
      library_version: 'test',
      sdf_only: false,
      children_only: false,
      assessment_questions: [
        { id: 'Q1', type: 'boolean' },
        { id: 'Q2', type: 'boolean' },
        { id: 'TEXT', type: 'text' },
      ],
    },
  ],
  started_receipt: '1',
};
const receipt = { completed_receipt: '2', result_digest: 'c'.repeat(64) };
const result = {
  library_version: 'test',
  posture_score: 0,
  estimated_exposure_inr: 1000000,
  findings: [{ control_id: 'test', score: 0, risk_points: 1, rationale: 'Test' }],
};
function provenanceResult() {
  const declaration = { value: null, provenance: 'unknown' };
  return {
    ...result,
    questionnaire_provenance: {
      version: 1,
      source_library_version: 'test',
      source_library_digest: packet.library_digest,
      estimates: 'provisional',
      review_required: true,
      controls: [
        {
          control_id: 'test',
          questions: [
            { question_id: 'Q1', declaration: 'unknown' },
            { question_id: 'Q2', declaration: 'unknown' },
          ],
          known_boolean_question_count: 2,
          caller_affirmed_count: 0,
          caller_denied_count: 0,
          unknown_count: 2,
          answer_state: 'unknown',
          applicability_state: 'unconditional',
        },
      ],
      applicability: {
        sdf_self_attested: { ...declaration },
        processes_children: { ...declaration },
        processes_health: { ...declaration },
      },
    },
  };
}
function fixture(reply: unknown = packet) {
  const authorize = vi.fn(async () => task);
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify(reply), { headers: { 'content-type': 'application/json' } }),
  );
  const db = createClient('https://db.test.invalid', 'private-service-key', {
    global: { fetch: fetcher },
    auth: { persistSession: false },
  });
  const tools = new AssessmentTools({ authorize }, db);
  return { authorize, fetcher, tools, router: workloadToolsRoutes(tools) };
}
describe('fixed workload assessment tools', () => {
  it('passes source-bound structured unknown state unchanged and includes it in the persisted result', async () => {
    const f = fixture();
    f.fetcher.mockImplementation(
      async (url) =>
        new Response(
          JSON.stringify(String(url).includes('start_workload_assessment') ? packet : receipt),
        ),
    );
    await f.tools.start({ authorization, inputHash: task.inputHash });
    const input = provenanceResult();
    expect(
      await f.tools.complete({
        authorization,
        libraryDigest: packet.library_digest,
        result: input,
      }),
    ).toEqual(receipt);
    const written = JSON.parse(String(f.fetcher.mock.calls[1]![1]!.body)).p_result;
    expect(written).toEqual(input);
    expect(validateAssessmentProvenance(written, packet.controls, packet.library_digest)).toEqual({
      status: 'available_unverified',
      provenance: input.questionnaire_provenance,
    });
    expect(JSON.stringify(written)).not.toMatch(/private-svid|taskProof|"answers"/);
  });
  it('accepts legacy packets while explicitly reporting unavailable provenance', () => {
    expect(assessmentResult.parse(result)).toEqual(result);
    expect(validateAssessmentProvenance(result, packet.controls, packet.library_digest)).toEqual({
      status: 'unavailable',
      provenance: null,
    });
  });
  it('refuses metadata without a trusted source packet and never queries or writes to discover one', async () => {
    const f = fixture(receipt);
    await expect(
      f.tools.complete({
        authorization,
        libraryDigest: packet.library_digest,
        result: provenanceResult(),
      }),
    ).rejects.toThrow();
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each(['expired', 'workload', 'inputHash', 'digest', 'engagement'])(
    'refuses stale or changed %s source authority before completion',
    async (fault) => {
      const f = fixture();
      await f.tools.start({ authorization, inputHash: task.inputHash });
      f.authorize.mockResolvedValue({
        ...task,
        ...(fault === 'expired' ? { expiresAt: Date.now() - 1 } : {}),
        ...(fault === 'workload' ? { workloadId: id(9) } : {}),
        ...(fault === 'inputHash' ? { inputHash: 'e'.repeat(64) } : {}),
        ...(fault === 'engagement' ? { engagementId: id(9) } : {}),
      });
      await expect(
        f.tools.complete({
          authorization,
          libraryDigest: fault === 'digest' ? 'e'.repeat(64) : packet.library_digest,
          result: provenanceResult(),
        }),
      ).rejects.toThrow();
      expect(f.fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it('bounds aggregate UTF-8 provenance before accessing authority or the database', async () => {
    const input = provenanceResult();
    const control = input.questionnaire_provenance.controls[0]!;
    control.questions = Array.from({ length: 600 }, (_, i) => ({
      question_id: `Q${i}` + '界'.repeat(180),
      declaration: 'unknown',
    }));
    control.known_boolean_question_count = 600;
    control.unknown_count = 600;
    const f = fixture();
    await expect(
      f.tools.complete({ authorization, libraryDigest: packet.library_digest, result: input }),
    ).rejects.toThrow();
    expect(f.authorize).not.toHaveBeenCalled();
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('bounds the source projection even when individual source fields are valid', () => {
    const source = structuredClone(packet.controls);
    source[0]!.assessment_questions = Array.from({ length: 600 }, (_, i) => ({
      id: `T${i}` + '界'.repeat(180),
      type: 'text',
    })).concat(source[0]!.assessment_questions);
    expect(() =>
      validateAssessmentProvenance(provenanceResult(), source, packet.library_digest),
    ).toThrow();
  });
  it('requires authorized start replay to repin a source after a tool process restart', async () => {
    const f = fixture();
    f.fetcher.mockImplementation(
      async (url) =>
        new Response(
          JSON.stringify(String(url).includes('start_workload_assessment') ? packet : receipt),
        ),
    );
    await f.tools.start({ authorization, inputHash: task.inputHash });
    const restarted = new AssessmentTools(
      { authorize: f.authorize },
      createClient('https://db.test.invalid', 'private-service-key', {
        global: { fetch: f.fetcher },
        auth: { persistSession: false },
      }),
    );
    const completion = {
      authorization,
      libraryDigest: packet.library_digest,
      result: provenanceResult(),
    };
    await expect(restarted.complete(completion)).rejects.toThrow();
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    await restarted.start({ authorization, inputHash: task.inputHash });
    expect(await restarted.complete(completion)).toEqual(receipt);
    expect(f.fetcher.mock.calls.map(([url]) => String(url).split('/').at(-1))).toEqual([
      'start_workload_assessment',
      'start_workload_assessment',
      'complete_workload_assessment',
    ]);
  });
  it('binds the result library version to the trusted packet envelope', async () => {
    const f = fixture({ ...packet, library_version: 'foreign' });
    await f.tools.start({ authorization, inputHash: task.inputHash });
    await expect(
      f.tools.complete({
        authorization,
        libraryDigest: packet.library_digest,
        result: provenanceResult(),
      }),
    ).rejects.toThrow();
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it('caps live source snapshots and prunes expired snapshots before a new start', async () => {
    const f = fixture();
    for (let i = 0; i < 32; i++) {
      f.authorize.mockResolvedValue({ ...task, runId: id(100 + i) });
      await f.tools.start({
        authorization: { ...authorization, runId: id(100 + i) },
        inputHash: task.inputHash,
      });
    }
    f.authorize.mockResolvedValue({ ...task, runId: id(132) });
    await expect(
      f.tools.start({
        authorization: { ...authorization, runId: id(132) },
        inputHash: task.inputHash,
      }),
    ).rejects.toThrow();
    expect(f.fetcher).toHaveBeenCalledTimes(32);
    const now = vi.spyOn(Date, 'now').mockReturnValue(task.expiresAt + 1);
    try {
      f.authorize.mockResolvedValue({ ...task, runId: id(132), expiresAt: task.expiresAt + 60000 });
      await f.tools.start({
        authorization: { ...authorization, runId: id(132) },
        inputHash: task.inputHash,
      });
      expect(f.fetcher).toHaveBeenCalledTimes(33);
    } finally {
      now.mockRestore();
    }
  });
  it('discards a previous source if authorized start replay returns an unbindable library', async () => {
    const f = fixture();
    await f.tools.start({ authorization, inputHash: task.inputHash });
    f.fetcher.mockResolvedValueOnce(
      new Response(JSON.stringify({ ...packet, controls: [{ id: 'legacy' }] })),
    );
    await f.tools.start({ authorization, inputHash: task.inputHash });
    await expect(
      f.tools.complete({
        authorization,
        libraryDigest: packet.library_digest,
        result: provenanceResult(),
      }),
    ).rejects.toThrow();
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([
    'version',
    'count',
    'duplicateQid',
    'duplicateControl',
    'foreignControl',
    'state',
    'declaration',
    'privateExtra',
    'confirmed',
  ])('refuses malformed %s provenance before any authority or database call', async (fault) => {
    const input = provenanceResult();
    const p = input.questionnaire_provenance;
    if (fault === 'version') p.version = 2;
    if (fault === 'count') p.controls[0]!.unknown_count = 1;
    if (fault === 'duplicateQid') p.controls[0]!.questions[1]!.question_id = 'Q1';
    if (fault === 'duplicateControl') p.controls.push(structuredClone(p.controls[0]!));
    if (fault === 'foreignControl') p.controls[0]!.control_id = 'foreign';
    if (fault === 'state') p.controls[0]!.answer_state = 'caller_declared_unverified';
    if (fault === 'declaration')
      p.applicability.processes_children.provenance = 'caller_declared_unverified';
    if (fault === 'privateExtra')
      Object.assign(p, { raw_answers: 'private-person@example.invalid' });
    if (fault === 'confirmed') p.estimates = 'confirmed';
    const f = fixture();
    await expect(
      f.tools.complete({ authorization, libraryDigest: packet.library_digest, result: input }),
    ).rejects.toThrow();
    expect(f.authorize).not.toHaveBeenCalled();
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each([
    'unknownQid',
    'textQid',
    'digest',
    'nullDigest',
    'library',
    'sourceFlag',
    'sourceVersion',
    'sourceDuplicate',
  ])(
    'refuses coherent but foreign %s provenance against known pinned definitions',
    async (fault) => {
      const input = provenanceResult();
      const source = structuredClone(packet.controls);
      if (fault === 'unknownQid')
        input.questionnaire_provenance.controls[0]!.questions[1]!.question_id = 'invented';
      if (fault === 'textQid')
        input.questionnaire_provenance.controls[0]!.questions[1]!.question_id = 'TEXT';
      if (fault === 'digest') input.questionnaire_provenance.source_library_digest = 'e'.repeat(64);
      if (fault === 'nullDigest')
        Object.assign(input.questionnaire_provenance, { source_library_digest: null });
      if (fault === 'library') {
        input.library_version = 'foreign';
        input.questionnaire_provenance.source_library_version = 'foreign';
      }
      if (fault === 'sourceFlag') Object.assign(source[0]!, { sdf_only: 'false' });
      if (fault === 'sourceVersion') source[0]!.library_version = 'foreign';
      if (fault === 'sourceDuplicate')
        source[0]!.assessment_questions.push({ id: 'Q1', type: 'boolean' });
      expect(() => validateAssessmentProvenance(input, source, packet.library_digest)).toThrow();
    },
  );
  it.each([
    [null, null, 'unknown'],
    [true, null, 'unknown'],
    [null, false, 'caller_declared_not_applicable_unverified'],
    [true, true, 'caller_declared_applicable_unverified'],
    [false, true, 'caller_declared_not_applicable_unverified'],
  ])(
    'binds conditional applicability to actual source flags and nullable declarations',
    (sdf, children, expected) => {
      const input = provenanceResult();
      const source = structuredClone(packet.controls);
      source[0]!.sdf_only = true;
      source[0]!.children_only = true;
      Object.assign(input.questionnaire_provenance.applicability.sdf_self_attested, {
        value: sdf,
        provenance: sdf === null ? 'unknown' : 'caller_declared_unverified',
      });
      Object.assign(input.questionnaire_provenance.applicability.processes_children, {
        value: children,
        provenance: children === null ? 'unknown' : 'caller_declared_unverified',
      });
      input.questionnaire_provenance.controls[0]!.applicability_state = String(expected);
      expect(validateAssessmentProvenance(input, source, packet.library_digest).status).toBe(
        'available_unverified',
      );
      input.questionnaire_provenance.controls[0]!.applicability_state = 'unconditional';
      expect(() => validateAssessmentProvenance(input, source, packet.library_digest)).toThrow();
    },
  );
  it('refuses source-question substitution after a valid start without calling completion RPC', async () => {
    const f = fixture();
    await f.tools.start({ authorization, inputHash: task.inputHash });
    const input = provenanceResult();
    input.questionnaire_provenance.controls[0]!.questions[1]!.question_id = 'invented';
    await expect(
      f.tools.complete({ authorization, libraryDigest: packet.library_digest, result: input }),
    ).rejects.toThrow();
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it('binds start to verified task, hashes the private proof and forwards the identity deadline', async () => {
    const f = fixture();
    expect(await f.tools.start({ authorization, inputHash: task.inputHash })).toEqual(packet);
    expect(f.authorize).toHaveBeenCalledWith(
      { ...authorization, agentName: 'parikshan' },
      'control_library.read',
    );
    const args = JSON.parse(String(f.fetcher.mock.calls[0]![1]!.body));
    expect(args).toEqual({
      p_tenant_id: task.tenantId,
      p_run_id: task.runId,
      p_workload_id: task.workloadId,
      p_proof_hash: createHash('sha256').update(proof).digest('hex'),
      p_identity_expires_at: new Date(task.expiresAt).toISOString(),
      p_input_hash: task.inputHash,
    });
    expect(JSON.stringify(args)).not.toContain(proof);
  });
  it('reauthenticates for write and preserves zero scores', async () => {
    const f = fixture(receipt);
    expect(
      await f.tools.complete({ authorization, libraryDigest: packet.library_digest, result }),
    ).toEqual(receipt);
    expect(f.authorize).toHaveBeenCalledWith(
      { ...authorization, agentName: 'parikshan' },
      'findings.write',
    );
    expect(JSON.parse(String(f.fetcher.mock.calls[0]![1]!.body)).p_result.findings[0].score).toBe(
      0,
    );
  });
  it.each([
    { inputHash: 'c'.repeat(64) },
    { inputHash: task.inputHash, agentName: 'karya' },
    { inputHash: task.inputHash, tenantId: id(7) },
  ])('refuses wrong input or caller-selected context before database access', async (extra) => {
    const f = fixture();
    await expect(f.tools.start({ authorization, ...extra })).rejects.toThrow(
      'Workload task authority was refused.',
    );
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each([null, { error: 'task_refused' }, { ...packet, engagement_id: id(8) }])(
    'refuses malformed or foreign database packets',
    async (reply) => {
      await expect(
        fixture(reply).tools.start({ authorization, inputHash: task.inputHash }),
      ).rejects.toThrow('Workload task authority was refused.');
    },
  );
  it('refuses expired authority before a write', async () => {
    const f = fixture();
    f.authorize.mockResolvedValue({ ...task, expiresAt: Date.now() - 1 });
    await expect(
      f.tools.complete({ authorization, libraryDigest: packet.library_digest, result }),
    ).rejects.toThrow();
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('does not reveal private adapter failures over the route', async () => {
    const f = fixture();
    f.authorize.mockRejectedValue(new Error('private-service-key private-svid'));
    const response = await f.router.request('/assessment/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ authorization, inputHash: task.inputHash }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'tool_refused' });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('denies ordinary startup even with browser or legacy bearer headers', async () => {
    const router = workloadToolsRoutes();
    for (const token of ['human-session', 'legacy-shared-token']) {
      const response = await router.request('/assessment/start', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(503);
    }
  });
  it('bounds request size and refuses query-supplied authority', async () => {
    const f = fixture();
    expect(
      (await f.router.request('/assessment/start', { method: 'POST', body: 'x'.repeat(1048577) }))
        .status,
    ).toBe(413);
    expect(
      (
        await f.router.request('/assessment/start?taskProof=private', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(403);
    expect(f.authorize).not.toHaveBeenCalled();
  });
});
