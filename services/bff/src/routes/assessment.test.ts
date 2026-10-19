import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { AssessmentSnapshotSchema, UserRole } from '@axiom/types';
import { createFakeDb, type FakeDb } from '../test/fake-postgrest.js';
import type { Variables } from '../types.js';
const T = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const E = '33333333-3333-4333-8333-333333333333';
const OLD = '44444444-4444-4444-8444-444444444444';
const PROOF = '55555555-5555-4555-8555-555555555555';
const RUN = '66666666-6666-4666-8666-666666666666';
const LIBRARY_DIGEST = 'a'.repeat(64),
  RESULT_DIGEST = 'b'.repeat(64);
const COMPLETED = '2026-10-05T10:00:00Z';
const db = vi.hoisted(() => ({ current: null as FakeDb | null }));
vi.mock('@axiom/supabase', () => ({ createSupabaseAdmin: () => db.current!.client }));
import { assessmentRoutes } from './assessment.js';
let fake: FakeDb;
function request(query = '', role: UserRole = UserRole.OWNER, contextTenant = T) {
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', { id: T } as never);
    c.set('tenantId', contextTenant as never);
    c.set('role', role);
    await next();
  });
  app.route('/v1', assessmentRoutes());
  return app.request(`/v1/assessment${query}`);
}
const control = (id: string, version = 'v1') => ({
  id,
  library_version: version,
  title: `${id} ${version}`,
  domain: 'SEC',
  citations: [{ instrument: 'Fixture', reference: 'Test citation' }],
});
const finding = (id: string, score: unknown) => ({
  tenant_id: T,
  engagement_id: E,
  library_version: 'v1',
  control_id: id,
  score,
  evidence_ids: [],
});
beforeEach(() => {
  fake = createFakeDb({
    control_libraries: [
      { version: 'v1', control_count: 4, status: 'published' },
      { version: 'v0', control_count: 1, status: 'deprecated' },
    ],
    tenants: [
      { id: OTHER, is_sdf: true },
      { id: T, is_sdf: false },
    ],
    engagements: [
      {
        id: OLD,
        tenant_id: T,
        title: 'Old',
        library_version: 'v0',
        status: 'completed',
        estimated_exposure_inr: 999,
        created_at: '2020-01-01',
      },
      {
        id: E,
        tenant_id: T,
        title: 'Owned',
        library_version: 'v1',
        status: 'assessment',
        estimated_exposure_inr: 0,
        created_at: '2026-01-01',
      },
      {
        id: OTHER,
        tenant_id: OTHER,
        title: 'Foreign',
        library_version: 'v2',
        status: 'completed',
        estimated_exposure_inr: 123,
        created_at: '2030-01-01',
      },
    ],
    controls: [
      control('A'),
      control('B'),
      control('C'),
      control('D'),
      control('A', 'v0'),
      control('A', 'v2'),
    ],
    findings: [
      finding('A', 0),
      finding('B', '60.00'),
      finding('C', 100),
      { ...finding('D', 100), engagement_id: OLD },
      { ...finding('D', 100), tenant_id: OTHER },
      { ...finding('D', 100), library_version: 'v0' },
    ],
    evidence: [],
  });
  db.current = fake;
});

