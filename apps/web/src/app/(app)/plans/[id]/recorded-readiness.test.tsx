// @vitest-environment jsdom
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';

/**
 * Owner findings 2026-10-17 on the plan detail screen: "dry-run complete" next
 * to "No dry runs recorded yet"; an approved plan with no dry run; and an
 * approval journey that ended in "Plan is not ready for approval". The screen
 * now shows the recorded state, names each missing requirement, and does not
 * offer an approval the server would refuse.
 */

const PLAN = 'cb3c8ef4-8f3c-43fc-afca-ccc4b8bf598d';
const ACTION = '99816474-5185-42da-886f-3356008f9810';
const TENANT = 'fd5e0001-0000-4000-8000-000000000001';

const state = vi.hoisted(() => ({
  role: 'approver' as string,
  planStatus: 'approved',
  approvalStatus: 'approved',
  readiness: null as unknown,
  readinessError: null as unknown,
}));

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('not found');
  }),
  redirect: vi.fn(),
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('@/lib/tenant-context', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/tenant-context')>('@/lib/tenant-context');
  return {
    ...actual,
    requireCapabilityContext: async () => ({
      tenantId: TENANT,
      role: state.role,
      email: 'persona-approver@example.invalid',
      approvalScopes: [],
      isAxiomInternal: false,
      supabase: {
        rpc: async () => ({ data: state.readiness, error: state.readinessError }),
        from: (table: string) => {
          const q: Record<string, unknown> = {};
          for (const m of ['select', 'eq', 'order', 'limit']) q[m] = () => q;
          q.single = async () => ({
            data: {
              id: PLAN,
              title: 'Demo approval round 4',
              description: null,
              tenant_id: TENANT,
              version: 1,
              status: state.planStatus,
              library_version: '0.1.1',
              created_at: '2026-10-11T12:30:44Z',
              aggregate_blast_radius: null,
              tenants: { name: 'Kosha' },
              remediation_actions: [
                {
                  id: ACTION,
                  sequence: 1,
                  action_type: 'data.mask',
                  description: 'Mask customer email addresses',
                  risk_class: 'low',
                  risk_score: 15,
                  closes_finding_ids: [],
                  dry_run_status: 'dry_run_complete',
                  dry_run_completed_at: '2026-10-11T12:30:44Z',
                  dry_run_expires_at: '2026-12-10T12:30:44Z',
                  dry_run_result: { safety_checks_passed: true },
                  latest_dry_run_id: null,
                  rollback_validated: true,
                  rollback_validated_at: '2026-10-11T12:30:44Z',
                  rollback_definition: { estimatedRollbackTimeSeconds: 60 },
                  approval_status: state.approvalStatus,
                  approved_at: '2026-10-17T16:30:13Z',
                  execution_status: 'draft',
                  blast_radius: null,
                },
              ],
            },
            error: null,
          });
          q.maybeSingle = async () => ({ data: null, error: null });
          q.then = (r: (v: unknown) => unknown) =>
            Promise.resolve({ data: table === 'dry_runs' ? [] : [], error: null }).then(r);
          return q;
        },
      },
    }),
  };
});

const readinessFor = (over: Record<string, unknown> = {}) => ({
  planId: PLAN,
  planStatus: state.planStatus,
  planApprovable: ['draft', 'review', 'approved', 'cancelled'].includes(state.planStatus),
  approvableStatuses: ['draft', 'review', 'approved', 'cancelled'],
  evaluatedAt: '2026-10-17T18:00:00Z',
  actions: [
    {
      actionId: ACTION,
      sequence: 1,
      actionType: 'data.mask',
      approvalStatus: state.approvalStatus,
      executionStatus: 'draft',
      ready: false,
      blockers: ['no_recorded_dry_run'],
      rollbackValidated: true,
      rollbackValidatedAt: '2026-10-11T12:30:44Z',
      dryRun: null,
      ...over,
    },
  ],
});

