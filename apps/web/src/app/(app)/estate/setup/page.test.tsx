import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import EstateSetupPage from './page';

const state = vi.hoisted(() => ({
  calls: [] as Array<[string, string, unknown]>,
  rows: {} as Record<string, unknown>,
  errors: {} as Record<string, Error>,
}));
vi.mock('@/lib/tenant-context', () => ({
  requireCapabilityContext: async () => ({
    tenantId: 'tenant-1',
    role: 'viewer',
    supabase: {
      from: (table: string) => {
        const result = () => ({
          data: Object.hasOwn(state.rows, table)
            ? state.rows[table]
            : table === 'tenants'
              ? { is_sdf: false }
              : [],
          error: state.errors[table] ?? null,
        });
        const query = {
          select: () => query,
          eq: (key: string, value: unknown) => {
            state.calls.push([table, key, value]);
            return query;
          },
          in: () => query,
          order: () => query,
          maybeSingle: async () => result(),
          returns: async () => result(),
          then: (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve),
        };
        return query;
      },
    },
  }),
}));
vi.mock('./setup-wizard', () => ({
  SetupWizard: (props: unknown) => <pre data-testid="wizard">{JSON.stringify(props)}</pre>,
}));
vi.mock('./sustenance', () => ({
  GrantReview: (props: unknown) => <pre data-testid="grants">{JSON.stringify(props)}</pre>,
  ToolRegistry: (props: unknown) => <pre data-testid="tools">{JSON.stringify(props)}</pre>,
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
beforeEach(() => {
  state.calls = [];
  state.rows = {};
  state.errors = {};
});

it('uses only tenant inventory for categories, connector presence and active access targets', async () => {
  state.rows.estates = [{ id: 'estate-1', name: 'Recorded estate', status: 'active' }];
  state.rows.estate_systems = [
    {
      id: 'system-1',
      estate_id: 'estate-1',
      name: 'Payroll',
      status: 'active',
      system_data_categories: [
        { category_key: 'identity', source: 'declared' },
        { category_key: 'sensitive', source: 'inferred' },
      ],
    },
  ];
  state.rows.connectors = [
    { id: 'connector-1', name: 'Payroll', system_id: 'system-1', status: 'active' },
    { id: 'connector-2', name: 'Old', system_id: 'system-2', status: 'archived' },
  ];
  state.rows.workload_identities = [
    { id: 'workload-1', agent_name: 'drishti', spiffe_id: 'spiffe://agent', status: 'active' },
  ];
  const view = renderToStaticMarkup(await EstateSetupPage());
  for (const table of ['estates', 'estate_systems', 'connectors', 'workload_identities']) {
    expect(state.calls).toContainEqual([table, 'tenant_id', 'tenant-1']);
  }
  expect(state.calls).toContainEqual(['tenants', 'id', 'tenant-1']);
  expect(view).toContain('&quot;declaredCategories&quot;:[&quot;identity&quot;]');
  expect(view).toContain('&quot;hasConnector&quot;:true');
  expect(view).not.toContain('sensitive');
  expect(view).not.toContain('connector-2');
  expect(view).toContain('&quot;canManage&quot;:false');
});

it('refuses a partial setup read instead of displaying empty verified inventory', async () => {
  state.errors.estate_systems = new Error('read failed');
  const view = renderToStaticMarkup(await EstateSetupPage());
  expect(view).toContain('Onboarding data could not be loaded');
  expect(view).not.toContain('data-testid="wizard"');
  expect(view).not.toContain('data-testid="grants"');
});

it.each(['estates', 'estate_systems', 'connectors', 'workload_identities'])(
  'refuses a null-success %s setup read',
  async (table) => {
    state.rows[table] = null;
    const view = renderToStaticMarkup(await EstateSetupPage());
    expect(view).toContain('Onboarding data could not be loaded');
    expect(view).not.toContain('data-testid="wizard"');
    expect(view).not.toContain('data-testid="grants"');
    expect(view).not.toContain('data-testid="tools"');
  },
);
