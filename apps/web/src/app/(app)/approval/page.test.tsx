import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import ApprovalPage from './page';
import PlansPage from '../plans/page';

const state = vi.hoisted(() => ({
  actions: { data: [] as Record<string, unknown>[] | null, error: null as Error | null },
  plans: { data: [] as Record<string, unknown>[] | null, error: null as Error | null },
  calls: [] as Array<[string, string, unknown]>,
  capability: vi.fn(),
}));
vi.mock('@/lib/tenant-context', () => ({
  Capability: { PLAN_READ: 'plan.read' },
  requireCapabilityContext: state.capability,
}));
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));

beforeEach(() => {
  state.actions = { data: [], error: null };
  state.plans = { data: [], error: null };
  state.calls = [];
  state.capability.mockReset().mockImplementation(async () => ({
    tenantId: 'tenant-1',
    supabase: { from: (table: string) => {
      const query = {
        select: () => query,
        eq: (field: string, value: unknown) => { state.calls.push([table, field, value]); return query; },
        order: () => query,
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(table === 'remediation_actions' ? state.actions : state.plans).then(resolve),
      };
      return query;
    } },
  }));
});

it('shows empty approval and plan lists without demo actions or validated rollback claims', async () => {
  const approval = renderToStaticMarkup(await ApprovalPage());
  const plans = renderToStaticMarkup(await PlansPage());
  expect(approval).toContain('No recorded actions await approval.');
  expect(plans).toContain('No remediation plans recorded for this tenant.');
  for (const fiction of ['1,840', 'ACT-01', 'e-8841', 'PLAN-2026-0881', 'Rollback validated', '100%']) {
    expect(approval + plans).not.toContain(fiction);
  }
  expect(state.calls).toContainEqual(['remediation_actions', 'tenant_id', 'tenant-1']);
  expect(state.calls).toContainEqual(['remediation_plans', 'tenant_id', 'tenant-1']);
  expect(state.capability).toHaveBeenCalledWith('plan.read');
});

it('keeps query errors distinct from empty queues', async () => {
  state.actions = { data: null, error: new Error('read failed') };
  state.plans = { data: null, error: new Error('read failed') };
  expect(renderToStaticMarkup(await ApprovalPage())).toContain('Approval actions are unavailable');
  expect(renderToStaticMarkup(await PlansPage())).toContain('Plans are unavailable');
});

it('links a recorded awaiting action to its actual source plan', async () => {
  state.actions = { data: [{ id: 'action-1', plan_id: 'plan-1', description: 'Review backup policy', action_type: 'policy.update', approval_status: 'awaiting_approval', risk_class: 'high' }], error: null };
  const view = renderToStaticMarkup(await ApprovalPage());
  expect(view).toContain('Review backup policy');
  expect(view).toContain('href="/plans/plan-1"');
  expect(view).not.toContain('dry-run ✓');
});
