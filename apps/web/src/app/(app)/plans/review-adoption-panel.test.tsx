// @vitest-environment jsdom
import React from 'react';
import { it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ReviewAdoptionPanel } from './review-adoption-panel';
import { retainReviewAdoptionJournal, readReviewAdoptionJournal } from './review-adoption-request';
import type { ConfirmedProposal } from './proposal-request';
const fixture = JSON.parse(
  readFileSync(resolve(process.cwd(), '../../tests/contracts/sudhaar-source.v1.json'), 'utf8'),
);
const tenant = fixture.input.tenant_id,
  actor = '77777777-7777-4777-8777-777777777777',
  operation = '88888888-8888-4888-8888-888888888888';
const confirmed = {
  proposal: fixture.expectedOutput,
  invocation: {
    runId: operation,
    correlationId: operation,
    requestHash: 'a'.repeat(64),
    responseHash: 'b'.repeat(64),
  },
  outputProof: {
    kind: 'settled_output_recorded',
    tenantId: tenant,
    actorId: actor,
    operationKey: operation,
    runId: operation,
    requestHash: 'a'.repeat(64),
    responseHash: 'b'.repeat(64),
    requestedReceipt: '1',
    startedReceipt: '2',
    completedReceipt: '3',
    settledReceipt: '4',
  },
} as ConfirmedProposal;
const fetcher = vi.fn();
beforeEach(() => {
  localStorage.clear();
  fetcher.mockReset();
  fetcher.mockRejectedValue(new Error('transport lost'));
  vi.stubGlobal('fetch', fetcher);
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: async (_k: string, _o: unknown, fn: (v: unknown) => Promise<unknown>) => fn({}),
    },
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function panel() {
  return render(
    <ReviewAdoptionPanel
      tenantId={tenant}
      actorId={actor}
      operationKey={operation}
      confirmed={confirmed}
    />,
  );
}
function fill() {
  fireEvent.change(screen.getByLabelText('Reason for saving this review'), {
    target: { value: 'Review declarations with supporting evidence' },
  });
  fireEvent.click(screen.getByLabelText(/I understand these/));
}
it('requires deliberate reason/ack and never posts on mount', () => {
  panel();
  expect(fetcher).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Save review tasks' }).hasAttribute('disabled')).toBe(
    true,
  );
  fill();
  expect(screen.getByRole('button', { name: 'Save review tasks' }).hasAttribute('disabled')).toBe(
    false,
  );
});
it('lost response retains the original body and key for a deliberate retry', async () => {
  panel();
  fill();
  fireEvent.click(screen.getByRole('button', { name: 'Save review tasks' }));
  await screen.findByRole('alert');
  const first = readReviewAdoptionJournal(localStorage, tenant, actor);
  expect(first).not.toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Retry retained review request' }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  expect(fetcher.mock.calls[1]![1].body).toEqual(fetcher.mock.calls[0]![1].body);
  expect(readReviewAdoptionJournal(localStorage, tenant, actor)).toEqual(first);
});
it('silent storage loss refuses dispatch', async () => {
  panel();
  fill();
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {});
  fireEvent.click(screen.getByRole('button', { name: 'Save review tasks' }));
  await screen.findByRole('alert');
  expect(fetcher).not.toHaveBeenCalled();
});
it('conflicting cross-tab pending proposal cannot be submitted here', async () => {
  panel();
  retainReviewAdoptionJournal(localStorage, {
    version: 1,
    tenantId: tenant,
    actorId: actor,
    proposalOperationKey: actor,
    request: {
      adoptionKey: actor,
      acknowledgeReviewOnly: true,
      reason: 'Review different proposal with supporting evidence',
    },
  });
  await waitFor(() =>
    expect(
      screen
        .getByRole('button', { name: 'Retry retained review request' })
        .hasAttribute('disabled'),
    ).toBe(true),
  );
  expect(fetcher).not.toHaveBeenCalled();
});
it('missing cross-tab protection refuses before journal or dispatch', async () => {
  Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
  panel();
  fill();
  fireEvent.click(screen.getByRole('button', { name: 'Save review tasks' }));
  await screen.findByRole('alert');
  expect(fetcher).not.toHaveBeenCalled();
  expect(readReviewAdoptionJournal(localStorage, tenant, actor)).toBeNull();
});

