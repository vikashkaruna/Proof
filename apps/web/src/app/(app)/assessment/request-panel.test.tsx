// @vitest-environment jsdom
import React from 'react';
import { canonicalJson } from '@axiom/ledger';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { AssessmentRequestSchema } from '@axiom/types';
import { AssessmentRequestPanel } from './request-panel';
import { readAssessmentJournal, retainAssessmentJournal, assessmentJournalKey } from './request';

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
const tenant = '11111111-1111-4111-8111-111111111111';
const actor = '22222222-2222-4222-8222-222222222222';
const engagement = '33333333-3333-4333-8333-333333333333';
const operation = '44444444-4444-4444-8444-444444444444';
const run = '55555555-5555-4555-8555-555555555555';
const journal = () => ({
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
function progress(final = false) {
  return {
    jobId: operation,
    runId: run,
    engagementId: engagement,
    correlationId: operation,
    libraryVersion: '0.1.1',
    recordedRunStatus: final ? 'succeeded' : 'queued',
    schedulingStatus: 'pending',
    createdAt: '2026-10-05T11:00:00Z',
    claimedAt: final ? '2026-10-05T11:01:00Z' : null,
    allAgentEndToEndAccepted: false,
    status: final ? 'finalization_recorded' : 'unconfirmed',
    phase: final ? 'finalized' : 'queued',
    finalization: final
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
  };
}
const fetchMock = vi.fn();
const finalized = vi.fn();
const questionnaire = () => ({
  tenantId: tenant,
  engagementId: engagement,
  libraryVersion: '0.1.1',
  questionnaireDigest: 'd'.repeat(64),
  digestScope: 'ordered_questionnaire_projection_v1',
  declarationsVerified: false,
  controls: [
    {
      id: 'C',
      title: 'Governance',
      questions: [
        { id: 'Q1', prompt: 'Is a policy adopted?', type: 'boolean' },
        { id: 'Q2', prompt: 'Is a DPO appointed?', type: 'boolean' },
        { id: 'Q3', prompt: 'Supply evidence', type: 'evidence' },
      ],
    },
  ],
});
async function reviewKnownAnswers() {
  fireEvent.click(screen.getByRole('button', { name: 'Enter questionnaire declarations' }));
  const yes = await screen.findByRole('combobox', { name: 'C Q1: Is a policy adopted?' });
  fireEvent.change(yes, { target: { value: 'yes' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'C Q2: Is a DPO appointed?' }), {
    target: { value: 'no' },
  });
  fireEvent.change(screen.getByRole('combobox', { name: 'Processes children’s personal data' }), {
    target: { value: 'no' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Review questionnaire declarations' }));
}
function panel(overrides: Partial<React.ComponentProps<typeof AssessmentRequestPanel>> = {}) {
  return (
    <AssessmentRequestPanel
      tenantId={tenant}
      actorId={actor}
      engagementId={engagement}
      libraryVersion="0.1.1"
      canRequest
      hasSavedResults={false}
      onFinalized={finalized}
      {...overrides}
    />
  );
}
beforeEach(() => {
  localStorage.clear();
  fetchMock.mockReset();
  finalized.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(crypto, 'randomUUID').mockReturnValue(operation);
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: { request: vi.fn(async (_name: string, callback: () => Promise<void>) => callback()) },
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('does not enable questionnaire review or submission while published options are loading', async () => {
  let resolve: (value: Response) => void = () => {};
  fetchMock.mockReturnValue(
    new Promise<Response>((done) => {
      resolve = done;
    }),
  );
  render(panel());
  fireEvent.click(screen.getByRole('button', { name: 'Enter questionnaire declarations' }));
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Review questionnaire declarations' })).toBeNull();
  expect(
    screen.getByRole('button', { name: 'Submit reviewed questionnaire' }).hasAttribute('disabled'),
  ).toBe(true);
  expect(screen.getByRole('checkbox').hasAttribute('disabled')).toBe(true);
  resolve(Response.json(questionnaire()));
  await screen.findByRole('combobox', { name: 'C Q1: Is a policy adopted?' });
  expect(
    screen
      .getAllByRole('combobox')
      .every((element) => (element as HTMLSelectElement).value === 'unknown'),
  ).toBe(true);
  expect(screen.getByText(/Supply evidence.*remains unassessed/)).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(crypto.randomUUID).not.toHaveBeenCalled();
});
it('never interprets inherited object properties as questionnaire declarations', async () => {
  const value = questionnaire();
  value.controls[0]!.questions.push({
    id: 'constructor',
    prompt: 'Prototype-named question',
    type: 'boolean',
  });
  fetchMock
    .mockResolvedValueOnce(Response.json(value))
    .mockResolvedValueOnce(Response.json(accepted(), { status: 202 }));
  render(panel());
  fireEvent.click(screen.getByRole('button', { name: 'Enter questionnaire declarations' }));
  const selection = await screen.findByRole('combobox', {
    name: 'C constructor: Prototype-named question',
  });
  expect((selection as HTMLSelectElement).value).toBe('unknown');
  fireEvent.change(screen.getByRole('combobox', { name: 'C Q1: Is a policy adopted?' }), {
    target: { value: 'yes' },
  });
  expect((selection as HTMLSelectElement).value).toBe('unknown');
  fireEvent.click(screen.getByRole('button', { name: 'Review questionnaire declarations' }));
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Submit reviewed questionnaire' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(JSON.parse(fetchMock.mock.calls[1]![1].body).answers.C).toEqual({
    Q1: true,
    Q2: null,
    constructor: null,
  });
});
it('requires reviewed exact declarations and explicit confirmation, then retains their body before POST', async () => {
  fetchMock
    .mockResolvedValueOnce(Response.json(questionnaire()))
    .mockImplementationOnce(async (_url, init) => {
      const saved = readAssessmentJournal(localStorage, tenant, actor);
      expect(saved?.questionnaireDigest).toBe('d'.repeat(64));
      expect(saved?.request).toEqual(JSON.parse(init.body));
      return Response.json(accepted(), { status: 202 });
    });
  render(panel());
  await reviewKnownAnswers();
  expect(
    screen.getByRole('button', { name: 'Submit reviewed questionnaire' }).hasAttribute('disabled'),
  ).toBe(true);
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Submit reviewed questionnaire' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  const body = JSON.parse(fetchMock.mock.calls[1]![1].body);
  expect(body.answers).toEqual({ C: { Q1: true, Q2: false } });
  expect(body.expectedQuestionnaire).toEqual({
    libraryVersion: '0.1.1',
    questionnaireDigest: 'd'.repeat(64),
  });
  expect(body.applicability).toEqual({
    sdfSelfAttested: null,
    processesChildren: false,
    processesHealth: null,
  });
  expect(body.answers.C).not.toHaveProperty('Q3');
  expect(fetchMock.mock.calls[1]![1].headers['X-Expected-Actor-Id']).toBe(actor);
  expect(finalized).not.toHaveBeenCalled();
});
it('invalidates previous confirmation when reviewed declarations are edited before submission', async () => {
  fetchMock.mockResolvedValue(Response.json(questionnaire()));
  render(panel());
  await reviewKnownAnswers();
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Edit questionnaire declarations' }));
  fireEvent.change(screen.getByRole('combobox', { name: 'C Q1: Is a policy adopted?' }), {
    target: { value: 'no' },
  });
  expect(screen.getByRole('checkbox').hasAttribute('disabled')).toBe(true);
  expect(
    screen.getByRole('button', { name: 'Submit reviewed questionnaire' }).hasAttribute('disabled'),
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Review questionnaire declarations' }));
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  expect(readAssessmentJournal(localStorage, tenant, actor)).toBeNull();
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(crypto.randomUUID).not.toHaveBeenCalled();
});
it('recovers an interrupted known-answer submission across remount with the same body and key', async () => {
  fetchMock
    .mockResolvedValueOnce(Response.json(questionnaire()))
    .mockRejectedValueOnce(new Error('response lost'));
  const view = render(panel());
  await reviewKnownAnswers();
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Submit reviewed questionnaire' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('interrupted'));
  const submitted = fetchMock.mock.calls[1]![1];
  const saved = readAssessmentJournal(localStorage, tenant, actor);
  view.unmount();
  fetchMock.mockResolvedValueOnce(Response.json(accepted(), { status: 202 }));
  render(panel());
  expect(fetchMock).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole('button', { name: 'Retry original request' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  expect(fetchMock.mock.calls[2]![1].body).toBe(submitted.body);
  expect(fetchMock.mock.calls[2]![1].headers['Idempotency-Key']).toBe(operation);
  expect(readAssessmentJournal(localStorage, tenant, actor)).toEqual(saved);
  expect(crypto.randomUUID).toHaveBeenCalledOnce();
});
it('never POSTs reviewed declarations when browser retention is blocked', async () => {
  fetchMock.mockResolvedValue(Response.json(questionnaire()));
  render(panel());
  await reviewKnownAnswers();
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('storage blocked');
  });
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Submit reviewed questionnaire' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('storage blocked'));
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(readAssessmentJournal(localStorage, tenant, actor)).toBeNull();
});
it.each(['actor', 'tenant'])(
  'withdraws reviewed declarations and confirmation when %s changes',
  async (kind) => {
    fetchMock.mockResolvedValue(Response.json(questionnaire()));
    const view = render(panel());
    await reviewKnownAnswers();
    fireEvent.click(screen.getByRole('checkbox'));
    view.rerender(panel(kind === 'actor' ? { actorId: run } : { tenantId: run }));
    expect(screen.queryByRole('button', { name: 'Submit reviewed questionnaire' })).toBeNull();
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(crypto.randomUUID).not.toHaveBeenCalled();
  },
);
it.each(['tenant', 'engagement', 'library', 'duplicate', 'verified'])(
  'refuses mismatched questionnaire source %s before review',
  async (kind) => {
    const value = questionnaire();
    if (kind === 'tenant') value.tenantId = run;
    if (kind === 'engagement') value.engagementId = run;
    if (kind === 'library') value.libraryVersion = '0.1.0';
    if (kind === 'duplicate') value.controls.push(value.controls[0]!);
    fetchMock.mockResolvedValue(
      Response.json(kind === 'verified' ? { ...value, declarationsVerified: true } : value),
    );
    render(panel());
    fireEvent.click(screen.getByRole('button', { name: 'Enter questionnaire declarations' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('could not be verified'),
    );
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(
      screen
        .getByRole('button', { name: 'Submit reviewed questionnaire' })
        .hasAttribute('disabled'),
    ).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  },
);
it('requires explicit unknown-answer acknowledgement before a human request', async () => {
  fetchMock.mockResolvedValue(Response.json(accepted(), { status: 202 }));
  render(panel());
  const button = screen.getByRole('button', { name: 'Request unknown-answer assessment' });
  expect(button.hasAttribute('disabled')).toBe(true);
  expect(fetchMock).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(button);
  fireEvent.click(button);
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Request accepted'));
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(readAssessmentJournal(localStorage, tenant, actor)?.request.operationKey).toBe(operation);
  expect(finalized).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Archive completed browser reference' })).toBeNull();
});
it('retains before submission and keeps an interrupted outcome across remount without a second POST', async () => {
  fetchMock.mockImplementation(async () => {
    expect(readAssessmentJournal(localStorage, tenant, actor)).toEqual(journal());
    throw new Error('connection interrupted');
  });
  const view = render(panel());
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Request unknown-answer assessment' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('interrupted'));
  expect(fetchMock).toHaveBeenCalledOnce();
  view.unmount();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(Response.json(progress()));
  render(panel());
  expect(fetchMock).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Check retained request' }));
  await waitFor(() =>
    expect(screen.getByRole('status').textContent).toContain('Completion is not yet confirmed'),
  );
  expect(fetchMock.mock.calls[0]![0]).toBe(`/api/bff/v1/assessment/jobs/${operation}`);
  expect(fetchMock.mock.calls[0]![1]).not.toHaveProperty('method');
  expect(finalized).not.toHaveBeenCalled();
});
it('retries only the explicitly retained body and key, without creating another operation', async () => {
  retainAssessmentJournal(localStorage, journal());
  fetchMock.mockResolvedValue(Response.json(accepted(), { status: 202 }));
  render(panel());
  expect(fetchMock).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Retry original request' }));
  await waitFor(() =>
    expect(screen.getByRole('status').textContent).toContain('Original request accepted'),
  );
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual(journal().request);
  expect(crypto.randomUUID).not.toHaveBeenCalled();
  expect(readAssessmentJournal(localStorage, tenant, actor)).toEqual(journal());
});
it.each(['failed', 'cancelled', 'timed_out'])(
  'preserves a recorded %s request for review without offering a futile retry',
  async (recordedRunStatus) => {
    retainAssessmentJournal(localStorage, journal());
    fetchMock.mockImplementation(async () =>
      Response.json({ ...progress(), recordedRunStatus, phase: 'terminal_unconfirmed' }),
    );
    const view = render(panel());
    fireEvent.click(screen.getByRole('button', { name: 'Check retained request' }));
    await waitFor(() => expect(screen.getByRole('note').textContent).toContain('saved run is'));
    expect(screen.getByRole('note').textContent).toContain(recordedRunStatus.replaceAll('_', ' '));
    expect(screen.getByRole('note').textContent).toContain('resolution has not been confirmed');
    expect(screen.queryByRole('button', { name: 'Retry original request' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Archive|Request unknown-answer/ })).toBeNull();
    expect(readAssessmentJournal(localStorage, tenant, actor)).toEqual(journal());
    expect(finalized).not.toHaveBeenCalled();
    expect(crypto.randomUUID).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
    view.unmount();
    render(panel());
    // A remount does not silently re-submit or erase the retained reference.
    expect(fetchMock).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Check retained request' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Retry original request' })).toBeNull(),
    );
    expect(fetchMock.mock.calls.every(([, options]) => !options.method)).toBe(true);
    expect(readAssessmentJournal(localStorage, tenant, actor)).toEqual(journal());
  },
);
it.each([
  [{ schedulingStatus: 'needs_review' }, 'Dispatch requires administrator review'],
  [
    { phase: 'result_recorded', recordedRunStatus: 'running' },
    'awaits verified controller finalization',
  ],
  [
    { phase: 'terminal_unconfirmed', recordedRunStatus: 'succeeded' },
    'awaits verified controller finalization',
  ],
])(
  'withholds retry for a recorded state requiring separate resolution %j',
  async (fields, message) => {
    retainAssessmentJournal(localStorage, journal());
    fetchMock.mockResolvedValue(Response.json({ ...progress(), ...fields }));
    render(panel());
    fireEvent.click(screen.getByRole('button', { name: 'Check retained request' }));
    await waitFor(() => expect(screen.getByRole('note').textContent).toContain(message));
    expect(screen.queryByRole('button', { name: 'Retry original request' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Archive|Request unknown-answer/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Check retained request' })).toBeTruthy();
    expect(readAssessmentJournal(localStorage, tenant, actor)).toEqual(journal());
    expect(finalized).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
  },
);
it.each(['queued', 'running'])(
  'keeps exact-key recovery available for an unconfirmed %s delivery',
  async (recordedRunStatus) => {
    retainAssessmentJournal(localStorage, journal());
    fetchMock
      .mockResolvedValueOnce(
        Response.json({ ...progress(), recordedRunStatus, phase: recordedRunStatus }),
      )
      .mockResolvedValueOnce(Response.json(accepted(), { status: 202 }));
    render(panel());
    fireEvent.click(screen.getByRole('button', { name: 'Check retained request' }));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('Completion is not yet confirmed'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry original request' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1]![1].headers['Idempotency-Key']).toBe(operation);
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toEqual(journal().request);
    expect(crypto.randomUUID).not.toHaveBeenCalled();
  },
);
it('withdraws terminal review guidance when another tab replaces the retained operation', async () => {
  retainAssessmentJournal(localStorage, journal());
  fetchMock.mockResolvedValue(
    Response.json({ ...progress(), recordedRunStatus: 'failed', phase: 'terminal_unconfirmed' }),
  );
  render(panel());
  fireEvent.click(screen.getByRole('button', { name: 'Check retained request' }));
  await waitFor(() =>
    expect(screen.getByRole('note').textContent).toContain('saved run is failed'),
  );
  const replacement = { ...journal(), request: { ...journal().request, operationKey: run } };
  act(() => {
    localStorage.setItem(assessmentJournalKey(tenant, actor), JSON.stringify(replacement));
    window.dispatchEvent(new StorageEvent('storage', { key: assessmentJournalKey(tenant, actor) }));
  });
  expect(screen.queryByRole('note')).toBeNull();
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.getByRole('button', { name: 'Retry original request' })).toBeTruthy();
  expect(readAssessmentJournal(localStorage, tenant, actor)).toEqual(replacement);
  expect(fetchMock).toHaveBeenCalledOnce();
});
it('refreshes saved findings only after a matching recorded finalization; archive never removes server results', async () => {
  retainAssessmentJournal(localStorage, journal());
  fetchMock.mockResolvedValue(Response.json(progress(true)));
  render(panel());
  fireEvent.click(screen.getByRole('button', { name: 'Check retained request' }));
  await waitFor(() => expect(finalized).toHaveBeenCalledOnce());
  expect(screen.getByRole('link', { name: '#13' }).getAttribute('href')).toBe('/ledger?q=13');
  fireEvent.click(screen.getByRole('button', { name: 'Archive completed browser reference' }));
  expect(readAssessmentJournal(localStorage, tenant, actor)).toBeNull();
  expect(fetchMock).toHaveBeenCalledOnce();
});
it('keeps viewer reads free of mutation controls', () => {
  render(panel({ canRequest: false }));
  expect(screen.queryByRole('checkbox')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Request unknown-answer assessment' })).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
});
it('does not rerun an engagement with existing saved results', () => {
  render(panel({ hasSavedResults: true }));
  expect(screen.queryByRole('button', { name: 'Request unknown-answer assessment' })).toBeNull();
  expect(screen.getByText(/already has saved results/)).toBeTruthy();
});
it('blocks a new request when a sibling tab has retained another engagement', () => {
  retainAssessmentJournal(localStorage, {
    ...journal(),
    request: { ...journal().request, engagementId: run },
  });
  render(panel());
  expect(screen.queryByRole('button', { name: 'Request unknown-answer assessment' })).toBeNull();
  expect(screen.getByRole('link', { name: 'Open that assessment' }).getAttribute('href')).toBe(
    `/assessment?engagement=${run}`,
  );
  expect(fetchMock).not.toHaveBeenCalled();
});
it('rechecks sibling state inside the browser lock before retaining or submitting', async () => {
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: async (_name: string, callback: () => Promise<void>) => {
        retainAssessmentJournal(localStorage, journal());
        return callback();
      },
    },
  });
  render(panel());
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Request unknown-answer assessment' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Another tab'));
  expect(fetchMock).not.toHaveBeenCalled();
});
it('does not submit when durable browser storage fails', async () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('storage unavailable');
  });
  render(panel());
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Request unknown-answer assessment' }));
  await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
  expect(fetchMock).not.toHaveBeenCalled();
});
it('does not submit without browser tab coordination', async () => {
  Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
  render(panel());
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Request unknown-answer assessment' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('coordinate'));
  expect(fetchMock).not.toHaveBeenCalled();
  expect(readAssessmentJournal(localStorage, tenant, actor)).toBeNull();
});
it('withholds submission when a local request is corrupt instead of deleting it', () => {
  localStorage.setItem(assessmentJournalKey(tenant, actor), '{');
  render(panel());
  expect(screen.getByRole('alert').textContent).toContain('could not be verified');
  expect(
    screen
      .getByRole('button', { name: 'Request unknown-answer assessment' })
      .hasAttribute('disabled'),
  ).toBe(true);
  expect(localStorage.getItem(assessmentJournalKey(tenant, actor))).toBe('{');
  expect(fetchMock).not.toHaveBeenCalled();
});
it.each(['succeeded-without-finalization', 'foreign-job', 'all-agent-claim'])(
  'does not mark %s complete',
  async (kind) => {
    retainAssessmentJournal(localStorage, journal());
    const response =
      kind === 'succeeded-without-finalization'
        ? { ...progress(), recordedRunStatus: 'succeeded', phase: 'terminal_unconfirmed' }
        : kind === 'foreign-job'
          ? { ...progress(true), jobId: run }
          : { ...progress(true), allAgentEndToEndAccepted: true };
    fetchMock.mockResolvedValue(Response.json(response));
    render(panel());
    fireEvent.click(screen.getByRole('button', { name: 'Check retained request' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(screen.queryByRole('status') || screen.queryByRole('alert')).toBeTruthy(),
    );
    expect(finalized).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('button', { name: 'Archive completed browser reference' }),
    ).toBeNull();
  },
);
it('ignores an old submission response after the active tenant changes', async () => {
  let finish: (value: Response) => void = () => {};
  fetchMock.mockReturnValue(
    new Promise<Response>((resolve) => {
      finish = resolve;
    }),
  );
  const view = render(panel());
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Request unknown-answer assessment' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  view.rerender(panel({ tenantId: run }));
  expect(screen.getByRole('checkbox').hasAttribute('disabled')).toBe(false);
  finish(Response.json(accepted(), { status: 202 }));
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  expect(readAssessmentJournal(localStorage, tenant, actor)).toEqual(journal());
  expect(readAssessmentJournal(localStorage, run, actor)).toBeNull();
});

it('withdraws an old finalization and completion message when another tab changes the retained operation', async () => {
  retainAssessmentJournal(localStorage, journal());
  fetchMock.mockResolvedValue(Response.json(progress(true)));
  render(panel());
  fireEvent.click(screen.getByRole('button', { name: 'Check retained request' }));
  await waitFor(() => expect(screen.getByRole('link', { name: '#13' })).toBeTruthy());
  const replacement = { ...journal(), request: { ...journal().request, operationKey: run } };
  act(() => {
    localStorage.setItem(assessmentJournalKey(tenant, actor), JSON.stringify(replacement));
    window.dispatchEvent(new StorageEvent('storage', { key: assessmentJournalKey(tenant, actor) }));
  });
  expect(screen.queryByRole('link', { name: '#13' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Archive completed browser reference' })).toBeNull();
  expect(screen.queryByText(/Assessment finalization is recorded/)).toBeNull();
  expect(screen.getByRole('button', { name: 'Retry original request' })).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(readAssessmentJournal(localStorage, tenant, actor)).toEqual(replacement);
});

const cancelledResolution = () => ({
  ...progress(),
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
async function reviewCancellation() {
  fireEvent.click(screen.getByRole('button', { name: 'Check retained request' }));
  const button = await screen.findByRole('button', { name: 'Cancel if not claimed' });
  expect(button.hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('checkbox', { name: /I want to cancel this original request/ }));
  expect(button.hasAttribute('disabled')).toBe(false);
}
it('requires an explicit checked unclaimed cancellation and a separate verified read before archiving', async () => {
  retainAssessmentJournal(localStorage, journal());
  fetchMock
    .mockResolvedValueOnce(Response.json(progress()))
    .mockResolvedValueOnce(
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
    )
    .mockResolvedValueOnce(Response.json(cancelledResolution()));
  render(panel());
  expect(screen.queryByRole('button', { name: 'Cancel if not claimed' })).toBeNull();
  await reviewCancellation();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel if not claimed' }));
  await screen.findByText(/Cancellation recorded. Check the retained request/);
  expect(readAssessmentJournal(localStorage, tenant, actor)).toEqual(journal());
  expect(screen.queryByRole('button', { name: 'Archive cancelled browser reference' })).toBeNull();
  const init = fetchMock.mock.calls[1]![1];
  expect(JSON.parse(init.body)).toEqual(journal().request);
  expect(init.headers).toMatchObject({
    'Idempotency-Key': operation,
    'X-Expected-Actor-Id': actor,
  });
  fireEvent.click(screen.getByRole('button', { name: 'Check retained request' }));
  const archive = await screen.findByRole('button', {
    name: 'Archive cancelled browser reference',
  });
  expect(finalized).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Retry original request' })).toBeNull();
  fireEvent.click(archive);
  await waitFor(() => expect(readAssessmentJournal(localStorage, tenant, actor)).toBeNull());
  expect(screen.getByRole('checkbox').getAttribute('checked')).toBeNull();
  expect(crypto.randomUUID).not.toHaveBeenCalled();
});
it('lost cancellation response and remount preserve the reference without automatic POST or archive', async () => {
  retainAssessmentJournal(localStorage, journal());
  fetchMock
    .mockResolvedValueOnce(Response.json(progress()))
    .mockRejectedValueOnce(new Error('lost'));
  const mounted = render(panel());
  await reviewCancellation();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel if not claimed' }));
  await screen.findByText(/Cancellation response was interrupted/);
  expect(readAssessmentJournal(localStorage, tenant, actor)).toEqual(journal());
  mounted.unmount();
  fetchMock.mockClear();
  render(panel());
  expect(fetchMock).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Archive cancelled browser reference' })).toBeNull();
  fetchMock.mockResolvedValueOnce(Response.json(cancelledResolution()));
  fireEvent.click(screen.getByRole('button', { name: 'Check retained request' }));
  await screen.findByRole('button', { name: 'Archive cancelled browser reference' });
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(fetchMock.mock.calls[0]![1].method).toBeUndefined();
  expect(readAssessmentJournal(localStorage, tenant, actor)).toEqual(journal());
});
it('does not expose cancellation for a viewer or after a worker claim', async () => {
  retainAssessmentJournal(localStorage, journal());
  fetchMock.mockResolvedValue(Response.json({ ...progress(), claimedAt: '2026-10-05T11:01:00Z' }));
  const mounted = render(panel());
  fireEvent.click(screen.getByRole('button', { name: 'Check retained request' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  expect(screen.queryByRole('button', { name: 'Cancel if not claimed' })).toBeNull();
  mounted.unmount();
  fetchMock.mockResolvedValue(Response.json(progress()));
  render(panel({ canRequest: false }));
  fireEvent.click(screen.getByRole('button', { name: 'Check retained request' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole('button', { name: 'Cancel if not claimed' })).toBeNull();
});
it('rechecks cross-tab journal ownership before the explicit cancellation POST', async () => {
  retainAssessmentJournal(localStorage, journal());
  fetchMock.mockResolvedValue(Response.json(progress()));
  render(panel());
  await reviewCancellation();
  localStorage.setItem(
    assessmentJournalKey(tenant, actor),
    JSON.stringify({
      ...journal(),
      request: { ...journal().request, operationKey: run },
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Cancel if not claimed' }));
  await screen.findByText(/Retained request changed/);
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(readAssessmentJournal(localStorage, tenant, actor)!.request.operationKey).toBe(run);
});
it('retains original cancellation and explicit archive when the page current library pin has changed', async () => {
  retainAssessmentJournal(localStorage, journal());
  fetchMock
    .mockResolvedValueOnce(Response.json(progress()))
    .mockResolvedValueOnce(
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
    )
    .mockResolvedValueOnce(Response.json(cancelledResolution()));
  render(panel({ libraryVersion: 'current-new-version' }));
  await reviewCancellation();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel if not claimed' }));
  await screen.findByText(/Cancellation recorded. Check the retained request/);
  expect(readAssessmentJournal(localStorage, tenant, actor)!.libraryVersion).toBe('0.1.1');
  expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toEqual(journal().request);
  fireEvent.click(screen.getByRole('button', { name: 'Check retained request' }));
  fireEvent.click(
    await screen.findByRole('button', { name: 'Archive cancelled browser reference' }),
  );
  await waitFor(() => expect(readAssessmentJournal(localStorage, tenant, actor)).toBeNull());
  expect(finalized).not.toHaveBeenCalled();
  expect(crypto.randomUUID).not.toHaveBeenCalled();
});

it.each([true, false])(
  'prepares assessment safely when native UUID is absent (secure bytes=%s)',
  async (secureBytes) => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      bytes.fill(7);
      return bytes;
    });
    vi.stubGlobal('crypto', secureBytes ? { getRandomValues } : {});
    fetchMock
      .mockResolvedValueOnce(Response.json(questionnaire()))
      .mockResolvedValueOnce(Response.json(accepted(), { status: 202 }));
    render(panel());
    await reviewKnownAnswers();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Submit reviewed questionnaire' }));
    if (secureBytes) {
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      const body = JSON.parse(fetchMock.mock.calls[1]![1].body);
      expect(body.operationKey).toMatch(
        /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
      );
    } else {
      await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('not sent'));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(readAssessmentJournal(localStorage, tenant, actor)).toBeNull();
      expect(
        screen
          .getByRole('button', { name: 'Submit reviewed questionnaire' })
          .hasAttribute('disabled'),
      ).toBe(false);
    }
  },
);
it('retains an explicit review handoff before sending and reloads the same reference after an unknown outcome', async () => {
  const reviewRef = {
    reviewId: run,
    requestSha256: 'b'.repeat(64),
    snapshotSha256: 'c'.repeat(64),
  };
  fetchMock.mockRejectedValueOnce(new Error('synthetic lost response'));
  const first = render(panel({ reviewRef }));
  expect(screen.queryByRole('button', { name: 'Enter questionnaire declarations' })).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Request assessment from recorded review' }));
  await screen.findByRole('alert');
  const retained = readAssessmentJournal(localStorage, tenant, actor)!;
  expect(retained.request.reviewRef).toEqual(reviewRef);
  expect(retained.request.answers).toEqual({});
  expect(retained.request.expectedQuestionnaire).toBeUndefined();
  const originalBody = fetchMock.mock.calls[0]![1].body;
  expect(JSON.parse(originalBody).reviewRef).toEqual(reviewRef);
  first.unmount();
  fetchMock.mockResolvedValueOnce(Response.json(accepted(), { status: 202 }));
  render(panel({ reviewRef: { ...reviewRef, reviewId: engagement } }));
  fireEvent.click(await screen.findByRole('button', { name: 'Retry original request' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(fetchMock.mock.calls[1]![1].body).toBe(originalBody);
  expect(fetchMock.mock.calls[1]![1].headers['Idempotency-Key']).toBe(operation);
  expect(readAssessmentJournal(localStorage, tenant, actor)?.request.reviewRef).toEqual(reviewRef);
});
it('does not submit a review handoff without request capability', async () => {
  const reviewRef = {
    reviewId: run,
    requestSha256: 'b'.repeat(64),
    snapshotSha256: 'c'.repeat(64),
  };
  render(panel({ reviewRef, canRequest: false }));
  expect(
    screen.queryByRole('button', { name: 'Request assessment from recorded review' }),
  ).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
});

it('sends zero review-bound requests if the exact reference cannot be retained', async () => {
  const reviewRef = {
    reviewId: run,
    requestSha256: 'b'.repeat(64),
    snapshotSha256: 'c'.repeat(64),
  };
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('storage unavailable');
  });
  render(panel({ reviewRef }));
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Request assessment from recorded review' }));
  await screen.findByRole('alert');
  expect(fetchMock).not.toHaveBeenCalled();
});
it('blocks only new submission when explicitly unconfigured and keeps source recovery available', async () => {
  const reviewRef = {
    reviewId: run,
    requestSha256: 'b'.repeat(64),
    snapshotSha256: 'c'.repeat(64),
  };
  const view = render(panel({ reviewRef, configuration: 'unconfigured' }));
  fireEvent.click(screen.getByRole('checkbox'));
  const start = screen.getByRole('button', { name: 'Request assessment from recorded review' });
  expect(start).toHaveProperty('disabled', true);
  fireEvent.click(start);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(screen.getByText(/Assessment requests are not configured/)).toBeTruthy();
  view.unmount();
  retainAssessmentJournal(localStorage, {
    ...journal(),
    request: AssessmentRequestSchema.parse({ ...journal().request, reviewRef }),
  });
  render(panel({ reviewRef, configuration: 'unconfigured' }));
  expect(screen.getByRole('button', { name: 'Check retained request' })).toHaveProperty(
    'disabled',
    false,
  );
  expect(screen.getByRole('button', { name: 'Reconcile source request outcome' })).toHaveProperty(
    'disabled',
    false,
  );
  expect(screen.getByRole('button', { name: 'Retry original request' })).toHaveProperty(
    'disabled',
    false,
  );
});
it('clears an undispatched source journal only after matching positive cancellation and never dispatches automatically', async () => {
  const reviewRef = {
    reviewId: run,
    requestSha256: 'b'.repeat(64),
    snapshotSha256: 'c'.repeat(64),
  };
  const value = {
    ...journal(),
    request: AssessmentRequestSchema.parse({ ...journal().request, reviewRef }),
  };
  retainAssessmentJournal(localStorage, value);
  const { canonicalJson } = await import('@axiom/ledger');
  const reason = 'I no longer want this original source request.';
  const request_text = canonicalJson(value.request),
    request_sha256 = 'd'.repeat(64);
  const row = {
    id: run,
    tenant_id: tenant,
    actor_id: actor,
    job_id: operation,
    engagement_id: engagement,
    request_text,
    request_sha256,
    reason,
    cancellation_text: canonicalJson({
      version: 1,
      tenantId: tenant,
      actorId: actor,
      jobId: operation,
      engagementId: engagement,
      requestSha256: request_sha256,
      reason,
    }),
    cancellation_sha256: 'e'.repeat(64),
    receipt_id: '77',
    created_at: '2026-10-16T00:00:00Z',
  };
  fetchMock
    .mockResolvedValueOnce(Response.json({ data: { state: 'not_found' } }))
    .mockResolvedValueOnce(Response.json({ data: { state: 'cancelled', data: row } }));
  render(panel({ reviewRef, configuration: 'unconfigured' }));
  fireEvent.click(screen.getByRole('button', { name: 'Reconcile source request outcome' }));
  await screen.findByText(/No positive outcome is recorded/);
  expect(readAssessmentJournal(localStorage, tenant, actor)).toEqual(value);
  fireEvent.change(screen.getByLabelText('Source intent cancellation reason'), {
    target: { value: reason },
  });
  fireEvent.click(
    screen.getByRole('checkbox', { name: /I explicitly abandon this exact source request/ }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Cancel unrecorded source intent' }));
  await waitFor(() => expect(readAssessmentJournal(localStorage, tenant, actor)).toBeNull());
  expect(fetchMock.mock.calls[0]![1].method).toBe('GET');
  expect(fetchMock.mock.calls[1]![0]).toContain('/cancel-source-intent');
  expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toEqual({ request: value.request, reason });
  expect(screen.getByText(/cancellation is recorded with receipt 77/)).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
it('keeps the execution monitor journal when source cancellation finds an already-recorded pending job', async () => {
  const reviewRef = {
    reviewId: run,
    requestSha256: 'b'.repeat(64),
    snapshotSha256: 'c'.repeat(64),
  };
  const value = {
    ...journal(),
    request: AssessmentRequestSchema.parse({ ...journal().request, reviewRef }),
  };
  retainAssessmentJournal(localStorage, value);
  fetchMock.mockResolvedValueOnce(
    Response.json({
      data: { state: 'recorded', jobId: operation, runId: run, expiresAt: '2026-10-16T01:00:00Z' },
    }),
  );
  render(panel({ reviewRef }));
  fireEvent.change(screen.getByLabelText('Source intent cancellation reason'), {
    target: { value: 'Abandon only if not dispatched.' },
  });
  fireEvent.click(
    screen.getByRole('checkbox', { name: /I explicitly abandon this exact source request/ }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Cancel unrecorded source intent' }));
  await screen.findByText(/already has a recorded assessment job/);
  expect(readAssessmentJournal(localStorage, tenant, actor)).toEqual(value);
  expect(screen.getByRole('button', { name: 'Check retained request' })).toBeTruthy();
  expect(
    screen.queryByRole('button', { name: 'Request assessment from recorded review' }),
  ).toBeNull();
  expect(screen.queryByText(/Assessment finalization is recorded/)).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
it.each(['operation', 'reviewRef'] as const)(
  'does not transfer source cancellation confirmation after another tab changes %s',
  async (changed) => {
    const reviewRef = {
      reviewId: run,
      requestSha256: 'b'.repeat(64),
      snapshotSha256: 'c'.repeat(64),
    };
    const first = {
      ...journal(),
      request: AssessmentRequestSchema.parse({ ...journal().request, reviewRef }),
    };
    retainAssessmentJournal(localStorage, first);
    render(panel({ reviewRef }));
    fireEvent.change(screen.getByLabelText('Source intent cancellation reason'), {
      target: { value: 'Cancel only operation A.' },
    });
    fireEvent.click(
      screen.getByRole('checkbox', { name: /I explicitly abandon this exact source request/ }),
    );
    expect(screen.getByRole('button', { name: 'Cancel unrecorded source intent' })).toHaveProperty(
      'disabled',
      false,
    );
    const second = {
      ...first,
      request: {
        ...first.request,
        ...(changed === 'operation'
          ? { operationKey: run }
          : { reviewRef: { ...reviewRef, snapshotSha256: 'd'.repeat(64) } }),
      },
    };
    await act(async () => {
      localStorage.removeItem(assessmentJournalKey(tenant, actor));
      window.dispatchEvent(
        new StorageEvent('storage', { key: assessmentJournalKey(tenant, actor) }),
      );
      localStorage.setItem(assessmentJournalKey(tenant, actor), JSON.stringify(second));
      window.dispatchEvent(
        new StorageEvent('storage', { key: assessmentJournalKey(tenant, actor) }),
      );
    });
    expect(screen.getByLabelText('Source intent cancellation reason')).toHaveProperty('value', '');
    expect(
      screen.getByRole('checkbox', { name: /I explicitly abandon this exact source request/ }),
    ).toHaveProperty('checked', false);
    const cancel = screen.getByRole('button', { name: 'Cancel unrecorded source intent' });
    expect(cancel).toHaveProperty('disabled', true);
    fireEvent.click(cancel);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readAssessmentJournal(localStorage, tenant, actor)).toEqual(second);
    fetchMock.mockResolvedValueOnce(
      Response.json({
        data: {
          state: 'recorded',
          jobId: second.request.operationKey,
          runId: run,
          expiresAt: '2026-10-16T01:00:00Z',
        },
      }),
    );
    fireEvent.change(screen.getByLabelText('Source intent cancellation reason'), {
      target: { value: 'Fresh confirmation for operation B.' },
    });
    fireEvent.click(
      screen.getByRole('checkbox', { name: /I explicitly abandon this exact source request/ }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel unrecorded source intent' }));
    await screen.findByText(/already has a recorded assessment job/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).request).toEqual(second.request);
  },
);

it('requires saved public source review before a new local request is journaled or submitted', () => {
  render(
    panel({ configuration: 'configured', sourceRequirement: 'public_control_review_required' }),
  );
  expect(
    screen.getByRole('link', { name: 'Open Discovery and review the source' }).getAttribute('href'),
  ).toBe('/discovery');
  expect(screen.queryByRole('checkbox')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Request unknown-answer assessment' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Enter questionnaire declarations' })).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(readAssessmentJournal(localStorage, tenant, actor)).toBeNull();
  expect(crypto.randomUUID).not.toHaveBeenCalled();
});
it('keeps unsupported retained intent until exact server refusal and explicit checked archive', async () => {
  const saved = journal();
  retainAssessmentJournal(localStorage, saved);
  const refusal = {
    code: 'assessment_public_control_review_required',
    tenantId: tenant,
    actorId: actor,
    engagementId: engagement,
    operationKey: operation,
    requestText: canonicalJson(saved.request),
    sourceRequirement: 'public_control_review_required',
    dispatchState: 'not_recorded',
  };
  fetchMock.mockResolvedValueOnce(Response.json({ error: refusal }, { status: 409 }));
  render(
    panel({ configuration: 'configured', sourceRequirement: 'public_control_review_required' }),
  );
  expect(screen.queryByRole('button', { name: 'Archive rejected browser reference' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Verify original request admission' }));
  const archive = await screen.findByRole('button', { name: 'Archive rejected browser reference' });
  expect(readAssessmentJournal(localStorage, tenant, actor)).toEqual(saved);
  fetchMock.mockResolvedValueOnce(
    Response.json({ error: { code: 'assessment_job_not_found' } }, { status: 404 }),
  );
  fireEvent.click(archive);
  await waitFor(() => expect(readAssessmentJournal(localStorage, tenant, actor)).toBeNull());
  expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual(saved.request);
  expect(crypto.randomUUID).not.toHaveBeenCalled();
  expect(
    localStorage.getItem(assessmentJournalKey(tenant, actor) + ':rejected:' + operation),
  ).toContain('not_recorded');
});