async function render() {
  const { default: PlanDetailPage } = await import('./page');
  const html = renderToStaticMarkup(
    await PlanDetailPage({ params: Promise.resolve({ id: PLAN }) }),
  );
  return new DOMParser().parseFromString(html, 'text/html');
}

beforeEach(() => {
  state.role = 'approver';
  state.planStatus = 'approved';
  state.approvalStatus = 'approved';
  state.readinessError = null;
  state.readiness = readinessFor();
});

it('shows the recorded state, not the cache, when no run is recorded', async () => {
  const doc = await render();
  const text = doc.body.textContent ?? '';
  expect(text).toContain('Not recorded');
  expect(text).toContain('The status field says “dry-run complete”, but no run is recorded.');
  expect(text).not.toContain('Dry-Run Complete');
  expect(text).toContain('No dry run is recorded for this action.');
  // The cache must not make the action selectable for approval.
  expect(text).toContain('0 of 0 eligible selected');
});

it('flags an approval that has no recorded dry run behind it', async () => {
  const doc = await render();
  expect(doc.body.textContent).toContain('1 approved action(s) have no recorded dry run.');
  expect(doc.body.textContent).toContain('Approved without a recorded dry run.');
});

it('links each action to its dry-run and rollback detail', async () => {
  const doc = await render();
  const link = [...doc.querySelectorAll('a')].find((a) =>
    a.textContent?.includes('View dry-run & rollback details'),
  );
  expect(link?.getAttribute('href')).toBe(`/plans/${PLAN}/actions/${ACTION}`);
});

it('does not offer approval for a plan whose status rules it out, and says why', async () => {
  state.planStatus = 'partial_failure';
  state.readiness = readinessFor({ blockers: ['already_executed'], dryRun: null });
  const doc = await render();
  const text = doc.body.textContent ?? '';
  expect(text).toContain('Not open for approval.');
  expect(text).toContain('"partial failure"');
  expect(
    [...doc.querySelectorAll('button')].some((b) => /^Approve/.test(b.textContent ?? '')),
  ).toBe(false);
});

it('offers approval only for an action the readiness marks ready', async () => {
  state.planStatus = 'review';
  state.approvalStatus = 'awaiting_approval';
  state.readiness = readinessFor({
    ready: true,
    blockers: [],
    dryRun: {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      status: 'succeeded',
      refusalReason: null,
      createdAt: '2026-10-17T10:00:00Z',
      expiresAt: '2026-10-18T10:00:00Z',
    },
  });
  const doc = await render();
  expect(doc.body.textContent).toContain('Recorded · succeeded');
  expect(
    [...doc.querySelectorAll('button')].some((b) => b.textContent === 'Approve 1 action'),
  ).toBe(true);
});

it('fails closed when readiness cannot be read', async () => {
  state.planStatus = 'review';
  state.readinessError = { message: 'unavailable' };
  const doc = await render();
  expect(doc.body.textContent).toContain('Approval readiness is unavailable.');
  expect(
    [...doc.querySelectorAll('button')].some((b) => /^Approve/.test(b.textContent ?? '')),
  ).toBe(false);
});

it('offers a dry-run request to a plan author when an unapproved action is blocked', async () => {
  state.approvalStatus = 'awaiting_approval';
  state.readiness = readinessFor();
  state.role = 'owner';
  expect((await render()).querySelector('[data-testid="run-dry-run"]')?.textContent).toContain(
    'Run dry run',
  );
  // An approver approves; requesting the simulation is the author's step.
  state.role = 'approver';
  expect((await render()).querySelector('[data-testid="run-dry-run"]')).toBeNull();
  // Approved content is frozen: nothing left to dry-run.
  state.role = 'owner';
  state.approvalStatus = 'approved';
  state.readiness = readinessFor();
  expect((await render()).querySelector('[data-testid="run-dry-run"]')).toBeNull();
});
