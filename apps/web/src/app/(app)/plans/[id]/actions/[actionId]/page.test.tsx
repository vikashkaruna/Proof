// @vitest-environment jsdom
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';

/** Owner finding 2026-10-17: there was no way to view dry-run or rollback details. */

const PLAN = '553b611b-78a0-4b66-8999-566cbf2dcbb4';
const ACTION = '8ce5bf9b-c931-4053-ae2c-b3a88f656dec';
const RUN = '0c0f25ca-e7eb-473e-af96-7e6d5ff0887f';
const TENANT = 'fd5e0001-0000-4000-8000-000000000001';
const PARAMS_HASH = 'a'.repeat(64);
const ROLLBACK_HASH = 'b'.repeat(64);

const state = vi.hoisted(() => ({
  linked: true,
  runs: [] as unknown[],
  rollbacks: [] as unknown[],
}));

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
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
      supabase: {
        rpc: async () => ({
          data: {
            planId: PLAN,
            planStatus: 'review',
            planApprovable: true,
            approvableStatuses: ['draft', 'review', 'approved', 'cancelled'],
            evaluatedAt: '2026-10-17T18:00:00Z',
            actions: [
              {
                actionId: ACTION,
                sequence: 1,
                actionType: 'data.retention_purge',
                approvalStatus: 'awaiting_approval',
                executionStatus: 'draft',
                ready: state.linked,
                blockers: state.linked ? [] : ['no_recorded_dry_run'],
                rollbackValidated: true,
                rollbackValidatedAt: '2026-10-14T12:29:17Z',
                dryRun: state.linked
                  ? {
                      id: RUN,
                      status: 'succeeded',
                      refusalReason: null,
                      createdAt: '2026-10-17T04:30:00Z',
                      expiresAt: '2026-10-18T04:30:00Z',
                    }
                  : null,
              },
            ],
          },
          error: null,
        }),
        from: (table: string) => {
          const q: Record<string, unknown> = {};
          for (const m of ['select', 'eq', 'order', 'limit']) q[m] = () => q;
          q.maybeSingle = async () => ({
            data:
              table === 'remediation_plans'
                ? { id: PLAN, title: 'Retention and consent clean-up', status: 'review' }
                : {
                    id: ACTION,
                    plan_id: PLAN,
                    sequence: 1,
                    action_type: 'data.retention_purge',
                    description: 'Purge expired loan applications',
                    risk_class: 'high',
                    parameters: { dataset: 'loan_applications', olderThanMonths: 96 },
                    dry_run_status: 'dry_run_complete',
                    latest_dry_run_id: state.linked ? RUN : null,
                    rollback_definition: {
                      strategy: 'snapshot_restore',
                      steps: [{ op: 'restore_snapshot' }],
                      estimatedRollbackTimeSeconds: 120,
                    },
                    rollback_validated: true,
                    rollback_validated_at: '2026-10-14T12:29:17Z',
                    approval_status: 'awaiting_approval',
                    approved_at: null,
                  },
            error: null,
          });
          q.then = (r: (v: unknown) => unknown) =>
            Promise.resolve({
              data:
                table === 'dry_runs'
                  ? state.runs
                  : table === 'rollback_executions'
                    ? state.rollbacks
                    : [],
              error: null,
            }).then(r);
          return q;
        },
      },
    }),
  };
});

const run = {
  id: RUN,
  action_id: ACTION,
  status: 'succeeded',
  diff: { changes: [{ field: 'loan_applications · rows in scope', before: 4200, after: 0 }] },
  refusal_reason: null,
  renderable: true,
  parameters_hash: PARAMS_HASH,
  rollback_definition_hash: ROLLBACK_HASH,
  simulated_by: 'sudhaar',
  correlation_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  expires_at: '2026-10-18T04:30:00Z',
  created_at: '2026-10-17T04:30:00Z',
};

async function render(actionId = ACTION) {
  const { default: Page } = await import('./page');
  const html = renderToStaticMarkup(
    await Page({ params: Promise.resolve({ id: PLAN, actionId }) }),
  );
  return new DOMParser().parseFromString(html, 'text/html').body.textContent ?? '';
}

beforeEach(() => {
  state.linked = true;
  state.runs = [run];
  state.rollbacks = [];
});

it('shows the recorded run in full: outcome, hashes, diff and IST times', async () => {
  const text = await render();
  expect(text).toContain('Recorded · succeeded');
  expect(text).toContain(PARAMS_HASH);
  expect(text).toContain(ROLLBACK_HASH);
  expect(text).toContain('loan_applications · rows in scope');
  // 04:30 UTC is 10:00 in the default display zone (IST).
  expect(text).toMatch(/17 Oct 2026, 10:00 (IST|GMT\+5:30)/);
  expect(text).toContain('Every requirement is met.');
});

it('shows the rollback definition, validation and steps', async () => {
  const text = await render();
  expect(text).toContain('Validated');
  expect(text).toContain('snapshot_restore');
  expect(text).toContain('~120s');
  expect(text).toContain('restore_snapshot');
});

it('says plainly when the status field claims a run that is not on record', async () => {
  state.linked = false;
  state.runs = [];
  const text = await render();
  expect(text).toContain('Not recorded');
  expect(text).toContain('no dry run is recorded for this action');
  expect(text).toContain('No dry run is recorded for this action. A status saying');
  expect(text).not.toContain(PARAMS_HASH);
});

it('refuses a malformed id instead of querying', async () => {
  await expect(render('not-a-uuid')).rejects.toThrow('NEXT_NOT_FOUND');
});
