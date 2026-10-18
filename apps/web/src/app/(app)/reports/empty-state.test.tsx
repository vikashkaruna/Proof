// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ReportsClient } from './reports-client';
import { reportRequest } from './report-request';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('./board-workflow', () => ({ BoardWorkflow: () => null }));
vi.mock('./auditor-workflow', () => ({ AuditorWorkflow: () => null }));
vi.mock('./pack-preparation', () => ({ PackPreparation: () => null }));
vi.mock('./report-request', async (original) => ({
  ...(await original<typeof import('./report-request')>()),
  reportRequest: vi.fn(),
}));
const request = vi.mocked(reportRequest);
const access = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  canPrepare: false,
  canReview: false,
  canRelease: false,
  canExport: false,
  canRequestBoard: false,
  canManageBoard: false,
};
beforeEach(() => {
  request.mockReset().mockImplementation(async () =>
    Response.json({
      data: [],
      meta: { total: 0, offset: 0, limit: 20, hasMore: false },
    }),
  );
});
afterEach(cleanup);

it('explains to a report reader who must prepare and release a missing report', async () => {
  render(<ReportsClient {...access} />);
  await screen.findByText('No reports recorded for this view.');
  expect(screen.getByText(/Ask an assessment owner to prepare a report/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Show all reports from the beginning' })).toBeNull();
});

it('guides a reporting manager to the finalized assessment workflow', async () => {
  render(<ReportsClient {...access} canRequestBoard />);
  await screen.findByText('No reports recorded for this view.');
  expect(screen.getByText(/Use the board or auditor workflow above/)).toBeTruthy();
  expect(
    screen.getByText(/Demo records do not automatically create reviewed reports/),
  ).toBeTruthy();
});

it('lets a filtered empty list return to all reports without suggesting data is absent', async () => {
  render(<ReportsClient {...access} />);
  await screen.findByText('No reports recorded for this view.');
  fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), {
    target: { value: 'published' },
  });
  const reset = await screen.findByRole('button', { name: 'Show all reports from the beginning' });
  fireEvent.click(reset);
  await waitFor(() =>
    expect(
      screen.queryByRole('button', { name: 'Show all reports from the beginning' }),
    ).toBeNull(),
  );
  expect((screen.getByRole('combobox', { name: 'Status' }) as HTMLSelectElement).value).toBe('');
  expect(request).toHaveBeenLastCalledWith(
    access.tenantId,
    '/reports?limit=20&offset=0',
    expect.anything(),
  );
});
