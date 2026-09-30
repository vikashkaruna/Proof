import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import ExecutionPage from './page';

const state = vi.hoisted(() => ({
  results: {} as Record<string, { data: unknown[] | null; error: Error | null }>,
  calls: [] as Array<[string, string, unknown]>,
  capability: vi.fn(),
}));
vi.mock('@/lib/tenant-context', () => ({ requireCapabilityContext: state.capability }));
vi.mock('./batch-card', () => ({ BatchCard: ({ detail }: { detail: { batch: { id: string }; actions: unknown[]; reconciliation: unknown } }) => <div>Batch {detail.batch.id}: {detail.actions.length} actions; reconciliation {detail.reconciliation ? 'recorded' : 'absent'}</div> }));
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));

beforeEach(() => {
  state.results = {};
  state.calls = [];
  state.capability.mockReset().mockImplementation(async () => ({
    tenantId: 'tenant-1', supabase: { from: (table: string) => {
      const query = {
        select: () => query,
        eq: (field: string, value: unknown) => { state.calls.push([table, field, value]); return query; },
        in: (field: string, value: unknown) => { state.calls.push([table, field, value]); return query; },
        order: () => query, limit: () => query,
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(state.results[table] ?? { data: [], error: null }).then(resolve),
      };
      return query;
    } },
  }));
});

it('shows a truthful empty execution history without simulated outcomes', async () => {
  const view = renderToStaticMarkup(await ExecutionPage());
  expect(view).toContain('No execution batches yet');
  expect(view).not.toContain('Batch fake');
  expect(state.calls).toContainEqual(['execution_batches', 'tenant_id', 'tenant-1']);
  expect(state.capability).toHaveBeenCalled();
});

it('refuses partial details instead of treating missing reconciliations as absent', async () => {
  state.results.execution_batches = { data: [{ id: 'batch-1', status: 'completed' }], error: null };
  state.results.plan_reconciliations = { data: null, error: new Error('read refused') };
  const view = renderToStaticMarkup(await ExecutionPage());
  expect(view).toContain('outcome details could not be loaded');
  expect(view).not.toContain('Batch batch-1');
});

it('groups recorded actions and reconciliation only within the selected tenant batch', async () => {
  state.results.execution_batches = { data: [{ id: 'batch-1', status: 'completed' }], error: null };
  state.results.remediation_actions = { data: [{ id: 'action-1', execution_batch_id: 'batch-1', final_outcome: 'succeeded' }], error: null };
  state.results.plan_reconciliations = { data: [{ id: 'reconciliation-1', batch_id: 'batch-1' }], error: null };
  const view = renderToStaticMarkup(await ExecutionPage());
  expect(view).toContain('Batch batch-1: 1 actions; reconciliation recorded');
  expect(state.calls).toContainEqual(['remediation_actions', 'tenant_id', 'tenant-1']);
  expect(state.calls).toContainEqual(['plan_reconciliations', 'batch_id', ['batch-1']]);
});
