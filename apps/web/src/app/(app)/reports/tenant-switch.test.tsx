// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ReportsClient } from './reports-client';
import { BoardWorkflow } from './board-workflow';
import { reportRequest } from './report-request';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('./report-request', () => ({ reportRequest: vi.fn() }));
vi.mock('./pack-preparation', () => ({ PackPreparation: () => null }));
vi.mock('./closure-dossiers-tab', () => ({ ClosureDossiersTab: () => null }));
const request = vi.mocked(reportRequest);
const tenantA = '11111111-1111-4111-8111-111111111111';
const tenantB = '22222222-2222-4222-8222-222222222222';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const report = {
  id,
  kind: 'board',
  title: 'Private tenant A report',
  engagementId: null,
  libraryVersion: 'v1',
  status: 'draft',
  generatedAt: '2026-10-01T00:00:00Z',
  generatedByAgent: 'board-report-builder',
  createdBy: null,
  contentHash: 'a'.repeat(64),
  reviewedContentHash: null,
  review: null,
  publishedAt: null,
  releasedBy: null,
  releasedArchiveHash: null,
  assurance: 'digest_bound',
  pack: null,
};
const page = (data: unknown[]) =>
  Response.json({
    data,
    meta: { total: data.length, limit: 20, offset: 0, hasMore: false },
  });

beforeEach(() => {
  request.mockReset();
});
afterEach(cleanup);

it('removes a prior tenant report and selected detail before the next tenant list resolves', async () => {
  let resolveB!: (value: Response) => void;
  const tenantBList = new Promise<Response>((resolve) => {
    resolveB = resolve;
  });
  request.mockImplementation((tenant, path) => {
    if (tenant === tenantB) return tenantBList;
    if (path === `/reports/${id}`)
      return Promise.resolve(
        Response.json({ data: { ...report, contentText: '{}', content: {} } }),
      );
    return Promise.resolve(page([report]));
  });
  const access = {
    tenantId: tenantA,
    canPrepare: false,
    canReview: false,
    canRelease: false,
    canExport: false,
    canRequestBoard: false,
    canManageBoard: false,
  };
  const { rerender } = render(<ReportsClient {...access} />);
  const recorded = screen.getByRole('region', { name: 'Recorded reports' });
  fireEvent.click(await within(recorded).findByRole('button', { name: /Private tenant A report/ }));
  await screen.findByRole('region', { name: 'Report detail' });
  rerender(<ReportsClient {...access} tenantId={tenantB} />);
  expect(screen.queryByText('Private tenant A report')).toBeNull();
  expect(screen.queryByRole('region', { name: 'Report detail' })).toBeNull();
  expect(screen.getByText('Loading recorded reports…')).toBeTruthy();
  expect(request).toHaveBeenCalledWith(tenantB, '/reports?limit=20&offset=0', expect.anything());
  resolveB(page([]));
  await screen.findByText('No reports recorded for this view.');
});

it('clears a selected board request and assessment when the tenant changes', async () => {
  const requestA = {
    id,
    engagementId: id,
    assessmentRunId: id,
    reportId: null,
    title: 'Private tenant A board request',
    status: 'requested',
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
  };
  let resolveB!: (value: Response) => void;
  const pendingB = new Promise<Response>((resolve) => {
    resolveB = resolve;
  });
  request.mockImplementation((tenant, path) => {
    if (tenant === tenantB) return pendingB;
    if (path?.includes('assessment-options'))
      return Promise.resolve(
        Response.json({
          assessments: [
            {
              assessmentRunId: id,
              engagementId: id,
              engagementTitle: 'Private assessment A',
              finalizedAt: '2026-10-01T00:00:00Z',
              libraryVersion: 'v1',
            },
          ],
          total: 1,
          limit: 20,
          offset: 0,
        }),
      );
    if (!path?.includes('board/requests'))
      throw new Error(`Unexpected report path: ${String(path)}`);
    return Promise.resolve(Response.json({ requests: [requestA], total: 1, limit: 20, offset: 0 }));
  });
  const props = {
    tenantId: tenantA,
    canRequest: true,
    canManage: false,
    onOpenReport: vi.fn(),
    onChanged: vi.fn(),
  };
  const { rerender } = render(<BoardWorkflow {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: /Private tenant A board request/ }));
  expect(screen.getByLabelText('Selected board request')).toBeTruthy();
  rerender(<BoardWorkflow {...props} tenantId={tenantB} />);
  expect(screen.queryByText('Private tenant A board request')).toBeNull();
  expect(screen.queryByText(/Private assessment A/)).toBeNull();
  expect(screen.queryByLabelText('Selected board request')).toBeNull();
  expect(screen.getByText('Loading board requests…')).toBeTruthy();
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      tenantB,
      '/reports/board/requests?limit=20&offset=0',
      expect.anything(),
    ),
  );
  resolveB(Response.json({ assessments: [], requests: [], total: 0, limit: 20, offset: 0 }));
});

