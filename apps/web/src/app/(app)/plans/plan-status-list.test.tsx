// @vitest-environment jsdom
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';

/** Owner finding 2026-10-17 (c): the list should show approval, dry-run and rollback status. */

const PLAN = '553b611b-78a0-4b66-8999-566cbf2dcbb4';
const state = vi.hoisted(() => ({ summaries: [] as unknown, error: null as unknown }));

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('./proposal-panel', () => ({ ProposalPanel: () => null }));
vi.mock('./owned-target-panel', () => ({ OwnedTargetPanel: () => null }));
vi.mock('@/lib/tenant-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tenant-context')>()),
  requireCapabilityContext: async () => ({
    tenantId: 'fd5e0001-0000-4000-8000-000000000001',
    userId: 'fd5e0001-0000-4000-8000-000000000002',
    role: 'approver',
    supabase: {
      rpc: async () => ({ data: state.summaries, error: state.error }),
      from: () => {
        const q: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'neq', 'order', 'limit']) q[m] = () => q;
        q.then = (r: (v: unknown) => unknown) =>
          Promise.resolve({
            data: [
              {
                id: PLAN,
                title: 'Retention and consent clean-up — lending',
                status: 'approved',
                version: 1,
                created_at: '2026-10-08T12:29:17Z',
                library_version: '0.1.1',
                purpose: 'remediation',
              },
            ],
            error: null,
          }).then(r);
        return q;
      },
    },
  }),
}));

async function render() {
  const { default: Page } = await import('./page');
  const html = renderToStaticMarkup(await Page());
  return new DOMParser().parseFromString(html, 'text/html').body.textContent ?? '';
}

beforeEach(() => {
  state.error = null;
  state.summaries = [
    {
      plan_id: PLAN,
      action_count: 3,
      approved_actions: 3,
      ready_actions: 3,
      recorded_dry_runs: 3,
      succeeded_dry_runs: 3,
      refused_or_failed_dry_runs: 0,
      unrecorded_dry_runs: 0,
      expired_dry_runs: 0,
      rollbacks_validated: 3,
      last_approved_at: '2026-10-17T16:40:57.562939+00:00',
      last_rejected_at: null,
    },
  ];
});

it('shows approval, recorded dry-run and rollback status with the decision time in IST', async () => {
  const text = await render();
  expect(text).toContain('approved · 3/3 actions approved');
  expect(text).toContain('3/3 succeeded');
  expect(text).toContain('3/3 validated');
  // 16:40 UTC is 22:10 IST.
  expect(text).toMatch(/17 Oct 2026, 22:10 (IST|GMT\+5:30)/);
  expect(text).toContain('Rejected at—');
});

it('says "None recorded" for a plan whose only evidence is the status field', async () => {
  state.summaries = [
    {
      ...(state.summaries as Record<string, unknown>[])[0],
      action_count: 1,
      recorded_dry_runs: 0,
      succeeded_dry_runs: 0,
      unrecorded_dry_runs: 1,
    },
  ];
  expect(await render()).toContain('None recorded');
});

it('does not infer status when the summary cannot be read', async () => {
  state.error = { message: 'unavailable' };
  expect(await render()).toContain(
    'Approval, dry-run and rollback status are unavailable for this plan.',
  );
});
