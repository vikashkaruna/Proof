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
  tenant: vi.fn(),
  role: 'approver' as string,
  scopes: [] as string[],
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error('REDIRECT ' + to);
  },
}));
vi.mock('@/lib/tenant-context', () => ({
  Capability: { PLAN_READ: 'plan.read', PLAN_APPROVE: 'plan.approve' },
  requireCapabilityContext: state.capability,
  requireTenantContext: state.tenant,
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

beforeEach(() => {
  state.actions = { data: [], error: null };
  state.plans = { data: [], error: null };
  state.calls = [];
  state.role = 'approver';
  state.scopes = [];
  state.tenant.mockReset().mockImplementation(async () => ({
    ...(await state.capability()),
    role: state.role,
    approvalScopes: state.scopes,
  }));
  state.capability.mockReset().mockImplementation(async () => ({
    tenantId: 'tenant-1',
    supabase: {
      rpc: async () => ({ data: [], error: null }),
      from: (table: string) => {
        const query = {
          select: () => query,
          eq: (field: string, value: unknown) => {
            state.calls.push([table, field, value]);
            return query;
          },
          order: () => query,
          then: (resolve: (value: unknown) => unknown) =>
            Promise.resolve(table === 'remediation_actions' ? state.actions : state.plans).then(
              resolve,
            ),
        };
        return query;
      },
    },
  }));
});

it('shows empty approval and plan lists without demo actions or validated rollback claims', async () => {
  const approval = renderToStaticMarkup(await ApprovalPage());
  const plans = renderToStaticMarkup(await PlansPage());
  expect(approval).toContain('No recorded actions await approval within your scope.');
  expect(plans).toContain('No remediation plans recorded for this tenant.');
  for (const fiction of [
    '1,840',
    'ACT-01',
    'e-8841',
    'PLAN-2026-0881',
    'Rollback validated',
    '100%',
  ]) {
    // Strip inline <style> blocks: the agent avatar animation CSS legitimately contains "100%".
    expect((approval + plans).replace(/<style>[\s\S]*?<\/style>/g, '')).not.toContain(fiction);
  }
  expect(state.calls).toContainEqual(['remediation_actions', 'tenant_id', 'tenant-1']);
  expect(state.calls).toContainEqual(['remediation_plans', 'tenant_id', 'tenant-1']);
  // The queue is guarded by the approver ROLE (scope is decided per action).
  expect(state.tenant).toHaveBeenCalled();
});

it('keeps query errors distinct from empty queues', async () => {
  state.actions = { data: null, error: new Error('read failed') };
  state.plans = { data: null, error: new Error('read failed') };
  expect(renderToStaticMarkup(await ApprovalPage())).toContain('Approval actions are unavailable');
  expect(renderToStaticMarkup(await PlansPage())).toContain('Plans are unavailable');
});

it('links a recorded awaiting action to its actual source plan', async () => {
  state.actions = {
    data: [
      {
        id: 'action-1',
        plan_id: 'plan-1',
        description: 'Review backup policy',
        action_type: 'policy.update',
        approval_status: 'awaiting_approval',
        risk_class: 'high',
      },
    ],
    error: null,
  };
  const view = renderToStaticMarkup(await ApprovalPage());
  expect(view).toContain('Review backup policy');
  expect(view).toContain('href="/plans/plan-1"');
  expect(view).not.toContain('dry-run ✓');
});

it('renders the shared module context line with the approval module id', async () => {
  const view = renderToStaticMarkup(await ApprovalPage());
  expect(view).toContain('अनुमोदन कतार');
  expect(view).toContain('M3.3');
  expect(view).not.toMatch(/<h1[^>]*>[^<]*अनुमोदन/);
});

it('admits a scoped approver and offers only actions within their scope', async () => {
  state.scopes = ['identity.deprovision'];
  state.actions = {
    data: [
      {
        id: 'a1',
        plan_id: 'p1',
        description: 'Remove stale account',
        action_type: 'identity.deprovision',
        risk_class: 'low',
      },
      {
        id: 'a2',
        plan_id: 'p1',
        description: 'Delete records',
        action_type: 'data-deletion',
        risk_class: 'high',
      },
    ],
    error: null,
  };
  const html = renderToStaticMarkup(await ApprovalPage());
  expect(html).toContain('Within your approval scope (identity.deprovision)');
  expect(html).not.toContain('Delete records');
  expect(html).not.toContain('Outside your approval scope');
});

it('shows no scope labels to an unscoped approver', async () => {
  state.actions = {
    data: [
      {
        id: 'a1',
        plan_id: 'p1',
        description: 'x',
        action_type: 'data-deletion',
        risk_class: 'low',
      },
    ],
    error: null,
  };
  const html = renderToStaticMarkup(await ApprovalPage());
  expect(html).not.toContain('approval scope');
});

it('still refuses a role that cannot approve', async () => {
  state.role = 'viewer';
  await expect(ApprovalPage()).rejects.toThrow('REDIRECT /portal?error=forbidden');
});
