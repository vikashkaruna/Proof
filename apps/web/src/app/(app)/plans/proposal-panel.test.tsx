// @vitest-environment jsdom
import React from 'react';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sudhaarInputSchema, sudhaarProposalSchema } from '@axiom/types';
import { ProposalPanel } from './proposal-panel';
import { proposalJournalKey, readProposalJournal, retainProposalJournal } from './proposal-request';
const fixture = JSON.parse(
  readFileSync(resolve(process.cwd(), '../../tests/contracts/sudhaar-source.v1.json'), 'utf8'),
);
const input = sudhaarInputSchema.parse(fixture.input),
  proposal = sudhaarProposalSchema.parse(fixture.expectedOutput);
const tenant = input.tenant_id,
  actor = '77777777-7777-4777-8777-777777777777',
  key = '88888888-8888-4888-8888-888888888888';
const retained = () => ({
  version: 1 as const,
  tenantId: tenant,
  actorId: actor,
  input,
  request: {
    operationKey: key,
    engagementId: input.engagement_id,
    assessmentRunId: input.source.assessmentRunId,
    title: input.title,
  },
});
const choices = {
  assessments: [
    {
      engagementTitle: 'Synthetic engagement',
      finalizedAt: '2026-10-08T00:00:00Z',
      assessmentRunId: input.source.assessmentRunId,
      engagementId: input.engagement_id,
      libraryVersion: input.source.libraryVersion,
    },
  ],
  total: 1,
  runtimeAvailable: true,
};
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const props = { tenantId: tenant, actorId: actor, canPropose: true };
beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: { request: vi.fn(async (_key, callback) => callback()) },
  });
  fetchMock = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).includes('assessment-options')) return response(choices);
    if (String(url).includes('assessment-source')) return response({ input });
    const request = JSON.parse(String(init?.body));
    return response({
      data: { ...proposal, title: request.title },
      invocation: {
        runId: '99999999-9999-4999-8999-999999999999',
        correlationId: request.operationKey,
        requestHash: 'a'.repeat(64),
        responseHash: 'b'.repeat(64),
      },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
async function choose() {
  await screen.findByRole('option', { name: /Synthetic engagement/ });
  fireEvent.change(screen.getByLabelText('Finalized assessment'), {
    target: { value: input.source.assessmentRunId },
  });
}
it('waits for actual source choices and sends only explicit ID/key/title body', async () => {
  let release!: (r: Response) => void;
  fetchMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  render(<ProposalPanel {...props} />);
  expect(
    screen.getByRole('button', { name: 'Request review proposal' }).hasAttribute('disabled'),
  ).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await act(async () => release(response(choices)));
  await choose();
  fireEvent.click(screen.getByRole('button', { name: 'Request review proposal' }));
  await screen.findByLabelText('Review proposal');
  const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!;
  expect(Object.keys(JSON.parse(String(post[1]?.body))).sort()).toEqual([
    'assessmentRunId',
    'engagementId',
    'operationKey',
    'title',
  ]);
  expect(post[1]?.headers).toMatchObject({ 'X-Expected-Actor-Id': actor, 'X-Tenant-Id': tenant });
  expect(screen.getByText(/46 review tasks/)).toBeDefined();
  expect(screen.getByText(/Not saved as a plan/)).toBeDefined();
  expect(readProposalJournal(localStorage, tenant, actor)).not.toBeNull();
});
it('retains interrupted request and explicitly retries the exact body and key', async () => {
  fetchMock.mockImplementation(async (url, init) => {
    if (init?.method === 'POST') throw new Error('network interruption');
    return String(url).includes('assessment-options') ? response(choices) : response({ input });
  });
  render(<ProposalPanel {...props} />);
  await choose();
  fireEvent.click(screen.getByRole('button', { name: 'Request review proposal' }));
  await screen.findByRole('alert');
  const old = readProposalJournal(localStorage, tenant, actor);
  expect(old).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Check using the same request' }));
  await waitFor(() =>
    expect(fetchMock.mock.calls.filter(([, i]) => i?.method === 'POST')).toHaveLength(2),
  );
  const posts = fetchMock.mock.calls.filter(([, i]) => i?.method === 'POST');
  expect(posts[0]![1]?.body).toEqual(posts[1]![1]?.body);
  expect(readProposalJournal(localStorage, tenant, actor)).toEqual(old);
});
it('does not auto-submit a retained request on mount', async () => {
  retainProposalJournal(localStorage, retained());
  render(<ProposalPanel {...props} />);
  await screen.findByRole('button', { name: 'Check using the same request' });
  expect(fetchMock.mock.calls.some(([, i]) => i?.method === 'POST')).toBe(false);
});
it('preserves malformed journals and prevents dispatch', async () => {
  localStorage.setItem(proposalJournalKey(tenant, actor), '{');
  render(<ProposalPanel {...props} />);
  await screen.findByRole('alert');
  expect(fetchMock.mock.calls.some(([, i]) => i?.method === 'POST')).toBe(false);
  expect(localStorage.getItem(proposalJournalKey(tenant, actor))).toBe('{');
});
it('viewer sees no proposal controls and fetches nothing', () => {
  render(<ProposalPanel {...props} canPropose={false} />);
  expect(screen.queryByRole('button')).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
});
it('configuration absence is unavailable, not an empty success', async () => {
  fetchMock.mockResolvedValueOnce(response({ ...choices, runtimeAvailable: false }));
  render(<ProposalPanel {...props} />);
  await screen.findByText(/administrator must configure/);
  expect(
    screen.getByRole('button', { name: 'Request review proposal' }).hasAttribute('disabled'),
  ).toBe(true);
});
it('stale source refuses before retaining or dispatching', async () => {
  fetchMock.mockImplementation(async (url) =>
    String(url).includes('assessment-options')
      ? response(choices)
      : response({ error: { code: 'planning_source_unavailable' } }, 503),
  );
  render(<ProposalPanel {...props} />);
  await choose();
  fireEvent.click(screen.getByRole('button', { name: 'Request review proposal' }));
  await screen.findByRole('alert');
  expect(readProposalJournal(localStorage, tenant, actor)).toBeNull();
  expect(fetchMock.mock.calls.some(([, i]) => i?.method === 'POST')).toBe(false);
});
it('sibling tab wins journal fence before any source read or POST', async () => {
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: vi.fn(async (_key, callback) => {
        retainProposalJournal(localStorage, retained());
        return callback();
      }),
    },
  });
  render(<ProposalPanel {...props} />);
  await choose();
  fireEvent.click(screen.getByRole('button', { name: 'Request review proposal' }));
  await screen.findByRole('alert');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(readProposalJournal(localStorage, tenant, actor)).toEqual(retained());
});
it('membership switch drops pending response and does not write a journal in the old session', async () => {
  let release!: (r: Response) => void;
  fetchMock.mockImplementation(async (url) =>
    String(url).includes('assessment-options')
      ? response(choices)
      : new Promise((resolve) => {
          release = resolve;
        }),
  );
  const view = render(<ProposalPanel {...props} />);
  await choose();
  fireEvent.click(screen.getByRole('button', { name: 'Request review proposal' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  view.rerender(<ProposalPanel {...props} actorId="66666666-6666-4666-8666-666666666666" />);
  await act(async () => release(response({ input })));
  expect(readProposalJournal(localStorage, tenant, actor)).toBeNull();
  expect(fetchMock.mock.calls.some(([, i]) => i?.method === 'POST')).toBe(false);
});
it('source-substituted output is never displayed and journal stays retained', async () => {
  retainProposalJournal(localStorage, retained());
  fetchMock.mockImplementation(async (_url, init) =>
    init?.method === 'POST'
      ? response({
          data: { ...proposal, source: { ...proposal.source, resultDigest: 'c'.repeat(64) } },
          invocation: {
            runId: '99999999-9999-4999-8999-999999999999',
            correlationId: key,
            requestHash: 'a'.repeat(64),
            responseHash: 'b'.repeat(64),
          },
        })
      : response(choices),
  );
  render(<ProposalPanel {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Check using the same request' }));
  await screen.findByRole('alert');
  expect(screen.queryByLabelText('Review proposal')).toBeNull();
  expect(readProposalJournal(localStorage, tenant, actor)).toEqual(retained());
});
it('foreign selected source is refused before journal or POST', async () => {
  fetchMock.mockImplementation(async (url) =>
    String(url).includes('assessment-options')
      ? response(choices)
      : response({ input: { ...input, tenant_id: actor } }),
  );
  render(<ProposalPanel {...props} />);
  await choose();
  fireEvent.click(screen.getByRole('button', { name: 'Request review proposal' }));
  await screen.findByRole('alert');
  expect(readProposalJournal(localStorage, tenant, actor)).toBeNull();
  expect(fetchMock.mock.calls.some(([, i]) => i?.method === 'POST')).toBe(false);
});
it('does not display a response after a sibling replaces its journal', async () => {
  retainProposalJournal(localStorage, retained());
  let release!: (r: Response) => void;
  fetchMock.mockImplementation(async (_url, init) =>
    init?.method === 'POST'
      ? new Promise((resolve) => {
          release = resolve;
        })
      : response(choices),
  );
  render(<ProposalPanel {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Check using the same request' }));
  await waitFor(() =>
    expect(fetchMock.mock.calls.some(([, i]) => i?.method === 'POST')).toBe(true),
  );
  const other = { ...retained(), request: { ...retained().request, operationKey: actor } };
  localStorage.setItem(proposalJournalKey(tenant, actor), JSON.stringify(other));
  await act(async () =>
    release(
      response({
        data: proposal,
        invocation: {
          runId: '99999999-9999-4999-8999-999999999999',
          correlationId: key,
          requestHash: 'a'.repeat(64),
          responseHash: 'b'.repeat(64),
        },
      }),
    ),
  );
  expect(screen.queryByLabelText('Review proposal')).toBeNull();
  expect(readProposalJournal(localStorage, tenant, actor)).toEqual(other);
});
it('requires cross-tab locking before source read or proposal dispatch', async () => {
  Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
  render(<ProposalPanel {...props} />);
  await choose();
  fireEvent.click(screen.getByRole('button', { name: 'Request review proposal' }));
  await screen.findByRole('alert');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(readProposalJournal(localStorage, tenant, actor)).toBeNull();
});
