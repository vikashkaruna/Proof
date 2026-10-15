// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BoardWorkflow } from './board-workflow';
import { AuditorWorkflow } from './auditor-workflow';
import { reportRequest } from './report-request';

vi.mock('./report-request', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./report-request')>()),
  reportRequest: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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
  vi.stubGlobal('crypto', {});
  fireEvent.click(screen.getByRole('button', { name: 'Build and retain reviewed source and PDF' }));
  await screen.findByText(/Request not sent/);
  expect(request.mock.calls.every(([, , options]) => options?.body === undefined)).toBe(true);
  vi.unstubAllGlobals();
  status = 'draft';
  fireEvent.click(screen.getByRole('button', { name: 'Refresh board state' }));
  await screen.findByText(/Report status: draft/);
  expect(
    screen.queryByRole('button', { name: 'Build and retain reviewed source and PDF' }),
  ).toBeNull();
  expect(request.mock.calls.every(([, , options]) => options?.body === undefined)).toBe(true);
});

it.each([BoardWorkflow, AuditorWorkflow])(
  'shows pre-send preparation failure and supports a secure fallback in %s',
  async (Workflow) => {
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const request = vi.mocked(reportRequest);
    request.mockReset();
    request.mockImplementation((_tenant, path, options) => {
      if (path.includes('assessment-options'))
        return Promise.resolve(
          Response.json({
            assessments: [
              {
                assessmentRunId: id,
                engagementId: id,
                engagementTitle: 'Finalized fixture',
                finalizedAt: '2026-10-01T00:00:00Z',
                libraryVersion: '0.1.1',
              },
            ],
            total: 1,
            limit: 20,
            offset: 0,
          }),
        );
      if (options?.body !== undefined) return Promise.resolve(Response.json({ requestId: id }));
      return Promise.resolve(Response.json({ requests: [], total: 0, limit: 20, offset: 0 }));
    });
    vi.stubGlobal('crypto', {});
    render(
      <Workflow
        tenantId={id}
        canRequest
        canManage={false}
        onOpenReport={vi.fn()}
        onChanged={vi.fn()}
      />,
    );
    const form = await screen.findByRole('form');
    await within(form).findByRole('option', { name: /Finalized fixture/ });
    fireEvent.change(within(form).getByLabelText('Assessment'), { target: { value: id } });
    fireEvent.change(within(form).getByRole('textbox'), { target: { value: 'Reviewed source' } });
    fireEvent.click(within(form).getByRole('checkbox'));
    fireEvent.submit(form);
    await screen.findByText(/Request not sent/);
    expect(request.mock.calls.filter(([, , options]) => options?.body !== undefined)).toHaveLength(
      0,
    );
    expect(within(form).getByRole('textbox')).toHaveProperty('value', 'Reviewed source');
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.fill(9);
        return bytes;
      },
    });
    fireEvent.submit(form);
    await waitFor(() =>
      expect(
        request.mock.calls.filter(([, , options]) => options?.body !== undefined),
      ).toHaveLength(1),
    );
    const body = request.mock.calls.find(([, , options]) => options?.body !== undefined)![2]!
      .body as { operationKey: string };
    expect(body.operationKey).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    );
  },
);
