import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import EstatePage from './page';
import EstateGraphPage from './graph/page';

const state = vi.hoisted(() => ({
  calls: [] as Array<[string, string, unknown]>,
  data: {} as Record<string, unknown>,
  errors: {} as Record<string, Error | null>,
}));
vi.mock('@/lib/tenant-context', () => ({ requireCapabilityContext: async () => ({
  tenantId: 'tenant-1', role: 'viewer', supabase: { from: (table: string) => {
    const result = () => ({ data: Object.hasOwn(state.data, table) ? state.data[table] : [], error: state.errors[table] ?? null });
    const query = {
      select: () => query,
      eq: (key: string, value: unknown) => { state.calls.push([table, key, value]); return query; },
      is: () => query,
      order: () => query,
      returns: async () => result(),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve),
    };
    return query;
  } },
}) }));
vi.mock('./estate-client', () => ({ EstateClient: (props: unknown) => <pre data-testid="estate-client">{JSON.stringify(props)}</pre> }));
vi.mock('./graph/estate-graph-client', () => ({ EstateGraph: (props: unknown) => <pre data-testid="estate-graph">{JSON.stringify(props)}</pre> }));
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
beforeEach(() => { state.calls = []; state.data = {}; state.errors = {}; });

it('keeps estate inventory tenant-bound and hides mutations for a viewer', async () => {
  const view = renderToStaticMarkup(await EstatePage());
  expect(view).toContain('&quot;canManage&quot;:false');
  expect(view).toContain('&quot;estates&quot;:[]');
  for (const table of ['estates', 'estate_systems', 'engagements']) {
    expect(state.calls).toContainEqual([table, 'tenant_id', 'tenant-1']);
  }
});

it('refuses partial inventory and graph projections on query errors', async () => {
  state.errors.estate_systems = new Error('read failed');
  const inventory = renderToStaticMarkup(await EstatePage());
  const graph = renderToStaticMarkup(await EstateGraphPage());
  expect(inventory).toContain('Estate inventory could not be loaded');
  expect(graph).toContain('estate graph could not be loaded');
  expect(inventory).not.toContain('data-testid="estate-client"');
  expect(graph).not.toContain('data-testid="estate-graph"');
});

it.each(['estates', 'estate_systems', 'engagements'])(
  'refuses a null-success %s estate inventory read', async (table) => {
    state.data[table] = null;
    const inventory = renderToStaticMarkup(await EstatePage());
    expect(inventory).toContain('Estate inventory could not be loaded');
    expect(inventory).not.toContain('data-testid="estate-client"');
  },
);

it.each(['estates', 'estate_systems', 'connectors', 'connector_grants'])(
  'refuses a null-success %s estate graph read', async (table) => {
    state.data[table] = null;
    const graph = renderToStaticMarkup(await EstateGraphPage());
    expect(graph).toContain('estate graph could not be loaded');
    expect(graph).not.toContain('data-testid="estate-graph"');
  },
);

it('derives graph categories and access only from tenant rows', async () => {
  state.data.estates = [{ id: 'estate-1', name: 'Registered estate', status: 'active' }];
  state.data.estate_systems = [{ id: 'system-1', estate_id: 'estate-1', name: 'Payroll', status: 'active',
    system_data_categories: [{ category_key: 'identity' }, { category_key: 'identity' }] }];
  state.data.connectors = [{ id: 'connector-1', system_id: 'system-1', name: 'Payroll access', status: 'active', assurance: 'registered' }];
  state.data.connector_grants = [];
  const view = renderToStaticMarkup(await EstateGraphPage());
  expect(view).toContain('Registered estate');
  expect(view).toContain('&quot;categories&quot;:[&quot;identity&quot;]');
  expect(view).toContain('&quot;grants&quot;:[]');
  for (const table of ['estates', 'estate_systems', 'connectors', 'connector_grants']) {
    expect(state.calls).toContainEqual([table, 'tenant_id', 'tenant-1']);
  }
});
