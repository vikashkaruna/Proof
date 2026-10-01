// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { VerifyButton } from './verify-button';

const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

beforeEach(() => {
  refresh.mockReset();
  vi.stubGlobal('alert', vi.fn());
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('sends verification within the selected tenant and reports an intact chain', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ intact: true }));
  vi.stubGlobal('fetch', fetcher);
  render(<VerifyButton tenantId="tenant-1" />);
  fireEvent.click(screen.getByRole('button', { name: 'Verify chain integrity' }));
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(fetcher).toHaveBeenCalledWith('/api/bff/v1/ledger/verify', {
    method: 'POST', headers: { 'X-Tenant-Id': 'tenant-1' },
  });
  expect(alert).toHaveBeenCalledWith(expect.stringContaining('Chain verified'));
});

it('reports a broken chain without claiming verification passed', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ intact: false, firstBreak: { sequenceNo: 9, reason: 'hash mismatch' } })));
  render(<VerifyButton tenantId="tenant-1" />);
  fireEvent.click(screen.getByRole('button', { name: 'Verify chain integrity' }));
  await waitFor(() => expect(alert).toHaveBeenCalledWith('Chain break at sequence 9: hash mismatch'));
  expect(alert).not.toHaveBeenCalledWith(expect.stringContaining('Chain verified'));
});

it('surfaces server refusal and does not refresh as if verification succeeded', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: { message: 'Tenant denied' } }, { status: 403 })));
  render(<VerifyButton tenantId="tenant-1" />);
  fireEvent.click(screen.getByRole('button', { name: 'Verify chain integrity' }));
  await waitFor(() => expect(alert).toHaveBeenCalledWith('Tenant denied'));
  expect(refresh).not.toHaveBeenCalled();
});
