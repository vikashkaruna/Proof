// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { canonicalJson } from '@axiom/ledger';
import { PublicControlHumanReview } from './public-control-human-review';
import { reviewFixture, ids } from './control-review-fixture.test-helper';
import {
  retainControlReviewOperation,
  readControlReviewOperations,
} from './control-review-journal';
import {
  loadHumanControlReview,
  reconcileHumanControlReview,
  sendHumanControlReview,
} from './control-review-client';
vi.mock('./control-review-client', () => ({
  loadHumanControlReview: vi.fn(),
  reconcileHumanControlReview: vi.fn(),
  sendHumanControlReview: vi.fn(),
}));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
const load = vi.mocked(loadHumanControlReview),
  send = vi.mocked(sendHumanControlReview),
  reconcile = vi.mocked(reconcileHumanControlReview);
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  load.mockResolvedValue(reviewFixture().head);
  vi.stubGlobal('crypto', { randomUUID: () => ids.operation });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
async function show(canReview = true) {
  const f = reviewFixture();
  const view = render(
    <PublicControlHumanReview
      actorId={ids.actor}
      canReview={canReview}
      assessment={f.assessment}
    />,
  );
  await waitFor(() => expect(load).toHaveBeenCalled());
  return { ...f, view };
}
function applicability() {
  fireEvent.change(screen.getByLabelText('Applicability rationale'), {
    target: { value: 'Internal applicability still unknown.' },
  });
}
function confirm() {
  fireEvent.click(screen.getByRole('checkbox', { name: /I reviewed these declarations/ }));
}
it('keeps dirty question changes out of recorded content until explicitly added and reconfirmed', async () => {
  await show();
  applicability();
  confirm();
  expect(screen.getByRole('button', { name: 'Record human control review' })).toHaveProperty(
    'disabled',
    false,
  );
  fireEvent.change(screen.getByLabelText('Human declaration'), { target: { value: 'yes' } });
  fireEvent.change(screen.getByLabelText('Judgment rationale'), {
    target: { value: 'Reviewed as unverified declaration.' },
  });
  expect(screen.getByRole('checkbox', { name: /I reviewed these declarations/ })).toHaveProperty(
    'checked',
    false,
  );
  expect(screen.getByRole('button', { name: 'Record human control review' })).toHaveProperty(
    'disabled',
    true,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Add judgment to review draft' }));
  confirm();
  send.mockRejectedValue(new Error('Uncertain response'));
  fireEvent.click(screen.getByRole('button', { name: 'Record human control review' }));
  await waitFor(() => expect(send).toHaveBeenCalledOnce());
  const recorded = JSON.parse(send.mock.calls[0]![1].requestText);
  expect(Object.values(recorded.answers)).toEqual([
    expect.objectContaining({ Q1: expect.objectContaining({ answer: true }) }),
  ]);
  expect(readControlReviewOperations(localStorage, ids.tenant, ids.actor)).toHaveLength(1);
});
it('shows friendly validation and prevents arbitrary selector/candidate injection', async () => {
  await show();
  fireEvent.click(screen.getByRole('button', { name: 'Add judgment to review draft' }));
  expect(screen.getByRole('alert').textContent).toContain('Enter a rationale');
  fireEvent.change(screen.getByLabelText('Judgment rationale'), {
    target: { value: 'Reviewed unknown.' },
  });
  fireEvent.change(
    screen.getByLabelText('Evidence candidate numbers (optional, comma-separated)'),
    { target: { value: '1,,2' } },
  );
  fireEvent.click(screen.getByRole('button', { name: 'Add judgment to review draft' }));
  expect(screen.getByRole('alert').textContent).toContain('recorded candidate');
  expect(send).not.toHaveBeenCalled();
});
it('requires separate cancellation reason and confirmation for each retained operation', async () => {
  const f = reviewFixture();
  retainControlReviewOperation(localStorage, f.operation);
  const second = {
    ...f.operation,
    requestText: canonicalJson({ ...f.request, operationKey: ids.review }),
  };
  const key = localStorage.key(0)!;
  localStorage.setItem(key.replace(ids.operation, ids.review), canonicalJson(second));
  await show();
  const reasons = screen.getAllByLabelText('Reason to cancel an unrecorded request');
  fireEvent.change(reasons[0]!, { target: { value: 'Cancel only the first intent.' } });
  fireEvent.change(reasons[1]!, { target: { value: 'A different second-intent reason.' } });
  const checks = screen.getAllByRole('checkbox', { name: /Cancel only if this request/ });
  fireEvent.click(checks[0]!);
  const buttons = screen.getAllByRole('button', { name: 'Cancel unrecorded human review request' });
  expect(buttons[0]).toHaveProperty('disabled', false);
  expect(buttons[1]).toHaveProperty('disabled', true);
  send.mockRejectedValue(new Error('Unknown cancellation outcome'));
  fireEvent.click(buttons[0]!);
  await waitFor(() => expect(send).toHaveBeenCalledOnce());
  expect(send.mock.calls[0]![2]).toBe('Cancel only the first intent.');
  expect(readControlReviewOperations(localStorage, ids.tenant, ids.actor)).toHaveLength(2);
});
it('preserves not-found journal and invalidates stale head after a positive outcome even if fresh head fails', async () => {
  const f = reviewFixture();
  retainControlReviewOperation(localStorage, f.operation);
  await show();
  reconcile.mockResolvedValueOnce({ state: 'not_found' });
  fireEvent.click(screen.getByRole('button', { name: 'Reconcile retained human review' }));
  await waitFor(() => expect(reconcile).toHaveBeenCalledOnce());
  expect(localStorage.length).toBe(1);
  reconcile.mockResolvedValueOnce({
    state: 'recorded',
    data: f.row,
    isCurrent: true,
    contextCurrent: true,
  });
  load.mockRejectedValueOnce(new Error('Fresh head unavailable'));
  fireEvent.click(screen.getByRole('button', { name: 'Reconcile retained human review' }));
  await screen.findByText(/fresh review context could not be loaded/);
  expect(localStorage.length).toBe(0);
  expect(
    screen.getByRole('button', { name: 'Record human control review' }).closest('fieldset'),
  ).toHaveProperty('disabled', true);
  expect(screen.getByRole('checkbox', { name: /I reviewed these declarations/ })).toHaveProperty(
    'checked',
    false,
  );
});
it('keeps read-only roles nonmutating and clears prior-estate draft declarations', async () => {
  const f = reviewFixture();
  load.mockResolvedValue({ ...f.head, estateId: ids.review, review: f.row });
  await show(false);
  expect(screen.queryByRole('button', { name: 'Record human control review' })).toBeNull();
  expect(screen.getByText(/different estate context/)).toBeTruthy();
  expect(send).not.toHaveBeenCalled();
});
it('suppresses a late old-scope head after selection changes or unmount', async () => {
  const f = reviewFixture();
  let finish: (value: typeof f.head) => void = () => {};
  load.mockReturnValueOnce(
    new Promise((r) => {
      finish = r;
    }),
  );
  const view = render(
    <PublicControlHumanReview actorId={ids.actor} canReview assessment={f.assessment} />,
  );
  view.unmount();
  await act(async () => finish(f.head));
  expect(send).not.toHaveBeenCalled();
});

it('keys review state by the full source scope and refuses an old deferred response after switching', async () => {
  const f = reviewFixture();
  let old: (v: Awaited<ReturnType<typeof loadHumanControlReview>>) => void = () => {};
  load.mockReturnValueOnce(
    new Promise((r) => {
      old = r;
    }),
  );
  const view = render(
    <PublicControlHumanReview actorId={ids.actor} canReview assessment={f.assessment} />,
  );
  const next = { ...f.assessment, source: { ...f.assessment.source, engagementId: ids.review } };
  load.mockResolvedValueOnce({ ...f.head, engagementId: ids.review });
  view.rerender(<PublicControlHumanReview actorId={ids.actor} canReview assessment={next} />);
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  await act(async () => old({ ...f.head, review: f.row }));
  expect(screen.queryByText(/Latest recorded review/)).toBeNull();
  expect(send).not.toHaveBeenCalled();
});

it('cannot restore an initial stale head after positive reconciliation invalidates it and fresh read fails', async () => {
  const f = reviewFixture();
  retainControlReviewOperation(localStorage, f.operation);
  let stale: (v: Awaited<ReturnType<typeof loadHumanControlReview>>) => void = () => {};
  load
    .mockReturnValueOnce(
      new Promise((r) => {
        stale = r;
      }),
    )
    .mockRejectedValueOnce(new Error('Fresh read failed'));
  render(<PublicControlHumanReview actorId={ids.actor} canReview assessment={f.assessment} />);
  reconcile.mockResolvedValueOnce({
    state: 'recorded',
    data: f.row,
    isCurrent: true,
    contextCurrent: true,
  });
  fireEvent.click(await screen.findByRole('button', { name: 'Reconcile retained human review' }));
  await screen.findByText(/fresh review context could not be loaded/);
  await act(async () => stale({ ...f.head, review: f.row }));
  expect(
    screen.getByRole('button', { name: 'Record human control review' }).closest('fieldset'),
  ).toHaveProperty('disabled', true);
  expect(screen.queryByText(/Latest recorded review/)).toBeNull();
});
it('offers only an explicit identifier-bound assessment-page handoff after a saved review, without dispatch', async () => {
  const f = reviewFixture();
  const row = f.row;
  load.mockResolvedValue({ ...f.head, review: row });
  render(
    <PublicControlHumanReview actorId={ids.actor} canReview canRun assessment={f.assessment} />,
  );
  const link = await screen.findByRole('link', {
    name: 'Request assessment from this recorded human review',
  });
  const url = new URL(link.getAttribute('href')!, 'https://app.example.invalid');
  expect(url.pathname).toBe('/assessment');
  expect(url.searchParams.get('engagement')).toBe(f.assessment.source.engagementId);
  expect(url.searchParams.get('reviewId')).toBe(row.id);
  expect(url.searchParams.get('requestSha256')).toBe(row.request_sha256);
  expect(url.searchParams.get('snapshotSha256')).toBe(row.snapshot_sha256);
  expect(url.searchParams.size).toBe(4);
  expect(send).not.toHaveBeenCalled();
  expect(
    screen.queryByRole('button', { name: 'Request assessment from recorded review' }),
  ).toBeNull();
});

it('requires explicit association confirmation for hinted v2 and recovers its exact bytes through reload to assessment handoff', async () => {
  const { linkedReviewFixture, assetIds } = await import('./control-review-v2-fixture.test-helper');
  const f = linkedReviewFixture();
  load.mockResolvedValue({ ...f.head, review: null });
  send.mockRejectedValue(new Error('lost response'));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('/estates/'))
        return Response.json({
          data: {
            id: assetIds.estate,
            tenant_id: ids.tenant,
            name: 'Estate',
            status: 'active',
            version: 1,
            systems: [
              {
                id: assetIds.system,
                tenant_id: ids.tenant,
                estate_id: assetIds.estate,
                name: 'Website',
                status: 'active',
                version: 1,
              },
            ],
          },
        });
      const query = new URL('http://test' + url).searchParams;
      return Response.json({
        data:
          query.get('kind') === 'targets'
            ? {
                kind: 'targets',
                tenantId: ids.tenant,
                actorId: ids.actor,
                estateId: assetIds.estate,
                systemId: assetIds.system,
                rows: [f.targetRow],
                nextCursor: null,
              }
            : {
                kind: 'associations',
                tenantId: ids.tenant,
                actorId: ids.actor,
                targetId: assetIds.target,
                rows: [f.associationRow],
                nextCursor: null,
              },
      });
    }),
  );
  const props = {
    actorId: ids.actor,
    canReview: true,
    canRun: true,
    assessment: f.assessment,
    assetHint: { targetId: assetIds.target, associationId: assetIds.association },
  };
  const view = render(<PublicControlHumanReview {...props} />);
  await screen.findByText(/Estate Estate/);
  fireEvent.change(screen.getByLabelText('Applicability rationale'), {
    target: { value: f.request.applicability.rationale },
  });
  confirm();
  expect(screen.getByRole('button', { name: 'Record human control review' })).toHaveProperty(
    'disabled',
    true,
  );
  expect(send).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Website review system'), {
    target: { value: assetIds.system },
  });
  fireEvent.click(screen.getByText('Load registered review targets'));
  await screen.findByLabelText('Registered review target');
  fireEvent.change(screen.getByLabelText('Registered review target'), {
    target: { value: assetIds.target },
  });
  fireEvent.click(screen.getByText('Load saved review associations'));
  await screen.findByLabelText('Saved review association');
  fireEvent.change(screen.getByLabelText('Saved review association'), {
    target: { value: assetIds.association },
  });
  fireEvent.click(screen.getByRole('checkbox', { name: /I confirm this exact saved target/ }));
  // A fresh read of the identical displayed source refreshes the head without changing its identity.
  await act(async () => {
    view.rerender(
      <PublicControlHumanReview {...props} assessment={structuredClone(f.assessment)} />,
    );
  });
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  await screen.findByText(/Estate Estate/);
  expect(screen.queryByRole('checkbox', { name: /I confirm this exact saved target/ })).toBeNull();
  expect(screen.getByRole('button', { name: 'Record human control review' })).toHaveProperty(
    'disabled',
    true,
  );
  fireEvent.change(screen.getByLabelText('Website review system'), {
    target: { value: assetIds.system },
  });
  fireEvent.click(screen.getByText('Load registered review targets'));
  await screen.findByLabelText('Registered review target');
  fireEvent.change(screen.getByLabelText('Registered review target'), {
    target: { value: assetIds.target },
  });
  fireEvent.click(screen.getByText('Load saved review associations'));
  await screen.findByLabelText('Saved review association');
  fireEvent.change(screen.getByLabelText('Saved review association'), {
    target: { value: assetIds.association },
  });
  expect(
    screen.getByRole('checkbox', { name: /I confirm this exact saved target/ }),
  ).toHaveProperty('checked', false);
  fireEvent.click(screen.getByRole('checkbox', { name: /I confirm this exact saved target/ }));
  fireEvent.change(screen.getByLabelText('Applicability rationale'), {
    target: { value: f.request.applicability.rationale },
  });
  confirm();
  fireEvent.click(screen.getByRole('button', { name: 'Record human control review' }));
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  const retained = readControlReviewOperations(localStorage, ids.tenant, ids.actor)[0]!;
  expect(retained.requestText).toBe(f.operation.requestText);
  view.unmount();
  load.mockResolvedValue(f.head);
  reconcile.mockResolvedValue({
    state: 'recorded',
    data: f.row,
    isCurrent: true,
    contextCurrent: true,
  });
  render(<PublicControlHumanReview {...props} />);
  await screen.findByText(/Retained human review request/);
  expect(send).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByText('Reconcile retained human review'));
  const link = await screen.findByRole('link', {
    name: 'Request assessment from this recorded human review',
  });
  expect(link.getAttribute('href')).toContain('reviewId=' + f.row.id);
  expect(link.getAttribute('href')).toContain('snapshotSha256=' + f.row.snapshot_sha256);
  expect(readControlReviewOperations(localStorage, ids.tenant, ids.actor)).toHaveLength(0);
  expect(send).toHaveBeenCalledTimes(1);
});
