// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  PublicWebsiteAssetInventory,
  loadWebsiteAssetInventory,
} from './public-website-asset-inventory';
const tenant = '11111111-1111-4111-8111-111111111111',
  actor = '22222222-2222-4222-8222-222222222222',
  estate = '33333333-3333-4333-8333-333333333333',
  system = '44444444-4444-4444-8444-444444444444';
const row = { id: estate, tenant_id: tenant, name: 'Saved estate', status: 'active', version: 3 };
vi.mock('./public-website-asset-console', () => ({
  PublicWebsiteAssetConsole: ({
    inventory,
    canManage,
  }: {
    inventory: { systems: Array<{ name: string; version: number }> };
    canManage: boolean;
  }) => (
    <p>
      Console manage {String(canManage)}{' '}
      {inventory.systems.map((s) => s.name + ' version ' + s.version).join(',')}
    </p>
  ),
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function fixture(change: Record<string, unknown> = {}) {
  const fetch = vi.fn(async (url: string, options?: RequestInit) => {
    expect(options?.headers).toEqual({ 'X-Tenant-Id': tenant });
    return Response.json({
      data: url.endsWith('/estates')
        ? [row]
        : {
            ...row,
            systems: [{ ...row, id: system, estate_id: estate, name: 'Saved system', version: 7 }],
            ...change,
          },
    });
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
it('uses real v1 estate API and retained versions, defaulting to no mutation authority', async () => {
  const fetch = fixture();
  render(<PublicWebsiteAssetInventory tenantId={tenant} actorId={actor} />);
  expect(screen.getByRole('status').textContent).toContain('Loading');
  expect(
    (await screen.findByText('Console manage false Saved system version 7')).textContent,
  ).toContain('version 7');
  expect(fetch.mock.calls.map((c) => c[0])).toEqual([
    '/api/bff/v1/estates',
    '/api/bff/v1/estates/' + estate,
  ]);
});
it.each([
  { tenant_id: actor },
  { version: 4 },
  { systems: [{ ...row, id: system, estate_id: actor }] },
])('refuses foreign or changed inventory %j', async (change) => {
  fixture(change);
  render(<PublicWebsiteAssetInventory tenantId={tenant} actorId={actor} canManage />);
  expect((await screen.findByRole('alert')).textContent).toContain('could not be verified');
  expect(screen.queryByText(/Console manage/)).toBeNull();
});
it('shows actual empty inventory only after a successful read and retries failed reads', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response('', { status: 503 }))
    .mockResolvedValue(Response.json({ data: [] }));
  vi.stubGlobal('fetch', fetch);
  render(<PublicWebsiteAssetInventory tenantId={tenant} actorId={actor} />);
  await screen.findByRole('alert');
  expect(screen.queryByText(/No saved estates/)).toBeNull();
  fireEvent.click(screen.getByText('Refresh saved estate inventory'));
  expect(await screen.findByText(/No saved estates/)).toBeTruthy();
});
it('loads bounded estate pages instead of silently dropping later estates', async () => {
  const estates = Array.from({ length: 11 }, (_, i) => ({
    ...row,
    id: '33333333-3333-4333-8333-' + String(i + 1).padStart(12, '0'),
  }));
  const fetch = vi.fn(async (url: string) =>
    Response.json({
      data: url.endsWith('/estates')
        ? estates
        : { ...estates.find((e) => url.endsWith(e.id)), systems: [] },
    }),
  );
  vi.stubGlobal('fetch', fetch);
  render(<PublicWebsiteAssetInventory tenantId={tenant} actorId={actor} />);
  await screen.findByText(/Estate selection page 1 of 2/);
  expect(fetch).toHaveBeenCalledTimes(11);
  fireEvent.click(screen.getByText('Next estate page'));
  await screen.findByText(/Estate selection page 2 of 2/);
  expect(fetch).toHaveBeenCalledTimes(13);
});
it('does not publish a late old-tenant inventory after organisation switch', async () => {
  let release: ((response: Response) => void) | undefined;
  const fetch = vi.fn((url: string, options?: RequestInit) => {
    const selected = (options?.headers as Record<string, string>)['X-Tenant-Id'];
    if (selected === tenant)
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    return Promise.resolve(Response.json({ data: [] }));
  });
  vi.stubGlobal('fetch', fetch);
  const view = render(<PublicWebsiteAssetInventory tenantId={tenant} actorId={actor} />);
  view.rerender(<PublicWebsiteAssetInventory tenantId={actor} actorId={actor} />);
  await screen.findByText(/No saved estates/);
  release?.(Response.json({ data: [row] }));
  await Promise.resolve();
  expect(screen.queryByText(/Saved system/)).toBeNull();
  expect(fetch.mock.calls.filter((c) => c[0].includes('/estates/'))).toHaveLength(0);
});
it.each([null, { data: null }, { data: [{ ...row, version: 0 }] }])(
  'refuses malformed inventory instead of pretending it is empty: %j',
  async (body) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(body)),
    );
    await expect(
      loadWebsiteAssetInventory(tenant, 0, new AbortController().signal),
    ).rejects.toThrow();
  },
);
