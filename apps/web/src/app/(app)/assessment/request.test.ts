// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { AssessmentRequestSchema } from '@axiom/types';
import {
  readAssessmentJournal,
  retainAssessmentJournal,
  clearFinalizedAssessmentJournal,
  assessmentJournalKey,
  submitUnknownAssessment,
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