it('an actor switch while submitting cannot attach the old response to the new session', async () => {
  let finish!: (response: unknown) => void;
  fetcher.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = panel();
  fill();
  fireEvent.click(screen.getByRole('button', { name: 'Save review tasks' }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  const original = readReviewAdoptionJournal(localStorage, tenant, actor);
  view.rerender(
    <ReviewAdoptionPanel
      tenantId={tenant}
      actorId={tenant}
      operationKey={operation}
      confirmed={confirmed}
    />,
  );
  finish({ status: 201, json: async () => ({}) });
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Save review tasks' })).toBeTruthy(),
  );
  expect(screen.queryByText(/Inspect saved review work/)).toBeNull();
  expect(readReviewAdoptionJournal(localStorage, tenant, actor)).toEqual(original);
  expect(readReviewAdoptionJournal(localStorage, tenant, tenant)).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

async function successfulSave() {
  const { canonicalJson, sha256 } = await import('@axiom/ledger');
  fetcher.mockImplementation(async (_url, options) => {
    const request = JSON.parse(options.body);
    return {
      status: 201,
      json: async () => ({
        tenantId: tenant,
        actorId: actor,
        proposalOperationKey: operation,
        adoptionKey: request.adoptionKey,
        planId: operation,
        requestHash: await sha256(
          canonicalJson({
            tenantId: tenant,
            actorId: actor,
            proposalOperationKey: operation,
            ...request,
          }),
        ),
        adoptionReceipt: '5',
        purpose: 'source_review',
        status: 'review',
        taskCount: confirmed.proposal.review_tasks.length,
        actionCount: 0,
        executionAllowed: false,
        source: confirmed.proposal.source,
        outputProof: {
          runId: operation,
          inputHash: 'a'.repeat(64),
          outputHash: 'b'.repeat(64),
          requestedReceipt: '1',
          startedReceipt: '2',
          completedReceipt: '3',
          settledReceipt: '4',
        },
      }),
    };
  });
  const view = panel();
  fill();
  fireEvent.click(screen.getByRole('button', { name: 'Save review tasks' }));
  await screen.findByText('Inspect saved review work');
  return view;
}
it('explicit confirmed archive frees pending slot, preserves same-key manual recovery, and permits another proposal', async () => {
  const view = await successfulSave();
  const original = readReviewAdoptionJournal(localStorage, tenant, actor);
  fireEvent.click(screen.getByRole('button', { name: /Archive confirmed request/ }));
  await waitFor(() => expect(readReviewAdoptionJournal(localStorage, tenant, actor)).toBeNull());
  view.unmount();
  const reopened = panel();
  expect(fetcher).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole('button', { name: 'Check saved review work' }));
  await screen.findByText('Inspect saved review work');
  expect(fetcher.mock.calls[2]![1].body).toEqual(JSON.stringify(original!.request));
  fireEvent.click(screen.getByRole('button', { name: /Archive confirmed request/ }));
  await waitFor(() => expect(readReviewAdoptionJournal(localStorage, tenant, actor)).toBeNull());
  reopened.rerender(
    <ReviewAdoptionPanel
      tenantId={tenant}
      actorId={actor}
      operationKey={actor}
      confirmed={confirmed}
    />,
  );
  expect(screen.getByRole('button', { name: 'Save review tasks' })).toBeTruthy();
  expect(fetcher).toHaveBeenCalledTimes(4);
});
it('silent completed-reference write loss preserves pending request', async () => {
  await successfulSave();
  const original = readReviewAdoptionJournal(localStorage, tenant, actor);
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {});
  fireEvent.click(screen.getByRole('button', { name: /Archive confirmed request/ }));
  await waitFor(() =>
    expect(
      screen.queryByRole('button', { name: /Archive confirmed request/ })?.hasAttribute('disabled'),
    ).not.toBe(true),
  );
  expect(readReviewAdoptionJournal(localStorage, tenant, actor)).toEqual(original);
  await screen.findByRole('alert');
});
it('silent archive removal loss preserves pending request', async () => {
  await successfulSave();
  const original = readReviewAdoptionJournal(localStorage, tenant, actor);
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {});
  fireEvent.click(screen.getByRole('button', { name: /Archive confirmed request/ }));
  await waitFor(() =>
    expect(
      screen.queryByRole('button', { name: /Archive confirmed request/ })?.hasAttribute('disabled'),
    ).not.toBe(true),
  );
  expect(readReviewAdoptionJournal(localStorage, tenant, actor)).toEqual(original);
  await screen.findByRole('alert');
});
it('another tab replacing the body cannot be archived with an earlier valid receipt', async () => {
  await successfulSave();
  const original = readReviewAdoptionJournal(localStorage, tenant, actor)!;
  localStorage.setItem(
    `axiom:review-adoption:v1:${tenant}:${actor}`,
    JSON.stringify({
      ...original,
      request: { ...original.request, reason: 'Different changed body for another review' },
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: /Archive confirmed request/ }));
  await screen.findByRole('alert');
  expect(readReviewAdoptionJournal(localStorage, tenant, actor)!.request.reason).toContain(
    'Different',
  );
});