describe('saved assessment projection', () => {
  it('binds all data to one owned engagement and its exact library, preserving measured zeros', async () => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const result = AssessmentSnapshotSchema.parse(await response.json());
    expect(result.engagement).toEqual({
      id: E,
      title: 'Owned',
      libraryVersion: 'v1',
      status: 'assessment',
    });
    expect(result.isSdf).toBe(false);
    expect(result.exposureInr).toBe(0);
    expect(result.controls.map((row) => [row.id, row.score, row.status])).toEqual([
      ['A', 0, 'fail'],
      ['B', 60, 'partial'],
      ['C', 100, 'pass'],
      ['D', null, 'unassessed'],
    ]);
    expect(result.summary).toEqual({
      pass: 1,
      partial: 1,
      fail: 1,
      unassessed: 1,
      unknown: 0,
      not_applicable: 0,
    });
    expect(result.provenance?.status).toBe('unavailable');
    expect(result.controls.every((row) => row.answerState === 'unavailable')).toBe(true);
    expect(result.controls.every((row) => row.evidenceIds.length === 0)).toBe(true);
  });
  it('selects an explicit historical assessment without mixing current results', async () => {
    const response = await request(`?engagementId=${OLD}`);
    const result = AssessmentSnapshotSchema.parse(await response.json());
    expect(result.engagement?.id).toBe(OLD);
    expect(result.controls).toHaveLength(1);
    expect(result.controls[0]?.status).toBe('unassessed');
  });
  it.each([OTHER, PROOF])('does not reveal foreign or missing engagement %s', async (id) => {
    expect((await request(`?engagementId=${id}`)).status).toBe(404);
  });
  it('rejects an invalid engagement identifier', async () => {
    expect((await request('?engagementId=not-an-id')).status).toBe(400);
  });
  it('returns no invented controls/exposure when there is no saved engagement', async () => {
    fake.rows('engagements').splice(0);
    const result = AssessmentSnapshotSchema.parse(await (await request()).json());
    expect(result.engagement).toBeNull();
    expect(result.exposureInr).toBeNull();
    expect(result.controls).toEqual([]);
  });
  it('keeps absent exposure distinct from zero', async () => {
    fake.rows('engagements')[1]!.estimated_exposure_inr = null;
    expect(AssessmentSnapshotSchema.parse(await (await request()).json()).exposureInr).toBeNull();
  });
  it('returns only real evidence IDs cited by the finding and owned by this engagement', async () => {
    fake.rows('findings')[0]!.evidence_ids = [PROOF, OTHER, OLD, PROOF];
    fake.seed('evidence', { id: PROOF, tenant_id: T, engagement_id: E });
    fake.seed('evidence', { id: OTHER, tenant_id: OTHER, engagement_id: E });
    fake.seed('evidence', { id: OLD, tenant_id: T, engagement_id: OLD });
    const result = AssessmentSnapshotSchema.parse(await (await request()).json());
    expect(result.controls[0]?.evidenceIds).toEqual([PROOF]);
  });
  it.each([
    'engagements',
    'tenants',
    'control_libraries',
    'controls',
    'findings',
    'evidence',
    'workload_assessment_packets',
  ])('fails closed on %s query failure', async (table) => {
    fake.failNext(table);
    const response = await request();
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('connection lost');
  });
  it.each([null, '', 'invalid', -1, 101])('refuses malformed persisted score %s', async (score) => {
    fake.rows('findings')[0]!.score = score;
    expect((await request()).status).toBe(503);
  });
  it('refuses a missing control library instead of using the current bundled library', async () => {
    fake.rows('controls').splice(0);
    expect((await request()).status).toBe(503);
  });
  it('refuses duplicate results and does not arbitrarily choose one', async () => {
    fake.seed('findings', finding('A', 100));
    expect((await request()).status).toBe(503);
  });
  it('refuses incomplete result sets at the size limit', async () => {
    for (let i = 0; i < 1001; i++) fake.seed('controls', control(`extra-${i}`));
    expect((await request()).status).toBe(503);
  });
  it('does not truncate the control display to sixteen rows', async () => {
    for (let i = 0; i < 20; i++) fake.seed('controls', control(`extra-${i}`));
    fake.rows('control_libraries')[0]!.control_count = 24;
    const result = AssessmentSnapshotSchema.parse(await (await request()).json());
    expect(result.controls).toHaveLength(24);
    expect(result.summary.unassessed).toBe(21);
  });
  it('refuses a partly populated published library', async () => {
    fake.rows('control_libraries')[0]!.control_count = 5;
    expect((await request()).status).toBe(503);
  });
  it('refuses a zero-control placeholder library even when it is marked published', async () => {
    fake.rows('control_libraries')[0]!.control_count = 0;
    fake.rows('controls').splice(0);
    fake.rows('findings').splice(0);
    const response = await request();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: 'assessment_unavailable' },
    });
  });
  it('shows an intake on the complete published library as unassessed until findings exist', async () => {
    fake.rows('engagements').find((row) => row.id === E)!.status = 'intake';
    fake.rows('findings').splice(0);
    const response = await request();
    expect(response.status).toBe(200);
    const snapshot = AssessmentSnapshotSchema.parse(await response.json());
    expect(snapshot.engagement).toMatchObject({ status: 'intake', libraryVersion: 'v1' });
    expect(snapshot.controls).toHaveLength(4);
    expect(
      snapshot.controls.every(
        (control) => control.score === null && control.status === 'unassessed',
      ),
    ).toBe(true);
    expect(snapshot.summary).toMatchObject({ pass: 0, partial: 0, fail: 0, unassessed: 4 });
    expect(snapshot.provenance?.status).toBe('unavailable');
  });
  it('refuses a draft library as a published assessment baseline', async () => {
    fake.rows('control_libraries')[0]!.status = 'draft';
    expect((await request()).status).toBe(503);
  });
  it('requires posture read capability', async () => {
    expect((await request('', UserRole.AGENT)).status).toBe(403);
  });
});

