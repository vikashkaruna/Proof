import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import DiscoveryPage from './page';
import ClassificationPage from '../classification/page';

const state = vi.hoisted(() => ({
  data: [] as Record<string, unknown>[] | null,
  error: null as Error | null,
  calls: [] as Array<[string, unknown]>,
}));
vi.mock('@/lib/tenant-context', () => ({
  requireTenantContext: async () => ({
    tenantId: 'tenant-1',
    supabase: {
      from: () => {
        const query = {
          select: () => query,
          eq: (field: string, value: unknown) => {
            state.calls.push([field, value]);
            return query;
          },
          order: () => query,
          limit: () => query,
          then: (resolve: (value: unknown) => unknown) =>
            Promise.resolve({ data: state.data, error: state.error }).then(resolve),
        };
        return query;
      },
    },
  }),
}));
vi.mock('../generic-module-view', () => ({
  GenericModuleView: ({ meta, children }: { meta: unknown; children: React.ReactNode }) => (
    <div>
      <pre>{JSON.stringify(meta)}</pre>
      {children}
    </div>
  ),
}));

beforeEach(() => {
  state.data = [];
  state.error = null;
  state.calls = [];
});

it('shows no invented discovery or classification metrics when the ledger is empty', async () => {
  const view =
    renderToStaticMarkup(await DiscoveryPage()) + renderToStaticMarkup(await ClassificationPage());
  expect(view).toContain('No discovery events recorded');
  expect(view).toContain('No classification events recorded');
  for (const fiction of [
    '12.4M',
    '8,210',
    '47 tables',
    '2,840',
    '3,906',
    'WORM Object Lock Compliance mode active',
  ]) {
    expect(view).not.toContain(fiction);
  }
  expect(state.calls).toContainEqual(['tenant_id', 'tenant-1']);
});

it('distinguishes source failure from empty results', async () => {
  state.data = null;
  state.error = new Error('read failed');
  expect(renderToStaticMarkup(await DiscoveryPage())).toContain(
    'Discovery ledger records are unavailable.',
  );
  expect(renderToStaticMarkup(await ClassificationPage())).toContain(
    'Classification ledger records are unavailable.',
  );
});

it('shows only actual recorded event fields', async () => {
  state.data = [
    {
      sequence_no: 7,
      correlation_id: 'corr-7',
      action_type: 'scan.started',
      target_ref: 'estate-7',
      occurred_at: '2026-10-01T00:00:00Z',
      entry_hash: 'abc',
      result: 'pending',
    },
  ];
  const view = renderToStaticMarkup(await DiscoveryPage());
  expect(view).toContain('scan.started');
  expect(view).toContain('estate-7');
  expect(view).toContain('pending');
  expect(view).not.toContain('✓ verified');
});
