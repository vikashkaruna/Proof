// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BoardWorkflow } from './board-workflow';
import { reportRequest } from './report-request';

vi.mock('./report-request', () => ({ reportRequest: vi.fn() }));
afterEach(cleanup);

it('reselects the current board request by reading fresh reviewed state without a mutation', async () => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const tenantId = '11111111-1111-4111-8111-111111111111';
  const request = vi.mocked(reportRequest);
  let status: 'draft' | 'approved' = 'draft';
  request.mockImplementation((_tenant, path) => {
    if (path.includes('assessment-options'))
      return Promise.resolve(Response.json({ assessments: [], total: 0, limit: 20, offset: 0 }));
    if (path.includes('/board/requests'))
      return Promise.resolve(
        Response.json({
          requests: [
            {
              id,
              engagementId: id,
              assessmentRunId: id,
              reportId: id,
              title: 'Reviewed board request',
              status: 'drafted',
              createdAt: '2026-10-01T00:00:00Z',
              updatedAt: '2026-10-01T00:00:00Z',
            },
          ],
          total: 1,
          limit: 20,
          offset: 0,
        }),
      );
    if (path.endsWith('/artifacts/status'))
      return Promise.resolve(
        Response.json({
          reportId: id,
          reportStatus: status,
          status: 'not_started',
          buildId: null,
          operationKey: null,
          retainUntil: null,
          lastErrorCode: null,
          source: null,
          pdf: null,
        }),
      );
    if (path === `/reports/${id}`)
      return Promise.resolve(
        Response.json({
          data: {
            id,
            kind: 'board',
            title: 'Reviewed board request',
            engagementId: id,
            libraryVersion: 'v1',
            status,
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
            contentText: '{}',
          },
        }),
      );
    throw new Error(`Unexpected request ${path}`);
  });
  render(
    <BoardWorkflow
      tenantId={tenantId}
      canRequest
      canManage
      onOpenReport={vi.fn()}
      onChanged={vi.fn()}
    />,
  );
  const selected = await screen.findByRole('button', { name: /Reviewed board request/ });
  fireEvent.click(selected);
  await screen.findByText(/Report status: draft/);
  expect(
    screen.queryByRole('button', { name: 'Build and retain reviewed source and PDF' }),
  ).toBeNull();
  status = 'approved';
  fireEvent.click(selected);
  await screen.findByText(/Report status: approved/);
  expect(
    screen.getByRole('button', { name: 'Build and retain reviewed source and PDF' }),
  ).toBeTruthy();
  expect(request.mock.calls.filter(([, path]) => path === `/reports/${id}`)).toHaveLength(2);
  status = 'draft';
  fireEvent.click(screen.getByRole('button', { name: 'Refresh board state' }));
  await screen.findByText(/Report status: draft/);
  expect(
    screen.queryByRole('button', { name: 'Build and retain reviewed source and PDF' }),
  ).toBeNull();
  expect(request.mock.calls.every(([, , options]) => options?.body === undefined)).toBe(true);
});
