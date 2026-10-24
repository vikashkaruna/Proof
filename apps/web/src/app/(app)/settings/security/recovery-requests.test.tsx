// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RecoveryRequests } from './recovery-requests';
const fetchMock = vi.fn();
const reviewer = '00000000-0000-4000-8000-000000000001';
const subject = '00000000-0000-4000-8000-000000000002';
const receipt = {
  id: '00000000-0000-4000-8000-000000000003',
  subjectUserId: subject,
  subjectEmail: 'persona-owner@example.invalid',
  reviewerUserId: reviewer,
  reviewerEmail: 'persona-founder@example.invalid',
  reason: 'Lost phone and backup codes',
  createdAt: '2026-10-24T00:00:00Z',
  expiresAt: '2026-10-25T00:00:00Z',
  status: 'pending',
};
const overview = {
  reviewers: [{ id: reviewer, email: receipt.reviewerEmail, kind: 'founder' }],
  own: [],
  inbox: [],
};
const response = (data: unknown, status = 200) => Response.json(data, { status });
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
async function open() {
  render(<RecoveryRequests tenantId="tenant-a" />);
  fireEvent.click(screen.getByRole('button', { name: 'Check recovery requests' }));
  await screen.findByLabelText('Ask for help from');
}
it('states the note requirement and records only a selected-recipient request without a code', async () => {
  let saved = receipt;
  fetchMock
    .mockResolvedValueOnce(response(overview))
    .mockImplementationOnce(async (_url, init) => {
      saved = { ...receipt, id: JSON.parse(init.body).requestId };
      return response(saved, 201);
    })
    .mockImplementationOnce(async () => response({ ...overview, own: [saved] }));
  await open();
  const send = screen.getByRole('button', { name: 'Send recovery request' }) as HTMLButtonElement;
  expect(send.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Ask for help from'), { target: { value: reviewer } });
  fireEvent.change(screen.getByLabelText('What happened?'), { target: { value: 'too short' } });
  expect(send.disabled).toBe(true);
  fireEvent.click(send);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByLabelText('What happened?'), { target: { value: receipt.reason } });
  fireEvent.click(send);
  await screen.findByText(/Recovery request recorded/);
  const init = fetchMock.mock.calls[1]![1];
  expect(init.headers['X-Tenant-Id']).toBe('tenant-a');
  expect(JSON.parse(init.body)).toEqual({
    requestId: expect.any(String),
    reviewerUserId: reviewer,
    reason: receipt.reason,
  });
  expect(screen.queryByLabelText('Your authenticator code')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Send recovery request' })).toBeNull();
});
it('retries an uncertain request with the original identity and content', async () => {
  fetchMock
    .mockResolvedValueOnce(response(overview))
    .mockRejectedValueOnce(new Error('lost response'))
    .mockRejectedValueOnce(new Error('lost again'));
  await open();
  fireEvent.change(screen.getByLabelText('Ask for help from'), { target: { value: reviewer } });
  fireEvent.change(screen.getByLabelText('What happened?'), { target: { value: receipt.reason } });
  fireEvent.click(screen.getByRole('button', { name: 'Send recovery request' }));
  await screen.findByText(/outcome is unknown/);
  expect((screen.getByLabelText('What happened?') as HTMLInputElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Retry the same request' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  expect(fetchMock.mock.calls[2]![1].body).toBe(fetchMock.mock.calls[1]![1].body);
});
it('reads the original receipt after uncertainty and lets only the subject cancel through the server', async () => {
  fetchMock
    .mockResolvedValueOnce(response({ ...overview, own: [receipt] }))
    .mockResolvedValueOnce(response({ ...receipt, status: 'cancelled' }))
    .mockResolvedValueOnce(response({ ...overview, own: [{ ...receipt, status: 'cancelled' }] }));
  render(<RecoveryRequests tenantId="tenant-a" />);
  fireEvent.click(screen.getByRole('button', { name: 'Check recovery requests' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel request' }));
  await screen.findByText(/Request cancelled/);
  expect(fetchMock.mock.calls[1]![0]).toBe(
    `/api/bff/v1/mfa/recovery/requests/${receipt.id}/cancel`,
  );
  expect(fetchMock.mock.calls[1]![1].method).toBe('POST');
});
it('shows a request to its recipient as a request, with no one-click factor reset', async () => {
  fetchMock.mockResolvedValueOnce(response({ ...overview, inbox: [receipt] }));
  await open();
  expect(screen.getByText(`${receipt.subjectEmail} needs authenticator recovery.`)).toBeTruthy();
  expect(screen.getByText(/This request is not identity verification/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /approve|open recovery|reset/i })).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('recovers a saved request after a failed response without creating a replacement', async () => {
  let originalId = '';
  fetchMock
    .mockResolvedValueOnce(response(overview))
    .mockImplementationOnce(async (_url, init) => {
      originalId = JSON.parse(init.body).requestId;
      return response({ error: { code: 'upstream_unavailable' } }, 503);
    })
    .mockImplementationOnce(async () =>
      response({ ...overview, own: [{ ...receipt, id: originalId }] }),
    );
  await open();
  fireEvent.change(screen.getByLabelText('Ask for help from'), { target: { value: reviewer } });
  fireEvent.change(screen.getByLabelText('What happened?'), { target: { value: receipt.reason } });
  fireEvent.click(screen.getByRole('button', { name: 'Send recovery request' }));
  await screen.findByText(/Recovery request recorded/);
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  expect(screen.queryByRole('button', { name: 'Retry the same request' })).toBeNull();
});

it('allows correction after an authoritative refusal and an empty current read', async () => {
  fetchMock
    .mockResolvedValueOnce(response(overview))
    .mockResolvedValueOnce(response({ error: { code: 'recovery_request_refused' } }, 403))
    .mockResolvedValueOnce(response(overview));
  await open();
  fireEvent.change(screen.getByLabelText('Ask for help from'), { target: { value: reviewer } });
  fireEvent.change(screen.getByLabelText('What happened?'), { target: { value: receipt.reason } });
  fireEvent.click(screen.getByRole('button', { name: 'Send recovery request' }));
  await screen.findByText(/This request was refused/);
  expect((screen.getByLabelText('What happened?') as HTMLInputElement).disabled).toBe(false);
  expect(screen.queryByRole('button', { name: 'Retry the same request' })).toBeNull();
});
