// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DismissAlertButton, DispatchAlertsButton } from './alert-actions';

const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
const alertId = '11111111-1111-4111-8111-111111111111';
beforeEach(() => refresh.mockReset());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('does not expose alert mutations without manage capability', () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  render(
    <>
      <DispatchAlertsButton tenantId="tenant-1" canManage={false} />
      <DismissAlertButton tenantId="tenant-1" alertId={alertId} canManage={false} />
    </>,
  );
  expect(screen.queryByRole('button')).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});

it('shows only a validated dispatch count from the selected tenant', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ data: { dispatchedCount: 2 } }));
  vi.stubGlobal('fetch', fetcher);
  render(<DispatchAlertsButton tenantId="tenant-1" canManage />);
  fireEvent.click(screen.getByRole('button', { name: /Scan & Dispatch Alerts/ }));
  await waitFor(() => expect(document.body.textContent).toContain('2 alert(s) dispatched'));
  expect(fetcher).toHaveBeenCalledWith(
    '/api/bff/v1/monitoring/alerts/dispatch',
    expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ 'X-Tenant-Id': 'tenant-1' }),
    }),
  );
  expect(refresh).toHaveBeenCalledOnce();
});

it('does not turn a malformed success body into a zero-dispatch claim', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ data: {} })));
  render(<DispatchAlertsButton tenantId="tenant-1" canManage />);
  fireEvent.click(screen.getByRole('button', { name: /Scan & Dispatch Alerts/ }));
  await waitFor(() =>
    expect(document.body.textContent).toContain('Could not confirm alert dispatch'),
  );
  expect(document.body.textContent).not.toContain('Scan complete: 0');
  expect(refresh).not.toHaveBeenCalled();
});

it('does not acknowledge a different alert or an unconfirmed result', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(Response.json({ data: { dismissed: true, alertId: 'other' } })),
  );
  render(<DismissAlertButton tenantId="tenant-1" alertId={alertId} canManage />);
  fireEvent.click(screen.getByRole('button', { name: 'Acknowledge alert' }));
  await waitFor(() =>
    expect(document.body.textContent).toContain('Could not confirm alert acknowledgement'),
  );
  expect(refresh).not.toHaveBeenCalled();
});

it('refreshes only after exact alert acknowledgement', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ data: { dismissed: true, alertId } }));
  vi.stubGlobal('fetch', fetcher);
  render(<DismissAlertButton tenantId="tenant-1" alertId={alertId} canManage />);
  fireEvent.click(screen.getByRole('button', { name: 'Acknowledge alert' }));
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(fetcher).toHaveBeenCalledWith(
    `/api/bff/v1/monitoring/alerts/${alertId}/dismiss`,
    expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ 'X-Tenant-Id': 'tenant-1' }),
    }),
  );
});