it('an actor switch while waiting for the archive lock preserves the old pending request', async () => {
  const view = await successfulSave();
  const original = readReviewAdoptionJournal(localStorage, tenant, actor);
  let release!: () => Promise<unknown>;
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: (_key: string, _options: unknown, callback: (lock: unknown) => Promise<unknown>) =>
        new Promise<void>((resolve) => {
          release = async () => {
            await callback({});
            resolve();
          };
        }),
    },
  });
  fireEvent.click(screen.getByRole('button', { name: /Archive confirmed request/ }));
  view.rerender(
    <ReviewAdoptionPanel
      tenantId={tenant}
      actorId={tenant}
      operationKey={operation}
      confirmed={confirmed}
    />,
  );
  await release();
  expect(readReviewAdoptionJournal(localStorage, tenant, actor)).toEqual(original);
  expect(screen.queryByText('Inspect saved review work')).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('archive renews the same original request before clearing pending state', async () => {
  await successfulSave();
  const original = readReviewAdoptionJournal(localStorage, tenant, actor)!;
  fireEvent.click(screen.getByRole('button', { name: /Archive confirmed request/ }));
  await waitFor(() => expect(readReviewAdoptionJournal(localStorage, tenant, actor)).toBeNull());
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[1]![1].body).toBe(JSON.stringify(original.request));
  expect(fetcher.mock.calls[1]![1].headers['Idempotency-Key']).toBe(original.request.adoptionKey);
});
it.each([403, 409, 423, 503])(
  'archive retains original request after renewed server refusal %s',
  async (status) => {
    await successfulSave();
    const original = readReviewAdoptionJournal(localStorage, tenant, actor);
    fetcher.mockResolvedValue({ status, json: async () => ({}) });
    fireEvent.click(screen.getByRole('button', { name: /Archive confirmed request/ }));
    await screen.findByRole('alert');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(readReviewAdoptionJournal(localStorage, tenant, actor)).toEqual(original);
  },
);
it('archive refuses a changed renewed receipt even when source proof matches', async () => {
  await successfulSave();
  const original = readReviewAdoptionJournal(localStorage, tenant, actor);
  const successful = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (...args) => {
    const response = await successful(...args);
    return { ...response, json: async () => ({ ...(await response.json()), planId: actor }) };
  });
  fireEvent.click(screen.getByRole('button', { name: /Archive confirmed request/ }));
  await screen.findByRole('alert');
  expect(readReviewAdoptionJournal(localStorage, tenant, actor)).toEqual(original);
});
it('archive retains a journal replaced while the renewed response was in flight', async () => {
  await successfulSave();
  const original = readReviewAdoptionJournal(localStorage, tenant, actor)!;
  const successful = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (...args) => {
    const response = await successful(...args);
    localStorage.setItem(
      `axiom:review-adoption:v1:${tenant}:${actor}`,
      JSON.stringify({
        ...original,
        request: { ...original.request, reason: 'Changed request during renewed source check' },
      }),
    );
    return response;
  });
  fireEvent.click(screen.getByRole('button', { name: /Archive confirmed request/ }));
  await screen.findByRole('alert');
  expect(readReviewAdoptionJournal(localStorage, tenant, actor)!.request.reason).toContain(
    'Changed request',
  );
});

it('a lost renewed archive response preserves the original pending request', async () => {
  await successfulSave();
  const original = readReviewAdoptionJournal(localStorage, tenant, actor);
  fetcher.mockRejectedValue(new Error('renewed response lost'));
  fireEvent.click(screen.getByRole('button', { name: /Archive confirmed request/ }));
  await screen.findByRole('alert');
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(readReviewAdoptionJournal(localStorage, tenant, actor)).toEqual(original);
});
