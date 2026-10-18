// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { reportRequest } from '../report-request';
import { AccountedDraftClient } from './draft-client';
vi.mock('../report-request', async (original) => ({
  ...(await original<typeof import('../report-request')>()),
  reportRequest: vi.fn(),
}));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});
const tenant = '11111111-1111-4111-8111-111111111111';
it('shows a clear disabled controller state without generation controls', async () => {
  vi.mocked(reportRequest).mockResolvedValue(Response.json({ data: { enabled: false } }));
  render(<AccountedDraftClient tenantId={tenant} actorId={tenant} />);
  expect(await screen.findByText(/dedicated draft controller is not configured/i)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /generate/i })).toBeNull();
});
it('keeps original retained request after uncertain reconciliation and never changes its operation', async () => {
  const text = JSON.stringify({
    operationKey: '22222222-2222-4222-8222-222222222222',
    sourceReviewed: true,
  });
  const key = `axiom:accounted-draft:${tenant}:${tenant}`;
  localStorage.setItem(key, text);
  const request = vi.mocked(reportRequest);
  request.mockImplementation(async (_tenant, path) => {
    if (path.endsWith('/configuration')) return Response.json({ data: { enabled: true } });
    if (path.includes('/assessment-options')) return Response.json({ assessments: [] });
    throw new Error('Original outcome uncertain; reconcile only.');
  });
  render(<AccountedDraftClient tenantId={tenant} actorId={tenant} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Reconcile original request' }));
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toContain('Original outcome uncertain'),
  );
  expect(localStorage.getItem(key)).toBe(text);
  expect(request.mock.calls.find(([, path]) => path.endsWith('/reconcile'))?.[2]?.body).toEqual({
    reviewedRequestText: text,
  });
  expect(
    request.mock.calls.some(([, path]) => path.endsWith('/generate') || path.endsWith('/request')),
  ).toBe(false);
});
