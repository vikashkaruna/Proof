// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { canonicalJson } from '@axiom/ledger';
import { AssessmentRequestSchema, ASSESSMENT_REQUEST_MAX_BYTES } from '@axiom/types';
import {
  readAssessmentJournal,
  AssessmentSourceRequiredError,
  archiveRejectedAssessmentJournal,
  resolveAssessmentSourceIntent,
  clearCancelledAssessmentSourceJournal,
  retainAssessmentJournal,
  clearFinalizedAssessmentJournal,
  assessmentJournalKey,
  submitUnknownAssessment,
  cancelUnclaimedAssessmentRequest,
  readAssessmentRequest,
  assessmentJobReadoutSchema,
  type RetainedAssessment,
} from './request';

const tenant = '11111111-1111-4111-8111-111111111111';
const actor = '22222222-2222-4222-8222-222222222222';
const engagement = '33333333-3333-4333-8333-333333333333';
const operation = '44444444-4444-4444-8444-444444444444';
const run = '55555555-5555-4555-8555-555555555555';
export const retainedFixture = (): RetainedAssessment => ({
  tenantId: tenant,
  actorId: actor,
  libraryVersion: '0.1.1',
  request: AssessmentRequestSchema.parse({ operationKey: operation, engagementId: engagement }),
});
const accepted = () => ({
  jobId: operation,
  runId: run,
  expiresAt: '2026-10-05T12:00:00Z',
  status: 'accepted',
  statusUrl: `/api/bff/v1/assessment/jobs/${operation}`,
});
export const readoutFixture = (finalized = false) => ({
  jobId: operation,
  runId: run,
  engagementId: engagement,
  correlationId: operation,
  libraryVersion: '0.1.1',
  recordedRunStatus: finalized ? 'succeeded' : 'queued',
  schedulingStatus: 'pending',
  createdAt: '2026-10-05T11:00:00Z',
  claimedAt: finalized ? '2026-10-05T11:01:00Z' : null,
  allAgentEndToEndAccepted: false,
  status: finalized ? 'finalization_recorded' : 'unconfirmed',
  phase: finalized ? 'finalized' : 'queued',
  finalization: finalized
    ? {
        startedReceipt: '11',
        completedReceipt: '12',
        finalizedReceipt: '13',
        resultDigest: 'a'.repeat(64),
        completedAt: '2026-10-05T11:02:00Z',
        finalizedAt: '2026-10-05T11:03:00Z',
        verification: 'persisted_controller_receipt_bindings',
      }
    : null,
});
const fetchMock = vi.fn();
beforeEach(() => {
  localStorage.clear();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());
it('retains exact actor/tenant/engagement/key and genuinely unknown flags', () => {
  const value = retainedFixture();
  retainAssessmentJournal(localStorage, value);
  expect(readAssessmentJournal(localStorage, tenant, actor)).toEqual(value);
  expect(value.request.answers).toEqual({});
  expect(Object.values(value.request.applicability)).toEqual([null, null, null]);
});
it('retains reviewed Boolean/unknown declarations and their exact source reference without coercion', () => {
  const value = {
    ...retainedFixture(),
    questionnaireDigest: 'd'.repeat(64),
    request: {
      ...retainedFixture().request,
      answers: { C: { Q1: true, Q2: false, Q3: null } },
      applicability: { sdfSelfAttested: null, processesChildren: false, processesHealth: true },
    },
  };
  retainAssessmentJournal(localStorage, value);
  expect(readAssessmentJournal(localStorage, tenant, actor)).toEqual(value);
  expect(() =>
    retainAssessmentJournal(localStorage, {
      ...value,
      request: { ...value.request, answers: { C: { Q1: false } } },
    }),
  ).toThrow(/Resolve/);
  expect(readAssessmentJournal(localStorage, tenant, actor)).toEqual(value);
});
it('refuses an oversized valid declaration body before retention or POST', async () => {
  const value = {
    ...retainedFixture(),
    questionnaireDigest: 'd'.repeat(64),
    request: {
      ...retainedFixture().request,
      answers: {
        C: Object.fromEntries(
          Array.from({ length: 900 }, (_, i) => [`Q${i}${'x'.repeat(190)}`, true]),
        ),
      },
    },
  };
  expect(new TextEncoder().encode(JSON.stringify(value.request)).length).toBeGreaterThan(
    ASSESSMENT_REQUEST_MAX_BYTES,
  );
  expect(() => retainAssessmentJournal(localStorage, value)).toThrow(/supported request size/);
  await expect(submitUnknownAssessment(value)).rejects.toThrow(/supported request size/);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(readAssessmentJournal(localStorage, tenant, actor)).toBeNull();
});
it('refuses overwriting a different pending request or clearing a changed reference', () => {
  const value = retainedFixture();
  retainAssessmentJournal(localStorage, value);
  const other = { ...value, request: { ...value.request, operationKey: run } };
  expect(() => retainAssessmentJournal(localStorage, other)).toThrow(/Resolve/);
  expect(() =>
    clearFinalizedAssessmentJournal(
      localStorage,
      other,
      assessmentJobReadoutSchema.parse({ ...readoutFixture(true), jobId: run, correlationId: run }),
    ),
  ).toThrow(/changed/);
  expect(readAssessmentJournal(localStorage, tenant, actor)).toEqual(value);
});
it.each(['bad-json', 'wrong-actor', 'known-facts', 'oversized'])(
  'refuses corrupted local request %s without submitting',
  (kind) => {
    const value = retainedFixture();
    localStorage.setItem(
      assessmentJournalKey(tenant, actor),
      kind === 'bad-json'
        ? '{'
        : kind === 'oversized'
          ? 'x'.repeat(4097)
          : JSON.stringify(
              kind === 'wrong-actor'
                ? { ...value, actorId: run }
                : { ...value, request: { ...value.request, answers: { C: { Q: true } } } },
            ),
    );
    expect(() => readAssessmentJournal(localStorage, tenant, actor)).toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  },
);
it('submits once with the exact retained key and expected authenticated actor', async () => {
  fetchMock.mockResolvedValue(Response.json(accepted(), { status: 202 }));
  await submitUnknownAssessment(retainedFixture());
  expect(fetchMock).toHaveBeenCalledOnce();
  const [path, init] = fetchMock.mock.calls[0]!;
  expect(path).toBe('/api/bff/v1/assessment/jobs');
  expect(init.headers).toMatchObject({
    'X-Tenant-Id': tenant,
    'X-Expected-Actor-Id': actor,
    'Idempotency-Key': operation,
  });
  expect(JSON.parse(init.body)).toEqual(retainedFixture().request);
});
it('does not automatically retry an interrupted submission', async () => {
  fetchMock.mockRejectedValue(new Error('private transport error'));
  await expect(submitUnknownAssessment(retainedFixture())).rejects.toThrow(/interrupted/);
  expect(fetchMock).toHaveBeenCalledOnce();
});
it.each(['job', 'path', 'completion-claim'])(
  'refuses mismatched accepted receipt %s',
  async (kind) => {
    const value = {
      ...accepted(),
      ...(kind === 'job'
        ? { jobId: run }
        : kind === 'path'
          ? { statusUrl: '/untrusted' }
          : { status: 'completed' }),
    };
    fetchMock.mockResolvedValue(Response.json(value, { status: 202 }));
    await expect(submitUnknownAssessment(retainedFixture())).rejects.toThrow();
  },
);
it('reads queued progress without writing or claiming completion', async () => {
  fetchMock.mockResolvedValue(Response.json(readoutFixture()));
  expect((await readAssessmentRequest(retainedFixture())).status).toBe('unconfirmed');
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(fetchMock.mock.calls[0]![1]).not.toHaveProperty('body');
  expect(fetchMock.mock.calls[0]![1]).not.toHaveProperty('method');
});
it.each(['job', 'engagement', 'correlation', 'library', 'all-agent'])(
  'refuses foreign/stale readout %s',
  async (kind) => {
    const fields = {
      job: { jobId: run },
      engagement: { engagementId: run },
      correlation: { correlationId: run },
      library: { libraryVersion: 'foreign' },
      'all-agent': { allAgentEndToEndAccepted: true },
    };
    fetchMock.mockResolvedValue(
      Response.json({ ...readoutFixture(true), ...fields[kind as keyof typeof fields] }),
    );
    await expect(readAssessmentRequest(retainedFixture())).rejects.toThrow();
  },
);
it('reads only the source-matching recorded finalization', async () => {
  fetchMock.mockResolvedValue(Response.json(readoutFixture(true)));
  const status = await readAssessmentRequest(retainedFixture());
  expect(status.status).toBe('finalization_recorded');
  expect(status.allAgentEndToEndAccepted).toBe(false);
});

it.each(['sdfSelfAttested', 'processesChildren', 'processesHealth'] as const)(
  'refuses a known %s declaration in the unknown-only browser request',
  async (flag) => {
    for (const known of [true, false]) {
      const value = retainedFixture();
      value.request.applicability[flag] = known;
      expect(() => retainAssessmentJournal(localStorage, value)).toThrow();
      await expect(submitUnknownAssessment(value)).rejects.toThrow();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(localStorage.getItem(assessmentJournalKey(tenant, actor))).toBeNull();
    }
  },
);

const resolutionFixture = () => ({
  ...readoutFixture(),
  status: 'resolution_recorded',
  phase: 'cancelled_unclaimed',
  recordedRunStatus: 'cancelled',
  resolution: {
    actorId: actor,
    requestedReceipt: '21',
    cancellationReceipt: '22',
    resolvedAt: '2026-10-05T11:02:00Z',
    verification: 'persisted_human_unclaimed_cancellation_bindings',
    workerCleanupVerified: false,
  },
});
it('cancels only the exact retained reviewed body and original operation key without erasing its journal', async () => {
  const value = {
    ...retainedFixture(),
    questionnaireDigest: 'd'.repeat(64),
    request: {
      ...retainedFixture().request,
      answers: { C: { Q: true, N: false, U: null } },
      applicability: { sdfSelfAttested: null, processesChildren: false, processesHealth: true },
    },
  };
  retainAssessmentJournal(localStorage, value);
  fetchMock.mockResolvedValue(
    Response.json(
      {
        jobId: operation,
        runId: run,
        cancellationReceipt: '22',
        resolvedAt: '2026-10-05T11:02:00Z',
        status: 'cancellation_recorded',
      },
      { status: 202 },
    ),
  );
  await cancelUnclaimedAssessmentRequest(value, assessmentJobReadoutSchema.parse(readoutFixture()));
  const [path, init] = fetchMock.mock.calls[0]!;
  expect(path).toBe(`/api/bff/v1/assessment/jobs/${operation}/cancel`);
  expect(init.method).toBe('POST');
  expect(init.headers).toMatchObject({
    'X-Tenant-Id': tenant,
    'X-Expected-Actor-Id': actor,
    'Idempotency-Key': operation,
  });
  expect(JSON.parse(init.body)).toEqual(value.request);
  expect(readAssessmentJournal(localStorage, tenant, actor)).toEqual(value);
});
it.each(['job', 'engagement', 'library', 'claimed', 'running', 'phase', 'finalized'])(
  'refuses cancellation of ineligible recorded context %s before posting',
  async (kind) => {
    const changes: Record<string, Record<string, unknown>> = {
      job: { jobId: run },
      engagement: { engagementId: run },
      library: { libraryVersion: 'other' },
      claimed: { claimedAt: '2026-10-05T11:01:00Z' },
      running: { recordedRunStatus: 'running' },
      phase: { phase: 'dispatch_needs_review' },
      finalized: readoutFixture(true),
    };
    await expect(
      cancelUnclaimedAssessmentRequest(retainedFixture(), {
        ...readoutFixture(),
        ...changes[kind],
      } as never),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  },
);
it('lost cancellation response preserves the original body and permits an exact explicit retry', async () => {
  const value = retainedFixture();
  retainAssessmentJournal(localStorage, value);
  fetchMock.mockRejectedValueOnce(new Error('lost response')).mockResolvedValueOnce(
    Response.json(
      {
        jobId: operation,
        runId: run,
        cancellationReceipt: '22',
        resolvedAt: '2026-10-05T11:02:00Z',
        status: 'cancellation_recorded',
      },
      { status: 202 },
    ),
  );
  const status = assessmentJobReadoutSchema.parse(readoutFixture());
  await expect(cancelUnclaimedAssessmentRequest(value, status)).rejects.toThrow(/interrupted/);
  expect(fetchMock).toHaveBeenCalledOnce();
  await cancelUnclaimedAssessmentRequest(
    readAssessmentJournal(localStorage, tenant, actor)!,
    status,
  );
  expect(fetchMock.mock.calls[1]![0]).toEqual(fetchMock.mock.calls[0]![0]);
  expect(fetchMock.mock.calls[1]![1].body).toEqual(fetchMock.mock.calls[0]![1].body);
  expect(fetchMock.mock.calls[1]![1].headers).toEqual(fetchMock.mock.calls[0]![1].headers);
  expect(readAssessmentJournal(localStorage, tenant, actor)).toEqual(value);
});
it('archives only a server-verified matching cancellation resolution', () => {
  const value = retainedFixture();
  retainAssessmentJournal(localStorage, value);
  clearFinalizedAssessmentJournal(
    localStorage,
    value,
    assessmentJobReadoutSchema.parse(resolutionFixture()),
  );
  expect(readAssessmentJournal(localStorage, tenant, actor)).toBeNull();
});
it.each([
  'actor',
  'cleanup',
  'duplicate-receipt',
  'claimed',
  'wrong-job',
  'older-resolution',
  'generic-cancelled',
])('keeps browser reference when resolution proof is invalid: %s', (kind) => {
  const value = retainedFixture();
  retainAssessmentJournal(localStorage, value);
  const result = resolutionFixture();
  const changes: Record<string, Record<string, unknown>> = {
    actor: { resolution: { ...result.resolution, actorId: run } },
    cleanup: { resolution: { ...result.resolution, workerCleanupVerified: true } },
    'duplicate-receipt': { resolution: { ...result.resolution, cancellationReceipt: '21' } },
    claimed: { claimedAt: '2026-10-05T11:01:00Z' },
    'wrong-job': { jobId: run },
    'older-resolution': {
      resolution: { ...result.resolution, resolvedAt: '2026-10-04T11:02:00Z' },
    },
    'generic-cancelled': {
      status: 'unconfirmed',
      phase: 'dispatch_cancelled',
      resolution: undefined,
    },
  };
  expect(() =>
    clearFinalizedAssessmentJournal(
      localStorage,
      value,
      assessmentJobReadoutSchema.parse({ ...result, ...changes[kind] }),
    ),
  ).toThrow();
  expect(readAssessmentJournal(localStorage, tenant, actor)).toEqual(value);
});
it('never archives a valid unconfirmed status or a write acknowledgement without read proof', () => {
  const value = retainedFixture();
  retainAssessmentJournal(localStorage, value);
  expect(() =>
    clearFinalizedAssessmentJournal(
      localStorage,
      value,
      assessmentJobReadoutSchema.parse(readoutFixture()),
    ),
  ).toThrow(/resolved/);
  expect(() =>
    clearFinalizedAssessmentJournal(localStorage, value, {
      jobId: operation,
      runId: run,
      cancellationReceipt: '22',
      resolvedAt: '2026-10-05T11:02:00Z',
      status: 'cancellation_recorded',
    } as never),
  ).toThrow();
  expect(readAssessmentJournal(localStorage, tenant, actor)).toEqual(value);
});
it.each(['library', 'digest'])(
  'refuses changed nested reviewed %s before retaining or submitting',
  (field) => {
    const value = {
      ...retainedFixture(),
      questionnaireDigest: 'd'.repeat(64),
      request: {
        ...retainedFixture().request,
        answers: { C: { Q1: true } },
        expectedQuestionnaire: {
          libraryVersion: field === 'library' ? 'foreign' : '0.1.1',
          questionnaireDigest: field === 'digest' ? 'f'.repeat(64) : 'd'.repeat(64),
        },
      },
    };
    expect(() => retainAssessmentJournal(localStorage, value)).toThrow(/reviewed source/);
    expect(localStorage.getItem(assessmentJournalKey(tenant, actor))).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  },
);

function sourceIntentFixture() {
  const v = retainedFixture();
  v.request = AssessmentRequestSchema.parse({
    ...v.request,
    reviewRef: { reviewId: run, requestSha256: 'a'.repeat(64), snapshotSha256: 'b'.repeat(64) },
  });
  const reason = 'Human explicitly abandons this source intent.';
  const request_text = canonicalJson(v.request),
    request_sha256 = 'c'.repeat(64);
  const cancellation_text = canonicalJson({
    version: 1,
    tenantId: tenant,
    actorId: actor,
    jobId: operation,
    engagementId: engagement,
    requestSha256: request_sha256,
    reason,
  });
  const row = {
    id: run,
    tenant_id: tenant,
    actor_id: actor,
    job_id: operation,
    engagement_id: engagement,
    request_text,
    request_sha256,
    reason,
    cancellation_text,
    cancellation_sha256: 'd'.repeat(64),
    receipt_id: '99',
    created_at: '2026-10-16T00:00:00Z',
  };
  return { value: v, row, reason };
}
it('preserves a source journal after not_found or refusal and clears only exact positive cancellation readback', async () => {
  const { value, row } = sourceIntentFixture();
  retainAssessmentJournal(localStorage, value);
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ data: { state: 'not_found' } }))
    .mockResolvedValueOnce(Response.json({ error: { code: 'forbidden' } }, { status: 403 }))
    .mockResolvedValueOnce(Response.json({ data: { state: 'cancelled', data: row } }));
  vi.stubGlobal('fetch', fetchMock);
  const absent = await resolveAssessmentSourceIntent(value);
  expect(() => clearCancelledAssessmentSourceJournal(localStorage, value, absent)).toThrow();
  expect(readAssessmentJournal(localStorage, tenant, actor)).toEqual(value);
  await expect(resolveAssessmentSourceIntent(value)).rejects.toThrow();
  expect(readAssessmentJournal(localStorage, tenant, actor)).toEqual(value);
  const positive = await resolveAssessmentSourceIntent(value);
  clearCancelledAssessmentSourceJournal(localStorage, value, positive);
  expect(readAssessmentJournal(localStorage, tenant, actor)).toBeNull();
  expect(fetchMock.mock.calls.every((call) => call[1].method === 'GET')).toBe(true);
});
it('never archives another actor or a concurrently changed journal on source cancellation', async () => {
  const { value, row } = sourceIntentFixture();
  retainAssessmentJournal(localStorage, value);
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        Response.json({ data: { state: 'cancelled', data: { ...row, actor_id: run } } }),
      ),
  );
  await expect(resolveAssessmentSourceIntent(value)).rejects.toThrow();
  expect(readAssessmentJournal(localStorage, tenant, actor)).toEqual(value);
  const changed = { ...value, request: { ...value.request, operationKey: run } };
  localStorage.setItem(assessmentJournalKey(tenant, actor), JSON.stringify(changed));
  expect(() =>
    clearCancelledAssessmentSourceJournal(localStorage, value, { state: 'cancelled', data: row }),
  ).toThrow();
  expect(readAssessmentJournal(localStorage, tenant, actor)).toEqual(changed);
});

