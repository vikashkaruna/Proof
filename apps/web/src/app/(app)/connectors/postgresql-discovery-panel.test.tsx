// @vitest-environment jsdom
import React from 'react';
import { z } from 'zod';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PostgresqlDiscoveryPanel } from './postgresql-discovery-panel';
const id = (n: number) => `74740000-0000-4000-8000-${String(n).padStart(12, '0')}`;
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const row = {
  id: id(5),
  connector_id: id(2),
  estate_id: id(3),
  engagement_id: id(4),
  operation: 'enumerate',
  resource: null,
  status: 'completed',
  requested_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 120000).toISOString(),
  completed_at: new Date().toISOString(),
  cleanup_confirmed: true,
  error_code: null,
  discovery_run_id: id(6),
  result: {
    id: id(6),
    record_count: 1,
    result: [{ resource: 'public.synthetic', kind: 'table' }],
    created_at: new Date().toISOString(),
  },
};
function fixture(available = true) {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/engagements'))
      return Response.json({
        engagements: [{ id: id(4), title: 'Sandbox assessment', estate_id: id(3) }],
      });
    if (init?.method === 'POST')
      return Response.json({ data: { requestId: id(5), status: 'completed' } });
    return Response.json({ data: [row], available });
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
it('loads typed saved metadata and refreshes after a human request', async () => {
  const fetch = fixture();
  render(
    <PostgresqlDiscoveryPanel tenantId={id(1)} connectorId={id(2)} estateId={id(3)} canManage />,
  );
  await screen.findAllByText('public.synthetic');
  fireEvent.change(await screen.findByRole('combobox', { name: 'Sandbox assessment' }), {
    target: { value: id(4) },
  });
  fireEvent.click(screen.getByRole('button', { name: 'List sandbox tables' }));
  await screen.findByText('Discovery saved. Review the metadata below.');
  const post = fetch.mock.calls.find(([, init]) => init?.method === 'POST')?.[1];
  expect(post).toBeDefined();
  const submitted = z
    .object({ operationKey: z.uuid() })
    .passthrough()
    .parse(JSON.parse(String(post?.body)));
  expect(new Headers(post?.headers).get('Idempotency-Key')).toBe(submitted.operationKey);
  await waitFor(() =>
    expect(fetch.mock.calls.filter(([url]) => String(url).includes('/discovery')).length).toBe(3),
  );
});
it('viewer can read saved results and has no request controls', async () => {
  fixture();
  render(
    <PostgresqlDiscoveryPanel
      tenantId={id(1)}
      connectorId={id(2)}
      estateId={id(3)}
      canManage={false}
    />,
  );
  await screen.findAllByText('public.synthetic');
  expect(screen.queryByRole('button', { name: 'List sandbox tables' })).toBeNull();
  expect(screen.queryByRole('combobox')).toBeNull();
});
it('does not offer execution when the deployment controller is unavailable', async () => {
  fixture(false);
  render(
    <PostgresqlDiscoveryPanel tenantId={id(1)} connectorId={id(2)} estateId={id(3)} canManage />,
  );
  await screen.findByText(
    'Discovery execution is not configured in this deployment. Saved results remain available.',
  );
  expect(screen.queryByRole('button', { name: 'List sandbox tables' })).toBeNull();
});

it('shows expired pending requests as unconfirmed rather than claiming a live read', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith('/engagements')
        ? Response.json({ engagements: [] })
        : Response.json({
            data: [
              {
                ...row,
                status: 'claimed',
                expires_at: '2020-01-01T00:00:00Z',
                completed_at: null,
                cleanup_confirmed: null,
                result: null,
              },
            ],
            available: true,
          }),
    ),
  );
  render(
    <PostgresqlDiscoveryPanel tenantId={id(1)} connectorId={id(2)} estateId={id(3)} canManage />,
  );
  await screen.findByText(/Expired; completion not confirmed/);
  expect(screen.queryByText('Reading the sandbox')).toBeNull();
});
