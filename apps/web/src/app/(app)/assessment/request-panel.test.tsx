// @vitest-environment jsdom
import React from 'react';
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
