// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RunDryRunButton } from './run-dry-run-button';
const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  refresh.mockReset();
});
it('refreshes plan readiness for the actual dry-run array and summary response', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        Response.json({
          data: [{ actionId: 'a1', status: 'recorded', dryRunId: 'run1' }],
          summary: { requested: 1, recorded: 1, refused: 0, unavailable: 0 },
        }),
      ),
  );
  render(<RunDryRunButton planId="p1" tenantId="t1" />);
  fireEvent.click(screen.getByRole('button', { name: 'Run dry run' }));
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(screen.getByRole('status').textContent).toContain('Review the recorded results');
});
it('keeps an unconfirmed response retryable without claiming a recorded dry run', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ok: true })));
  render(<RunDryRunButton planId="p1" tenantId="t1" />);
  fireEvent.click(screen.getByRole('button', { name: 'Run dry run' }));
  await waitFor(() =>
    expect(screen.getByRole('status').textContent).toContain('Retry the same request'),
  );
  expect(refresh).not.toHaveBeenCalled();
});
