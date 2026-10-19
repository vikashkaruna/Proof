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
it('presents branded company context and distinct review stages without making a new decision', async () => {
  const transport = vi.mocked(reportRequest);
  transport
    .mockReset()
    .mockImplementation(async () =>
      Response.json({ requests: [], total: 0, limit: 20, offset: 0 }),
    );
  render(
    <FounderReportReviewClient
      tenantId={id(3)}
      actorId={id(1)}
      tenantName="An organization with a long descriptive name"
    />,
  );
  await screen.findByText('No board report requests are recorded for this view.');
  await screen.findByText('No auditor review pack requests are recorded.');
  const guidance = screen.getByRole('region', { name: 'Founder report review guidance' });
  const disclosure = guidance.querySelector('details')!;
  expect(disclosure.open).toBe(false);
  fireEvent.click(within(guidance).getByText('How review and release work'));
  expect(disclosure.open).toBe(true);
  expect(within(guidance).getByRole('list', { name: 'Report review stages' })).toBeTruthy();
  expect(within(guidance).getAllByRole('listitem')).toHaveLength(4);
  expect(within(guidance).getByText(/Approval records your content decision/)).toBeTruthy();
  expect(screen.getByRole('img', { name: 'Axiom Proof Mark' })).toBeTruthy();
  expect(screen.queryByText('M2.7')).toBeNull();
  expect(screen.queryByText('P2')).toBeNull();
  expect(screen.getByText('An organization with a long descriptive name')).toBeTruthy();
  expect(
    screen.getByRole('link', { name: 'Working reports & registers' }).getAttribute('href'),
  ).toBe('/reports');
  const queues = screen.getByRole('navigation', { name: 'Report request queues' });
  for (const [name, target] of [
    ['Board queue', 'founder-board-requests'],
    ['Auditor queue', 'founder-auditor-requests'],
  ] as const) {
    expect(within(queues).getByRole('link', { name }).getAttribute('href')).toBe(`#${target}`);
    expect(document.getElementById(target)?.getAttribute('tabindex')).toBe('-1');
  }
  expect(screen.getByRole('link', { name: 'axiomproof.ai' }).getAttribute('href')).toBe(
    'https://axiomproof.ai',
  );
  expect(screen.getByRole('link', { name: 'axiomminds.ai' }).getAttribute('href')).toBe(
    'https://axiomminds.ai',
  );
  expect(transport.mock.calls).toHaveLength(2);
  expect(
    transport.mock.calls.every(
      ([tenant, path, options]) =>
        tenant === id(3) && path.includes('/requests?') && !options?.body,
    ),
  ).toBe(true);
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
  const sourceDetails = inspector.getByText('Source and version details').closest('details')!;
  expect(sourceDetails.open).toBe(false);
  fireEvent.click(inspector.getByText('Source and version details'));
  expect(sourceDetails.open).toBe(true);
  expect(inspector.getByText(hash)).toBeTruthy();
  fireEvent.click(
    inspector.getByLabelText(
      'I reviewed the exact content and its SHA-256 in Source and version details.',
    ),
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
  expect(screen.queryByText('No board report requests are recorded for this view.')).toBeNull();
  expect(screen.queryByText('No auditor review pack requests are recorded.')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Generate source-bound draft' })).toBeNull();
  vi.mocked(reportRequest).mockImplementation(async () =>
    Response.json({ requests: [], total: 0, limit: 20, offset: 0 }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Refresh board state' }));
  await screen.findByText('No board report requests are recorded for this view.');
  expect(screen.getAllByText('Saved request queue unavailable')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh auditor packs' }));
  await screen.findByText('No auditor review pack requests are recorded.');
  expect(screen.queryByText('Saved request queue unavailable')).toBeNull();
});

it.each(['board', 'auditor'] as const)(
  '%s exposes its requested next action after selection, with exact references available on demand',
  async (kind) => {
    const transport = vi.mocked(reportRequest);
    transport.mockReset().mockImplementation(async (_tenant, path) =>
      Response.json({
        requests: [
          {
            id: id(path.includes('/board/') ? 10 : 11),
            engagementId: id(20),
            assessmentRunId: id(21),
            reportId: null,
            title: path.includes('/board/') ? 'Prepared board request' : 'Prepared auditor request',
            status: 'requested',
            createdAt: '2026-10-01T00:00:00Z',
            updatedAt: '2026-10-01T00:00:00Z',
          },
        ],
        total: 1,
        limit: 20,
        offset: 0,
      }),
    );
    render(
      <FounderReportReviewClient
        tenantId={id(3)}
        actorId={id(1)}
        tenantName="Selected organization"
      />,
    );
    const row = await screen.findByRole('button', { name: new RegExp(`Prepared ${kind} request`) });
    expect(row.textContent).toContain('View next action');
    expect(screen.queryByRole('button', { name: 'Generate source-bound draft' })).toBeNull();
    fireEvent.click(row);
    expect(screen.getByRole('button', { name: 'Generate source-bound draft' })).toBeTruthy();
    const details = screen.getByText('Source and version details').closest('details')!;
    expect(details.open).toBe(false);
    fireEvent.click(screen.getByText('Source and version details'));
    expect(details.open).toBe(true);
    expect(within(details).getByText(id(kind === 'board' ? 10 : 11))).toBeTruthy();
    expect(within(details).getByText(id(21))).toBeTruthy();
    expect(transport.mock.calls.every(([, , options]) => !options?.body)).toBe(true);
  },
);