it('retries an uncertain board request with the same operation key and no premature success', async () => {
  const submitted: {
    operationKey: string;
    title: string;
    engagementId: string;
    assessmentRunId: string;
  }[] = [];
  request.mockImplementation((_tenant, path, options) => {
    if (path.includes('assessment-options'))
      return Promise.resolve(
        Response.json({
          assessments: [
            {
              assessmentRunId: id,
              engagementId: id,
              engagementTitle: 'Finalized assessment',
              finalizedAt: '2026-10-01T00:00:00Z',
              libraryVersion: 'v1',
            },
          ],
          total: 1,
          limit: 20,
          offset: 0,
        }),
      );
    if (path.includes('board/requests'))
      return Promise.resolve(Response.json({ requests: [], total: 0, limit: 20, offset: 0 }));
    if (path === '/reports/board/request') {
      submitted.push(options?.body as (typeof submitted)[number]);
      return submitted.length === 1
        ? Promise.reject(
            new Error('The outcome is uncertain. Refresh the recorded state before trying again.'),
          )
        : Promise.resolve(Response.json({ requestId: id, replayed: true }));
    }
    throw new Error(`Unexpected report path: ${path}`);
  });
  const changed = vi.fn();
  render(
    <BoardWorkflow
      tenantId={tenantA}
      canRequest
      canManage={false}
      onOpenReport={vi.fn()}
      onChanged={changed}
    />,
  );
  const form = await screen.findByRole('form', { name: 'Request board report' });
  fireEvent.change(within(form).getByLabelText('Assessment'), { target: { value: id } });
  fireEvent.change(within(form).getByLabelText('Report title'), {
    target: { value: 'Recorded board source' },
  });
  fireEvent.click(within(form).getByRole('checkbox'));
  fireEvent.click(within(form).getByRole('button', { name: 'Request board draft' }));
  await screen.findByText(/The outcome is uncertain/);
  expect(changed).not.toHaveBeenCalled();
  expect(within(form).getByLabelText('Report title')).toHaveProperty(
    'value',
    'Recorded board source',
  );
  fireEvent.click(within(form).getByRole('button', { name: 'Request board draft' }));
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
  expect(submitted).toHaveLength(2);
  expect(submitted[0]).toMatchObject({
    title: 'Recorded board source',
    engagementId: id,
    assessmentRunId: id,
  });
  expect(submitted[0]!.operationKey).toMatch(/^[0-9a-f-]{36}$/);
  expect(submitted[1]!.operationKey).toBe(submitted[0]!.operationKey);
});

it('removes private detail on a denied refresh instead of preserving the last authorized view', async () => {
  let detailReads = 0;
  request.mockImplementation((_tenant, path) => {
    if (path === `/reports/${id}`) {
      detailReads++;
      return detailReads === 1
        ? Promise.resolve(Response.json({ data: { ...report, contentText: '{}', content: {} } }))
        : Promise.reject(new Error('forbidden'));
    }
    return Promise.resolve(page([report]));
  });
  const access = {
    tenantId: tenantA,
    canPrepare: false,
    canReview: true,
    canRelease: true,
    canExport: false,
    canRequestBoard: false,
    canManageBoard: false,
  };
  render(<ReportsClient {...access} />);
  const recorded = screen.getByRole('region', { name: 'Recorded reports' });
  fireEvent.click(await within(recorded).findByRole('button', { name: /Private tenant A report/ }));
  const detail = await screen.findByRole('region', { name: 'Report detail' });
  await within(detail).findByRole('heading', { name: 'Private tenant A report' });
  fireEvent.click(within(detail).getByRole('button', { name: 'Refresh report detail' }));
  await within(detail).findByRole('alert');
  expect(within(detail).queryByRole('heading', { name: 'Private tenant A report' })).toBeNull();
  expect(within(detail).queryByRole('button', { name: 'Approve reviewed content' })).toBeNull();
  expect(detailReads).toBe(2);
});