function seedFinalizedPacket(withProvenance = true) {
  const definitions = fake.rows('controls').filter((row) => row.library_version === 'v1');
  for (const row of definitions) {
    row.assessment_questions = [{ id: `${row.id}-q1`, type: 'boolean' }];
    row.sdf_only = row.id === 'D';
    row.children_only = false;
  }
  fake.rows('findings').splice(0);
  const scores = [30, 60, 100, 100];
  definitions.forEach((row, index) =>
    fake.seed('findings', finding(String(row.id), scores[index])),
  );
  const questionnaire_provenance = {
    version: 1,
    source_library_version: 'v1',
    source_library_digest: LIBRARY_DIGEST,
    estimates: 'provisional',
    review_required: true,
    applicability: {
      sdf_self_attested: { value: false, provenance: 'caller_declared_unverified' },
      processes_children: { value: null, provenance: 'unknown' },
      processes_health: { value: null, provenance: 'unknown' },
    },
    controls: definitions.map((row) => ({
      control_id: row.id,
      questions: [
        {
          question_id: `${row.id}-q1`,
          declaration:
            row.id === 'A' ? 'unknown' : row.id === 'B' ? 'caller_denied' : 'caller_affirmed',
        },
      ],
      known_boolean_question_count: 1,
      caller_affirmed_count: row.id === 'C' || row.id === 'D' ? 1 : 0,
      caller_denied_count: row.id === 'B' ? 1 : 0,
      unknown_count: row.id === 'A' ? 1 : 0,
      answer_state: row.id === 'A' ? 'unknown' : 'caller_declared_unverified',
      applicability_state:
        row.id === 'D' ? 'caller_declared_not_applicable_unverified' : 'unconditional',
    })),
  };
  const result = {
    library_version: 'v1',
    posture_score: 60,
    estimated_exposure_inr: 0,
    findings: definitions.map((row, index) => ({
      control_id: row.id,
      score: scores[index],
      risk_points: 1,
      rationale: 'Unstructured rationale is never parsed.',
    })),
    ...(withProvenance ? { questionnaire_provenance } : {}),
  };
  const packet = fake.seed('workload_assessment_packets', {
    tenant_id: T,
    engagement_id: E,
    run_id: RUN,
    library_version: 'v1',
    library_digest: LIBRARY_DIGEST,
    result_digest: RESULT_DIGEST,
    controls: structuredClone(definitions),
    result,
    started_receipt: '1',
    completed_receipt: '2',
    finalized_receipt: '3',
    completed_at: COMPLETED,
    finalized_at: COMPLETED,
  });
  const run = fake.seed('agent_runs', {
    id: RUN,
    tenant_id: T,
    engagement_id: E,
    agent: 'parikshan',
    status: 'succeeded',
    output_redacted_hash: RESULT_DIGEST,
    completed_at: COMPLETED,
    error: null,
  });
  return { packet, run, result, provenance: questionnaire_provenance };
}
describe('immutable assessment questionnaire provenance', () => {
  it('distinguishes unknown, declaration score bands and caller-declared non-applicability', async () => {
    seedFinalizedPacket();
    const response = await request();
    expect(response.status).toBe(200);
    const result = AssessmentSnapshotSchema.parse(await response.json());
    expect(
      result.controls.map((row) => [row.id, row.score, row.status, row.scoreBand, row.answerState]),
    ).toEqual([
      ['A', 30, 'unknown', 'fail', 'unknown'],
      ['B', 60, 'partial', 'partial', 'caller_declared_unverified'],
      ['C', 100, 'pass', 'pass', 'caller_declared_unverified'],
      ['D', 100, 'not_applicable', 'pass', 'caller_declared_unverified'],
    ]);
    expect(result.summary).toEqual({
      pass: 1,
      partial: 1,
      fail: 0,
      unassessed: 0,
      unknown: 1,
      not_applicable: 1,
    });
    expect(result.provenance).toMatchObject({
      status: 'caller_declared_unverified',
      runId: RUN,
      libraryDigest: LIBRARY_DIGEST,
      estimates: 'provisional',
      applicability: {
        processesChildren: { value: null, provenance: 'unknown' },
        sdfSelfAttested: { value: false, provenance: 'caller_declared_unverified' },
      },
    });
    expect(result.controls[0]?.answerCounts).toEqual({
      knownBooleanQuestions: 1,
      callerAffirmed: 0,
      callerDenied: 0,
      unknown: 1,
    });
    expect(JSON.stringify(result)).not.toContain('question_id');
  });
  it('keeps partially answered controls unknown even when the provisional band is partial', async () => {
    const { packet, result, provenance } = seedFinalizedPacket();
    const questions = [
      { id: 'A-q1', type: 'boolean' },
      { id: 'A-q2', type: 'boolean' },
    ];
    fake.rows('controls')[0]!.assessment_questions = questions;
    (packet.controls as Record<string, unknown>[])[0]!.assessment_questions = questions;
    const a = provenance.controls[0]!;
    a.questions = [
      { question_id: 'A-q1', declaration: 'unknown' },
      { question_id: 'A-q2', declaration: 'caller_affirmed' },
    ];
    a.known_boolean_question_count = 2;
    a.caller_affirmed_count = 1;
    a.answer_state = 'partially_answered';
    result.findings[0]!.score = 60;
    fake.rows('findings')[0]!.score = 60;
    const response = await request();
    expect(response.status).toBe(200);
    const snapshot = AssessmentSnapshotSchema.parse(await response.json());
    expect(snapshot.controls[0]).toMatchObject({
      status: 'unknown',
      scoreBand: 'partial',
      answerState: 'partially_answered',
      answerCounts: { unknown: 1, callerAffirmed: 1 },
    });
  });
  it('keeps unknown pinned applicability separate from fully affirmed questions', async () => {
    const { provenance } = seedFinalizedPacket();
    provenance.applicability.sdf_self_attested = {
      value: null as unknown as boolean,
      provenance: 'unknown',
    };
    provenance.controls[3]!.applicability_state = 'unknown';
    const response = await request();
    expect(response.status).toBe(200);
    const snapshot = AssessmentSnapshotSchema.parse(await response.json());
    expect(snapshot.controls[3]).toMatchObject({
      status: 'unknown',
      scoreBand: 'pass',
      answerState: 'caller_declared_unverified',
      applicabilityState: 'unknown',
    });
    expect(snapshot.isSdf).toBe(false);
    expect(snapshot.provenance?.applicability?.sdfSelfAttested).toEqual({
      value: null,
      provenance: 'unknown',
    });
  });
  it('does not manufacture company facts for a control without Boolean assessment questions', async () => {
    const { packet, provenance } = seedFinalizedPacket();
    fake.rows('controls')[0]!.assessment_questions = [];
    (packet.controls as Record<string, unknown>[])[0]!.assessment_questions = [];
    Object.assign(provenance.controls[0]!, {
      questions: [],
      known_boolean_question_count: 0,
      unknown_count: 0,
      answer_state: 'not_boolean_assessable',
    });
    const response = await request();
    expect(response.status).toBe(200);
    expect(AssessmentSnapshotSchema.parse(await response.json()).controls[0]).toMatchObject({
      status: 'unknown',
      answerState: 'not_boolean_assessable',
    });
  });
  it('refuses result exposure differing from the saved engagement', async () => {
    const { result } = seedFinalizedPacket();
    result.estimated_exposure_inr = 1;
    expect((await request()).status).toBe(503);
  });
  it('refuses reused receipt IDs or finalization preceding completion', async () => {
    const { packet } = seedFinalizedPacket();
    packet.finalized_receipt = packet.completed_receipt;
    expect((await request()).status).toBe(503);
    packet.finalized_receipt = '3';
    packet.finalized_at = '2020-01-01T00:00:00Z';
    expect((await request()).status).toBe(503);
  });
  it('refuses reordered start/completion/finalization receipts', async () => {
    const { packet } = seedFinalizedPacket();
    packet.started_receipt = '4';
    expect((await request()).status).toBe(503);
    packet.started_receipt = '1';
    packet.completed_receipt = '4';
    expect((await request()).status).toBe(503);
  });
  it('accepts uppercase tenant and engagement UUIDs while keeping the exact canonical binding', async () => {
    seedFinalizedPacket();
    const canonicalTenant = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
    const canonicalEngagement = 'abcdefab-1234-4abc-8def-abcdefabcdef';
    for (const table of [
      'tenants',
      'engagements',
      'findings',
      'workload_assessment_packets',
      'agent_runs',
    ]) {
      for (const row of fake.rows(table)) {
        if (table === 'tenants' && row.id === T) row.id = canonicalTenant;
        if (table === 'engagements' && row.id === E) row.id = canonicalEngagement;
        if (row.tenant_id === T) row.tenant_id = canonicalTenant;
        if (row.engagement_id === E) row.engagement_id = canonicalEngagement;
      }
    }
    const response = await request(
      `?engagementId=${canonicalEngagement.toUpperCase()}`,
      UserRole.OWNER,
      canonicalTenant.toUpperCase(),
    );
    expect(response.status).toBe(200);
    const snapshot = AssessmentSnapshotSchema.parse(await response.json());
    expect(snapshot.tenantId).toBe(canonicalTenant);
    expect(snapshot.engagement?.id).toBe(canonicalEngagement);
    expect(snapshot.provenance?.status).toBe('caller_declared_unverified');
  });
  it('keeps a genuine pending packet projection unavailable until finalization; progress belongs to the read-only job status', async () => {
    const { packet, run } = seedFinalizedPacket();
    Object.assign(packet, {
      result: null,
      result_digest: null,
      completed_receipt: null,
      completed_at: null,
      finalized_receipt: null,
      finalized_at: null,
    });
    Object.assign(run, { status: 'running', completed_at: null, output_redacted_hash: null });
    fake.rows('findings').splice(0);
    const response = await request();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'assessment_unavailable' } });
  });
  it('marks finalized legacy packets provenance unavailable without parsing rationale', async () => {
    const { result } = seedFinalizedPacket(false);
    result.findings[0]!.rationale = 'Unknown answer. Partial compliance. SDF false';
    const response = await request();
    expect(response.status).toBe(200);
    const snapshot = AssessmentSnapshotSchema.parse(await response.json());
    expect(snapshot.provenance).toEqual({
      status: 'unavailable',
      runId: RUN,
      libraryDigest: LIBRARY_DIGEST,
      estimates: 'provenance_unavailable',
    });
    expect(snapshot.controls[0]?.status).toBe('fail');
    expect(snapshot.controls[0]?.answerState).toBe('unavailable');
  });
  it.each([
    'finalized_receipt',
    'finalized_at',
    'completed_receipt',
    'completed_at',
    'result',
    'result_digest',
  ])('refuses an incomplete packet with null %s', async (field) => {
    const { packet } = seedFinalizedPacket();
    packet[field] = null;
    expect((await request()).status).toBe(503);
  });
  it('refuses multiple assessment packets instead of selecting arbitrary provenance', async () => {
    const { packet } = seedFinalizedPacket();
    fake.seed('workload_assessment_packets', { ...packet, run_id: PROOF });
    expect((await request()).status).toBe(503);
  });
  it.each(['library_version', 'library_digest', 'controls'])(
    'refuses foreign/corrupt packet %s',
    async (field) => {
      const { packet } = seedFinalizedPacket();
      if (field === 'controls')
        packet.controls = [{ ...(packet.controls as Record<string, unknown>[])[0], id: 'foreign' }];
      else packet[field] = field === 'library_version' ? 'v0' : 'f'.repeat(64);
      expect((await request()).status).toBe(503);
    },
  );
  it.each(['status', 'agent', 'engagement_id', 'output_redacted_hash', 'completed_at', 'error'])(
    'refuses mismatched/non-succeeded run %s',
    async (field) => {
      const { run } = seedFinalizedPacket();
      run[field] = {
        status: 'running',
        agent: 'drishti',
        engagement_id: OLD,
        output_redacted_hash: 'f'.repeat(64),
        completed_at: '2020-01-01T00:00:00Z',
        error: 'internal error',
      }[field as 'status'];
      const response = await request();
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain('internal error');
    },
  );
  it('refuses a foreign tenant run without exposing run metadata', async () => {
    const { run } = seedFinalizedPacket();
    run.tenant_id = OTHER;
    expect((await request()).status).toBe(503);
  });
  it('refuses changed pinned questionnaire or presentation definitions', async () => {
    const { packet } = seedFinalizedPacket();
    (packet.controls as Record<string, unknown>[])[0]!.title = 'Altered immutable title';
    expect((await request()).status).toBe(503);
  });
  it.each(['counts', 'answerState', 'flag', 'binding', 'estimates', 'extra'])(
    'rejects malformed public structured provenance %s',
    async (field) => {
      seedFinalizedPacket();
      const snapshot = AssessmentSnapshotSchema.parse(await (await request()).json());
      const answers = snapshot.controls[0]!;
      if (field === 'counts') answers.answerCounts!.knownBooleanQuestions = 5001;
      if (field === 'answerState') answers.answerState = 'caller_declared_unverified';
      if (field === 'flag')
        snapshot.provenance!.applicability!.processesChildren.provenance =
          'caller_declared_unverified';
      if (field === 'binding') snapshot.provenance!.runId = null;
      if (field === 'estimates') snapshot.provenance!.estimates = 'provenance_unavailable';
      if (field === 'extra') Object.assign(snapshot.provenance!, { verifiedLegalCompliance: true });
      expect(AssessmentSnapshotSchema.safeParse(snapshot).success).toBe(false);
    },
  );
  it('refuses changed retained finding scores', async () => {
    seedFinalizedPacket();
    fake.rows('findings')[0]!.score = 100;
    expect((await request()).status).toBe(503);
  });
  it('refuses packet results missing or repeating pinned controls', async () => {
    const { result } = seedFinalizedPacket();
    result.findings[1] = result.findings[0]!;
    expect((await request()).status).toBe(503);
  });
  it('refuses unknown questionnaire IDs', async () => {
    const { provenance } = seedFinalizedPacket();
    provenance.controls[0]!.questions[0]!.question_id = 'foreign';
    expect((await request()).status).toBe(503);
  });
  it('refuses invented answer-state/count declarations', async () => {
    const { provenance } = seedFinalizedPacket();
    provenance.controls[0]!.answer_state = 'caller_declared_unverified';
    expect((await request()).status).toBe(503);
  });
  it('refuses provenance claiming an unrelated library digest', async () => {
    const { provenance } = seedFinalizedPacket();
    provenance.source_library_digest = 'f'.repeat(64);
    expect((await request()).status).toBe(503);
  });
  it('refuses unavailable run storage', async () => {
    seedFinalizedPacket();
    fake.failNext('agent_runs');
    expect((await request()).status).toBe(503);
  });
});

