// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DataFlowAvailability } from './flow-availability';
import { requestDataFlow } from './flow-transport';
import { id } from './flow.test-fixture';
vi.mock('./flow-transport', () => ({ requestDataFlow: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
it.each([false, true])(
  'uses actual authenticated deployment flag %s, never role alone',
  async (enabled) => {
    vi.mocked(requestDataFlow).mockResolvedValue({
      data: { tenantId: id(3), actorId: id(1), enabled, metadataOnly: true },
    });
    render(<DataFlowAvailability tenantId={id(3)} actorId={id(1)} />);
    await waitFor(() => expect(requestDataFlow).toHaveBeenCalled());
    if (enabled) await screen.findByRole('link', { name: /Inspect reviewed/ });
    else expect(screen.queryByRole('link')).toBeNull();
  },
);
it('foreign or unavailable configuration cannot advertise the declaration path', async () => {
  vi.mocked(requestDataFlow).mockResolvedValue({
    data: { tenantId: id(99), actorId: id(1), enabled: true, metadataOnly: true },
  });
  render(<DataFlowAvailability tenantId={id(3)} actorId={id(1)} />);
  await waitFor(() => expect(requestDataFlow).toHaveBeenCalled());
  expect(screen.queryByRole('link')).toBeNull();
});
