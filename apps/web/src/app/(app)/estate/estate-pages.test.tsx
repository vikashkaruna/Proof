import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import EstatePage from './page';
import EstateGraphPage from './graph/page';

const state = vi.hoisted(() => ({
  calls: [] as Array<[string, string, unknown]>,
  data: {} as Record<string, unknown>,
  errors: {} as Record<string, Error | null>,
  projections: [] as Array<[string, string]>,
  tenantId: 'tenant-1',
}));
vi.mock('@/lib/tenant-context', () => ({
  requireCapabilityContext: async () => ({
    tenantId: state.tenantId,
    role: 'viewer',
    supabase: {
      from: (table: string) => {
        const result = () => ({
          data: Object.hasOwn(state.data, table) ? state.data[table] : [],
          error: state.errors[table] ?? null,
        });
        const query = {
          select: (value: string) => {
            state.projections.push([table, value]);
            return query;
          },
          limit: () => query,
          in: () => query,
          abortSignal: () => query,
          eq: (key: string, value: unknown) => {
            state.calls.push([table, key, value]);
            return query;
          },
          is: () => query,
          order: () => query,
          returns: async () => result(),
          then: (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve),
        };
        return query;
      },
    },
  }),
}));
vi.mock('./estate-client', () => ({
  EstateClient: (props: unknown) => <pre data-testid="estate-client">{JSON.stringify(props)}</pre>,
}));
vi.mock('./graph/estate-graph-client', () => ({
  EstateGraph: (props: unknown) => <pre data-testid="estate-graph">{JSON.stringify(props)}</pre>,
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
beforeEach(() => {
  state.tenantId = 'tenant-1';
  state.calls = [];
  state.data = {};
  state.errors = {};
  state.projections = [];
});

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
  'refuses a null-success %s estate inventory read',
  async (table) => {
    state.data[table] = null;
    const inventory = renderToStaticMarkup(await EstatePage());
    expect(inventory).toContain('Estate inventory could not be loaded');
    expect(inventory).not.toContain('data-testid="estate-client"');
  },
);

it.each(['estates', 'estate_systems', 'connectors', 'connector_grants'])(
  'refuses a null-success %s estate graph read',
  async (table) => {
    state.data[table] = null;
    const graph = renderToStaticMarkup(await EstateGraphPage());
    expect(graph).toContain('estate graph could not be loaded');
    expect(graph).not.toContain('data-testid="estate-graph"');
  },
);

it('derives graph categories and access only from tenant rows', async () => {
  state.data.estates = [{ id: 'estate-1', name: 'Registered estate', status: 'active' }];
  state.data.estate_systems = [
    {
      id: 'system-1',
      estate_id: 'estate-1',
      name: 'Payroll',
      status: 'active',
      system_data_categories: [{ category_key: 'identity' }, { category_key: 'identity' }],
    },
  ];
  state.data.connectors = [
    {
      id: 'connector-1',
      system_id: 'system-1',
      name: 'Payroll access',
      status: 'active',
      assurance: 'registered',
    },
  ];
  state.data.connector_grants = [];
  const view = renderToStaticMarkup(await EstateGraphPage());
  expect(view).toContain('Registered estate');
  expect(view).toContain('&quot;categories&quot;:[&quot;identity&quot;]');
  expect(view).toContain('&quot;grants&quot;:[]');
  for (const table of ['estates', 'estate_systems', 'connectors', 'connector_grants']) {
    expect(state.calls).toContainEqual([table, 'tenant_id', 'tenant-1']);
  }
});

it('loads only bounded allowlisted provenance with the current user tenant and no raw intake/config/actor payloads', async () => {
  state.data.onboarding_proposals = [];
  const html = renderToStaticMarkup(await EstateGraphPage());
  expect(html).toContain('estate-graph');
  expect(state.calls).toContainEqual(['onboarding_proposals', 'tenant_id', 'tenant-1']);
  const select = state.projections.find(([table]) => table === 'onboarding_proposals')?.[1];
  expect(select).toBe(
    'id,tenant_id,estate_id,content_sha256,status,reviewed_at,onboarding_proposal_systems(tenant_id,proposal_id,source_index,system_id)',
  );
  expect(select).not.toMatch(
    /source_snapshot|estate_snapshot|prepared_by|reviewed_by|review_reason|description|external_ref/,
  );
});
it('keeps the existing graph when provenance reads fail and preserves actual category origins', async () => {
  state.data.estates = [{ id: 'estate-1', name: 'Estate', status: 'active' }];
  state.data.estate_systems = [
    {
      id: 'system-1',
      estate_id: 'estate-1',
      name: 'System',
      status: 'active',
      system_data_categories: [
        { category_key: 'contact', source: 'observed' },
        { category_key: 'identity', source: 'declared' },
        { category_key: 'other', source: 'unexpected' },
      ],
    },
  ];
  state.errors.onboarding_proposals = new Error('Source unavailable');
  const html = renderToStaticMarkup(await EstateGraphPage());
  expect(html).toContain('estate-graph');
  expect(html).toContain('&quot;source&quot;:&quot;observed&quot;');
  expect(html).toContain('&quot;source&quot;:&quot;declared&quot;');
  expect(html).toContain('&quot;source&quot;:&quot;unknown&quot;');
  expect(html).toContain('&quot;state&quot;:&quot;unavailable&quot;');
});

it('retains only matched approved review metadata while ledger JSON-path selectors exclude private details', async () => {
  const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  state.tenantId = id(1);
  state.data.estates = [{ id: id(2), name: 'Estate', status: 'active' }];
  state.data.estate_systems = [
    { id: id(3), estate_id: id(2), name: 'System', status: 'active', system_data_categories: [] },
  ];
  state.data.onboarding_proposals = [
    {
      id: id(4),
      tenant_id: id(1),
      estate_id: id(2),
      content_sha256: 'a'.repeat(64),
      status: 'approved',
      reviewed_at: '2026-10-19T00:00:00Z',
      onboarding_proposal_systems: [
        { tenant_id: id(1), proposal_id: id(4), source_index: 0, system_id: id(3) },
      ],
    },
  ];
  state.data.audit_ledger = [
    {
      id: '123',
      tenant_id: id(1),
      target_ref: id(4),
      actor_type: 'human',
      action_type: 'onboarding.proposal.approved',
      result: 'success',
      occurred_at: '2026-10-19T00:00:00Z',
      commitment: 'a'.repeat(64),
      system_ids: [id(3)],
    },
  ];
  const html = renderToStaticMarkup(await EstateGraphPage());
  expect(html).toContain('&quot;reviewReceiptId&quot;:&quot;123&quot;');
  expect(html).toContain('&quot;sourceHref&quot;:null');
  expect(state.calls).toContainEqual(['audit_ledger', 'tenant_id', id(1)]);
  const projection = state.projections.find(([t]) => t === 'audit_ledger')?.[1];
  expect(projection).toBe(
    'id,tenant_id,target_ref,actor_type,action_type,result,occurred_at,commitment:detail->>contentSha256,system_ids:detail->systemIds',
  );
  expect(projection).not.toMatch(/actor_id|preparedBy|reason|snapshot/);
});
