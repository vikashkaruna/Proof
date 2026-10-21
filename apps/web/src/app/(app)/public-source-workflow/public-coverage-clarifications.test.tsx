// @vitest-environment jsdom
import React from 'react';
import { createHash, webcrypto } from 'node:crypto';
import { canonicalJson } from '@axiom/ledger';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PublicCoverageClarifications } from './public-coverage-clarifications';
import { fixture, ids } from './control-review-fixture.test-helper';
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});
const ok = (data: unknown) =>
  new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
it('normalizes missing historical pages and keeps explanations distinct from examined evidence', async () => {
  const fetcher = vi.fn().mockResolvedValue(ok({ canClarify: true, record: null }));
  vi.stubGlobal('fetch', fetcher);
  render(<PublicCoverageClarifications actorId={ids.actor} assessment={fixture().assessment} />);
  expect(screen.getAllByRole('textbox')).toHaveLength(8);
  expect(screen.getByText(/Owner explanations remain unverified declarations/)).toBeTruthy();
  fireEvent.click(screen.getByText('Load / refresh owner declarations'));
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  await waitFor(() =>
    expect(screen.getByLabelText(/I authorize/).hasAttribute('disabled')).toBe(false),
  );
  expect(
    screen.getByRole('button', { name: 'Retain owner explanations' }).hasAttribute('disabled'),
  ).toBe(true);
});
it('retains an exact request after uncertain write and reconciles without preparing duplicate requests', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(ok({ canClarify: true, record: null }))
    .mockRejectedValueOnce(Error('lost response'));
  vi.stubGlobal('fetch', fetcher);
  render(<PublicCoverageClarifications actorId={ids.actor} assessment={fixture().assessment} />);
  fireEvent.click(screen.getByText('Load / refresh owner declarations'));
  await waitFor(() =>
    expect(screen.getByLabelText(/I authorize/).hasAttribute('disabled')).toBe(false),
  );
  for (const box of screen.getAllByRole('textbox', { name: /Owner explanation/ }))
    fireEvent.change(box, {
      target: { value: 'The owner is investigating the missing public notice.' },
    });
  fireEvent.click(screen.getByLabelText(/I authorize/));
  fireEvent.click(screen.getByText('Retain owner explanations'));
  await waitFor(() => expect(screen.getByText('Retry retained declaration')).toBeTruthy());
  const saved = localStorage.getItem(
    `axiom.coverage.v1/${ids.tenant}/${ids.actor}/${ids.engagement}/${ids.check}/${'a'.repeat(64)}`,
  );
  expect(saved).toBeTruthy();
  expect(fetcher.mock.calls[1]![1].body).toBe(saved);
  const operation = JSON.parse(saved!) as { operationKey: string };
  fetcher.mockResolvedValueOnce(ok({ canClarify: true, record: null }));
  fireEvent.click(screen.getByText('Check saved request'));
  await waitFor(() => expect(screen.getByText(/No receipt found yet/)).toBeTruthy());
  expect(fetcher.mock.calls[2]![0]).toContain(`/operations/${operation.operationKey}?`);
  expect(fetcher.mock.calls[2]![1].method).toBe('GET');
  expect(
    localStorage.getItem(
      `axiom.coverage.v1/${ids.tenant}/${ids.actor}/${ids.engagement}/${ids.check}/${'a'.repeat(64)}`,
    ),
  ).toBe(saved);
});
it('shows viewer read-only refusal and never sends a write', async () => {
  const fetcher = vi.fn().mockResolvedValue(ok({ canClarify: false, record: null }));
  vi.stubGlobal('fetch', fetcher);
  render(<PublicCoverageClarifications actorId={ids.actor} assessment={fixture().assessment} />);
  fireEvent.click(screen.getByText('Load / refresh owner declarations'));
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  expect(screen.queryByText('Retain owner explanations')).toBeNull();
  expect(fetcher.mock.calls[0]![1].method).toBe('GET');
});

it('verifies retained exact receipt before clearing a pending request', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const fetcher = vi.fn().mockResolvedValueOnce(ok({ canClarify: true, record: null }));
  fetcher.mockImplementationOnce(async (_url: string, options: { body: string }) => {
    const request = JSON.parse(options.body) as {
      engagementId: string;
      checkId: string;
      payloadSha256: string;
      operationKey: string;
      expectedPreviousRevisionId: null;
    };
    const id = '77777777-7777-4777-8777-777777777777';
    const snapshotText = canonicalJson({
      version: 1,
      disposition: 'owner_declarations_unverified',
      tenantId: ids.tenant,
      actorId: ids.actor,
      revisionId: id,
      previousRevisionId: null,
      recordedAt: '2026-10-21T10:00:00.000000Z',
      request,
    });
    const hash = (v: string) => createHash('sha256').update(v).digest('hex');
    return ok({
      replayed: false,
      record: {
        id,
        tenantId: ids.tenant,
        actorId: ids.actor,
        engagementId: request.engagementId,
        checkId: request.checkId,
        payloadSha256: request.payloadSha256,
        operationKey: request.operationKey,
        requestText: options.body,
        requestSha256: hash(options.body),
        snapshotText,
        snapshotSha256: hash(snapshotText),
        receiptId: '179',
      },
    });
  });
  vi.stubGlobal('fetch', fetcher);
  render(<PublicCoverageClarifications actorId={ids.actor} assessment={fixture().assessment} />);
  fireEvent.click(screen.getByText('Load / refresh owner declarations'));
  await waitFor(() =>
    expect(screen.getByLabelText(/I authorize/).hasAttribute('disabled')).toBe(false),
  );
  for (const box of screen.getAllByRole('textbox', { name: /Owner explanation/ }))
    fireEvent.change(box, {
      target: { value: 'The owner is investigating the missing public notice.' },
    });
  fireEvent.click(screen.getByLabelText(/I authorize/));
  fireEvent.click(screen.getByText('Retain owner explanations'));
  await waitFor(() =>
    expect(screen.getByText(/Owner declaration retained. Receipt 179/)).toBeTruthy(),
  );
  expect(localStorage.length).toBe(0);
  expect(screen.queryByText('Retry retained declaration')).toBeNull();
});
