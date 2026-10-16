// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { PublicWebsiteAssetInventory } from './public-website-asset-inventory';
const tenant = '11111111-1111-4111-8111-111111111111';
const actor = '22222222-2222-4222-8222-222222222222';
const estate = '33333333-3333-4333-8333-333333333333';
const system = '44444444-4444-4444-8444-444444444444';
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});
it('composes real inventory and console with uniquely addressable regions and usable estate/system controls', async () => {
  localStorage.clear();
  const row = { id: estate, tenant_id: tenant, name: 'Saved estate', status: 'active', version: 1 };
  const fetch = vi.fn(async (url: string) =>
    Response.json({
      data: url.endsWith('/estates')
        ? [row]
        : { ...row, systems: [{ ...row, id: system, estate_id: estate, name: 'Saved system' }] },
    }),
  );
  vi.stubGlobal('fetch', fetch);
  render(<PublicWebsiteAssetInventory tenantId={tenant} actorId={actor} canManage />);
  await screen.findByText(/Estate selection page 1 of 1/);
  // Same locator as the real browser: duplicate named regions must fail, not silently pick one.
  const console = screen.getByRole('region', {
    name: 'Registered public website targets',
  });
  expect(
    screen.getByRole('region', { name: 'Public website estate inventory' }).contains(console),
  ).toBe(true);
  expect(
    within(console).getByRole('heading', { name: 'Registered website operations', level: 3 }),
  ).toBeTruthy();
  const estateSelect = within(console).getByLabelText('Estate', { exact: true });
  const systemSelect = within(console).getByLabelText('System', { exact: true });
  fireEvent.change(estateSelect, { target: { value: estate } });
  fireEvent.change(systemSelect, { target: { value: system } });
  expect((estateSelect as HTMLSelectElement).value).toBe(estate);
  expect((systemSelect as HTMLSelectElement).value).toBe(system);
  expect(
    (
      within(console).getByRole('button', {
        name: 'Record selected website operation',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(fetch.mock.calls).toHaveLength(2);
});
