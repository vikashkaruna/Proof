// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { FounderReportReviewClient } from './review-client';
import { reportRequest } from '../report-request';
vi.mock('../report-request', async (original) => ({
  ...(await original<typeof import('../report-request')>()),
  reportRequest: vi.fn(),
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  hash = 'a'.repeat(64);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});
it('loads existing tenant requests without new-request options and refreshes both queues after original lost review reconciliation', async () => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
  let approved = false,
    reviewCalls = 0;
  const transport = vi.mocked(reportRequest);
  transport.mockReset().mockImplementation(async (tenant, path, options) => {
    expect(tenant).toBe(id(3));
    if (path.includes('assessment-options')) throw Error('Newrequestoptionsmustnotbeloaded');
    if (path.endsWith('/review')) {
      reviewCalls++;
      expect(options?.body).toEqual({
        decision: 'approved',
        note: 'Independent human review of the exact saved draft.',
        expectedContentHash: hash,
      });
      approved = true;
      throw Error('Review outcome unconfirmed. Refresh the original report.');
    }
    if (path.includes('/requests?'))
      return Response.json({
        requests: [
          {
            id: id(path.includes('/board/') ? 10 : 11),
            engagementId: id(20),
            assessmentRunId: id(21),
            reportId: id(path.includes('/board/') ? 30 : 31),
            title: path.includes('/board/') ? 'Saved board request' : 'Saved auditor request',
            status: approved ? 'reviewed' : 'drafted',
            createdAt: '2026-10-01T00:00:00Z',
            updatedAt: '2026-10-01T00:00:00Z',
          },
        ],
        total: 1,
        limit: 20,
        offset: 0,
      });
    if (path.endsWith('/artifacts/status'))
      return Response.json({
        reportId: id(30),
        reportStatus: approved ? 'approved' : 'draft',
        status: 'not_started',
        buildId: null,
        operationKey: null,
        retainUntil: null,
        lastErrorCode: null,
        source: null,
        pdf: null,
      });
    if (path === `/reports/${id(30)}` || path === `/reports/${id(31)}`)
      return Response.json({
        data: {
          id: path.split('/').at(-1),
          kind: 'board',
          title: 'Exact synthetic saved draft',
          engagementId: id(20),
          libraryVersion: '0.1.1',
          status: approved ? 'approved' : 'draft',
          generatedAt: '2026-10-01T00:00:00Z',
          generatedByAgent: 'board-report-builder',
          createdBy: id(2),
          contentHash: hash,
          reviewedContentHash: approved ? hash : null,
          review: null,
          publishedAt: null,
          releasedBy: null,
          releasedArchiveHash: null,
          assurance: 'digest_bound',
          pack: null,
          contentText: '{"source":"synthetic exact-content fixture"}',
        },
      });
    throw Error('Unexpectedread ' + path);
  });
  render(
    <FounderReportReviewClient
      tenantId={id(3)}
      actorId={id(1)}
      tenantName="Selected synthetic organization"
    />,
  );
  await screen.findByRole('button', { name: /Saved board request/ });
  expect(screen.queryByRole('form', { name: 'Request board report' })).toBeNull();
  expect(screen.queryByRole('form', { name: 'Request auditor review pack' })).toBeNull();
  expect(screen.getByText(/Each organization has its own queue/)).toBeTruthy();
  const board = within(screen.getByRole('region', { name: 'Board report workflow' }));
  fireEvent.click(board.getByRole('button', { name: /Saved board request/ }));
  fireEvent.click(await board.findByRole('button', { name: 'Open report for review' }));
  const inspector = within(await screen.findByRole('region', { name: 'Exact report review' }));
  await inspector.findByText('Exact synthetic saved draft');
  fireEvent.click(
    inspector.getByLabelText('I reviewed the exact content and SHA-256 shown above.'),
  );
  fireEvent.change(inspector.getByLabelText('Review note (required for rejection)'), {
    target: { value: 'Independent human review of the exact saved draft.' },
  });
  fireEvent.click(inspector.getByRole('button', { name: 'Approve reviewed content' }));
  await inspector.findByText('Review outcome unconfirmed. Refresh the original report.');
  fireEvent.click(inspector.getByRole('button', { name: 'Refresh report detail' }));
  await waitFor(() =>
    expect(inspector.queryByRole('button', { name: 'Approve reviewed content' })).toBeNull(),
  );
  await board.findByRole('button', { name: 'Build and retain reviewed source and PDF' });
  expect(reviewCalls).toBe(1);
  expect(transport.mock.calls.filter(([, , options]) => options?.body !== undefined)).toHaveLength(
    1,
  );
  expect(transport.mock.calls.some(([, path]) => path.includes('assessment-options'))).toBe(false);
});
it('retains honest request-list failure without inventing an empty or completed queue', async () => {
  vi.mocked(reportRequest).mockRejectedValue(Error('Saved request queue unavailable'));
  render(
    <FounderReportReviewClient
      tenantId={id(3)}
      actorId={id(1)}
      tenantName="Selected organization"
    />,
  );
  await screen.findAllByText('Saved request queue unavailable');
  expect(screen.queryByText('All reports complete')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Generate source-bound draft' })).toBeNull();
});
