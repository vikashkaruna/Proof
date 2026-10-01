import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import ConnectorsPage from './page';

const state = vi.hoisted(() => ({ errors: {} as Record<string, Error | null>, rows: {} as Record<string, unknown>, calls: [] as Array<[string, string, unknown]> }));
vi.mock('@/lib/tenant-context', () => ({ requireCapabilityContext: async () => ({
  tenantId: 'tenant-1', role: 'viewer', supabase: { from: (table: string) => {
    const query = {
      select: () => query,
      eq: (key: string, value: unknown) => { state.calls.push([table, key, value]); return query; },
      order: () => query,
      limit: () => query,
      returns: async () => ({ data: Object.hasOwn(state.rows, table) ? state.rows[table] : [], error: state.errors[table] ?? null }),
    };
    return query;
  } },
}) }));
vi.mock('./connectors-client', () => ({ ConnectorsClient: ({ tenantId, canManage }: { tenantId: string; canManage: boolean }) => <p>Client {tenantId} manage {String(canManage)}</p> }));
beforeEach(() => { state.errors = {}; state.rows = {}; state.calls = []; });

it('binds both inventories to the active tenant and keeps a viewer read-only', async () => {
  const view = renderToStaticMarkup(await ConnectorsPage());
  expect(view).toContain('Client tenant-1 manage false');
  expect(state.calls).toContainEqual(['connectors', 'tenant_id', 'tenant-1']);
  expect(state.calls).toContainEqual(['estate_systems', 'tenant_id', 'tenant-1']);
  expect(view).toContain('Connector execution is not yet available');
});

it('refuses to render a partial inventory when either query fails', async () => {
  state.errors.estate_systems = new Error('read failed');
  const view = renderToStaticMarkup(await ConnectorsPage());
  expect(view).toContain('Connector inventory could not be loaded');
  expect(view).not.toContain('Client tenant-1');
});

it.each(['connectors', 'estate_systems'])(
  'refuses a null-success %s inventory read', async (table) => {
    state.rows[table] = null;
    const view = renderToStaticMarkup(await ConnectorsPage());
    expect(view).toContain('Connector inventory could not be loaded');
    expect(view).not.toContain('Client tenant-1');
  },
);
