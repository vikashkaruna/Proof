import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import PoliciesPage from './page';

const state = vi.hoisted(() => ({
  policies: { data: [] as Record<string, unknown>[] | null, error: null as Error | null },
  evaluations: { data: [] as Record<string, unknown>[] | null, error: null as Error | null },
  calls: [] as Array<[string, string, unknown]>,
  capability: vi.fn(),
}));
vi.mock('@/lib/tenant-context', () => ({ requireCapabilityContext: state.capability }));

beforeEach(() => {
  state.policies = { data: [], error: null };
  state.evaluations = { data: [], error: null };
  state.calls = [];
  state.capability.mockReset().mockImplementation(async () => ({
    tenantId: 'tenant-1', supabase: { from: (table: string) => {
      const query = {
        select: () => query,
        eq: (field: string, value: unknown) => { state.calls.push([table, field, value]); return query; },
        order: () => query, limit: () => query,
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(table === 'policy_evaluations' ? state.evaluations : state.policies).then(resolve),
      };
      return query;
    } },
  }));
});

it('shows no standing approval policies without inventing a policy decision', async () => {
  const view = renderToStaticMarkup(await PoliciesPage());
  expect(view).toContain('No standing policies');
  expect(view).toContain('No evaluations recorded');
  expect(state.calls).toContainEqual(['standing_approval_policies', 'tenant_id', 'tenant-1']);
  expect(state.calls).toContainEqual(['policy_evaluations', 'tenant_id', 'tenant-1']);
  expect(state.capability).toHaveBeenCalled();
});

it('renders a source error rather than treating it as a valid empty policy state', async () => {
  state.policies = { data: null, error: new Error('RLS refused') };
  const view = renderToStaticMarkup(await PoliciesPage());
  expect(view).toContain('Policy records could not be loaded');
  expect(view).not.toContain('No standing policies');
});

it('shows only recorded scope and approval identities', async () => {
  state.policies = { data: [{
    id: 'policy-1', name: 'Limited backup action', version: 2, scope: { action_types: ['backup.create'], environment: 'staging' }, status: 'active',
    created_by: 'author-1', approved_by: 'approver-1', expires_at: '2026-11-01T00:00:00Z', created_at: '2026-10-01T00:00:00Z',
  }], error: null };
  const view = renderToStaticMarkup(await PoliciesPage());
  expect(view).toContain('Limited backup action');
  expect(view).toContain('backup.create');
  expect(view).toContain('staging');
  expect(view).not.toContain('delete.records');
});
