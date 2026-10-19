// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { canonicalJson } from '@axiom/ledger';
import { requestDraft } from './draft-transport';
import { AccountedDraftClient } from './draft-client';
import { intentKey, retainDraftRequest, readDraftJournal } from './draft-journal';
vi.mock('./draft-transport', () => ({ requestDraft: vi.fn() }));
vi.mock('./draft-view', () => ({ parseRecordedDraft: vi.fn((raw) => raw) }));
const tenant = '11111111-1111-4111-8111-111111111111';
const original = {
  version: 1 as const,
  kind: 'request' as const,
  tenantId: tenant,
  actorId: tenant,
  reviewedRequestText: canonicalJson({
    operationKey: '22222222-2222-4222-8222-222222222222',
    engagementId: tenant,
    assessmentRunId: tenant,
    expectedSourceSha256: 'a'.repeat(64),
    sourceReviewed: true,
  }),
};
const unpublished = {
  outcome: 'unpublished',
  journal: {
    state: 'unpublished',
    response_output_sha256: 'b'.repeat(64),
    output: { sections: [] },
  },
};
beforeEach(() => {
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: { request: vi.fn(async (_key, _options, run) => run()) },
  });
  vi.mocked(requestDraft).mockImplementation(async (_t, _a, path) => {
    if (path.endsWith('/configuration')) return { data: { enabled: true } };
    if (path.includes('/assessment-options')) return { assessments: [] };
    return { data: unpublished };
  });
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});
it('shows disabled controller without generation controls', async () => {
  vi.mocked(requestDraft).mockResolvedValue({ data: { enabled: false } });
  render(<AccountedDraftClient tenantId={tenant} actorId={tenant} />);
  expect(await screen.findByText(/dedicated draft controller is not configured/i)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /generate/i })).toBeNull();
});
it('retains the exact review decision through a lost reply and reload', async () => {
  retainDraftRequest(localStorage, original);
  const calls: unknown[] = [];
  vi.mocked(requestDraft).mockImplementation(async (_t, _a, path, body) => {
    if (path.endsWith('/configuration')) return { data: { enabled: true } };
    if (path.includes('/assessment-options')) return { assessments: [] };
    if (path.endsWith('/review')) {
      calls.push(body);
      throw new Error('Review reply lost');
    }
    return { data: unpublished };
  });
  const first = render(<AccountedDraftClient tenantId={tenant} actorId={tenant} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Reconcile original request' }));
  fireEvent.click(await screen.findByLabelText('I reviewed this exact unpublished content.'));
  fireEvent.change(screen.getByLabelText(/Review reason/), {
    target: { value: 'Reviewed synthetic draft limitations carefully.' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Accept unpublished draft' }));
  await screen.findByText('Review reply lost');
  const retained = readDraftJournal(localStorage, tenant, tenant).review;
  expect(retained?.decision).toBe('accepted');
  first.unmount();
  render(<AccountedDraftClient tenantId={tenant} actorId={tenant} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Reconcile original request' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Retry original review decision' }));
  await waitFor(() => expect(calls).toHaveLength(2));
  expect(calls[1]).toEqual(calls[0]);
  expect(readDraftJournal(localStorage, tenant, tenant).review).toEqual(retained);
  expect(screen.queryByRole('button', { name: 'Reject unpublished draft' })).toBeNull();
});
it('rereads storage under lock and refuses a different cross-tab original', async () => {
  retainDraftRequest(localStorage, original);
  render(<AccountedDraftClient tenantId={tenant} actorId={tenant} />);
  const button = await screen.findByRole('button', { name: 'Reconcile original request' });
  const changed = {
    ...original,
    reviewedRequestText: original.reviewedRequestText.replace('a'.repeat(64), 'c'.repeat(64)),
  };
  localStorage.setItem(intentKey(changed), canonicalJson(changed));
  fireEvent.click(button);
  await screen.findByText(/Retained intent changed in another tab/);
  expect(vi.mocked(requestDraft).mock.calls.some(([, , p]) => p.endsWith('/reconcile'))).toBe(
    false,
  );
});
it('blocks writes when browser storage cannot be read', async () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('Storage unavailable');
  });
  render(<AccountedDraftClient tenantId={tenant} actorId={tenant} />);
  await screen.findByText('Storage unavailable');
  expect(screen.getByRole('button', { name: 'Load frozen source' }).hasAttribute('disabled')).toBe(
    true,
  );
});