const sourceRefusal = (value = retainedFixture()) => ({
  code: 'assessment_public_control_review_required' as const,
  tenantId: value.tenantId,
  actorId: value.actorId,
  engagementId: value.request.engagementId,
  operationKey: value.request.operationKey,
  requestText: canonicalJson(value.request),
  dispatchState: 'not_recorded' as const,
  sourceRequirement: 'public_control_review_required' as const,
});
it('recognizes only exact bound definite refusal and preserves the retained request', async () => {
  const value = retainedFixture();
  retainAssessmentJournal(localStorage, value);
  const fetchMock = vi.mocked(fetch);
  fetchMock.mockResolvedValueOnce(Response.json({ error: sourceRefusal(value) }, { status: 409 }));
  await expect(submitUnknownAssessment(value)).rejects.toBeInstanceOf(
    AssessmentSourceRequiredError,
  );
  expect(readAssessmentJournal(localStorage, tenant, actor)).toEqual(value);
  fetchMock.mockResolvedValueOnce(
    Response.json({ error: { ...sourceRefusal(value), requestText: '{}' } }, { status: 409 }),
  );
  await expect(submitUnknownAssessment(value)).rejects.toThrow('does not match');
});
it('archives explicit definite refusal only after fresh exact404 and preserves its receipt', async () => {
  const value = retainedFixture();
  retainAssessmentJournal(localStorage, value);
  vi.mocked(fetch).mockResolvedValueOnce(
    Response.json({ error: { code: 'assessment_job_not_found' } }, { status: 404 }),
  );
  await archiveRejectedAssessmentJournal(localStorage, value, sourceRefusal(value));
  expect(readAssessmentJournal(localStorage, tenant, actor)).toBeNull();
  const archived = JSON.parse(
    localStorage.getItem(assessmentJournalKey(tenant, actor) + ':rejected:' + operation)!,
  );
  expect(archived.retained).toEqual(value);
  expect(archived.refusal).toEqual(sourceRefusal(value));
  expect(fetch).toHaveBeenCalledWith(
    `/api/bff/v1/assessment/jobs/${operation}`,
    expect.objectContaining({
      method: 'GET',
      headers: expect.objectContaining({ 'X-Expected-Actor-Id': actor }),
    }),
  );
});
it.each([200, 403, 503, 404])(
  'does not archive an unsupported request from unverified status%d',
  async (status) => {
    const value = retainedFixture();
    retainAssessmentJournal(localStorage, value);
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({ error: { code: 'unconfirmed' } }, { status }),
    );
    await expect(
      archiveRejectedAssessmentJournal(localStorage, value, sourceRefusal(value)),
    ).rejects.toThrow('absence could not be confirmed');
    expect(readAssessmentJournal(localStorage, tenant, actor)).toEqual(value);
  },
);
it('refuses forged refusal scope before any status request or local archival', async () => {
  const value = retainedFixture();
  retainAssessmentJournal(localStorage, value);
  await expect(
    archiveRejectedAssessmentJournal(localStorage, value, {
      ...sourceRefusal(value),
      actorId: tenant,
    }),
  ).rejects.toThrow('does not match');
  expect(fetch).not.toHaveBeenCalled();
  expect(readAssessmentJournal(localStorage, tenant, actor)).toEqual(value);
});
