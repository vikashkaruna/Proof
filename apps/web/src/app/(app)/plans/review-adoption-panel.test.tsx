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