describe('scheduled coverage is technical provenance only', () => {
  function scheduled() {
    const saved = seedFinalizedPacket();
    saved.run.metadata = { request_kind: 'scheduled_coverage_reassessment_v1' };
    for (const value of Object.values(saved.provenance.applicability)) {
      value.value = null;
      value.provenance = 'unknown';
    }
    for (const row of saved.provenance.controls) {
      row.caller_affirmed_count = 0;
      row.caller_denied_count = 0;
      row.unknown_count = row.known_boolean_question_count;
      row.answer_state = 'unknown';
      row.applicability_state = row.control_id === 'D' ? 'unknown' : 'unconditional';
      for (const question of row.questions) question.declaration = 'unknown';
    }
    const proof = {
      tenantId: T,
      runId: RUN,
      engagementId: E,
      fireId: PROOF,
      scopeId: OLD,
      scopeReceiptId: '10',
      discoveryId: OTHER,
      discoveryResultSha256: 'd'.repeat(64),
      basis: 'technical_provenance_only',
      declarationPolicy: 'all_business_facts_unknown',
    };
    fake.onRpc('read_scheduled_coverage_presentation', () => proof);
    return { ...saved, proof };
  }
  it('withholds every score and exposure even when internal computation retained numbers', async () => {
    scheduled();
    const response = await request('', UserRole.VIEWER);
    expect(response.status).toBe(200);
    const body = AssessmentSnapshotSchema.parse(await response.json());
    expect(body.scheduledCoverage?.basis).toBe('technical_provenance_only');
    expect(body.exposureInr).toBeNull();
    expect(
      body.controls.every(
        (c) => c.score === null && c.scoreBand === null && c.status === 'unknown',
      ),
    ).toBe(true);
  });
  it.each(['tenantId', 'runId', 'engagementId'] as const)(
    'refuses foreign %s presentation proofs',
    async (key) => {
      const saved = scheduled();
      saved.proof[key] = PROOF;
      expect((await request()).status).toBe(503);
    },
  );
  it('refuses a scheduled result containing caller-derived business facts', async () => {
    const saved = scheduled();
    Object.assign(saved.provenance.applicability.processes_children, {
      value: true,
      provenance: 'caller_declared_unverified',
    });
    expect((await request()).status).toBe(503);
  });
});
