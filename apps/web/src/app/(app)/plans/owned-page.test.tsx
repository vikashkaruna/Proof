import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import type { UserRole } from '@axiom/types';
const state = vi.hoisted(() => ({
  role: 'owner' as UserRole,
  calls: [] as [string, string, unknown][],
  error: false,
}));
vi.mock('@/lib/tenant-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tenant-context')>()),
  requireCapabilityContext: async () => ({
    tenantId: '89180000-0000-4000-8000-000000000001',
    userId: '89180000-0000-4000-8000-000000000002',
    role: state.role,
    supabase: {
      rpc: async () => ({ data: [], error: null }),
      from: (table: string) => {
        const q = {
          select: () => q,
          eq: (key: string, value: unknown) => {
            state.calls.push([table, key, value]);
            return q;
          },
          neq: () => q,
          order: () => q,
          limit: () => q,
          then: (resolve: (value: unknown) => unknown) =>
            Promise.resolve({
              data:
                table === 'engagements'
                  ? [
                      {
                        id: '89180000-0000-4000-8000-000000000003',
                        title: 'Registered owned fixture engagement',
                      },
                    ]
                  : [],
              error:
                table === 'engagements' && state.error ? new Error('source unavailable') : null,
            }).then(resolve),
        };
        return q;
      },
    },
  }),
}));
vi.mock('./proposal-panel', () => ({ ProposalPanel: () => null }));
vi.mock('./owned-target-panel', () => ({
  OwnedTargetPanel: ({
    canCreate,
    engagements,
  }: {
    canCreate: boolean;
    engagements: { id: string; title: string }[];
  }) =>
    canCreate ? (
      <div data-owned-panel>
        {engagements.map((e) => (
          <span key={e.id}>{e.title}</span>
        ))}
      </div>
    ) : null,
}));
import Page from './page';
beforeEach(() => {
  state.calls = [];
  state.error = false;
  state.role = 'owner';
  vi.stubEnv('AXIOM_OWNED_SYNTHETIC_ENABLED', 'true');
  vi.stubEnv('ENVIRONMENT', 'local');
  vi.stubEnv('AXIOM_AUTH_MODE', 'strict');
});
afterEach(() => vi.unstubAllEnvs());
it('normal tenant page composes the owned panel with only bounded current tenant engagement choices', async () => {
  const html = renderToStaticMarkup(await Page());
  expect(html).toContain('data-owned-panel');
  expect(html).toContain('Registered owned fixture engagement');
  expect(state.calls).toContainEqual([
    'engagements',
    'tenant_id',
    '89180000-0000-4000-8000-000000000001',
  ]);
});
it.each(['viewer', 'approver', 'reviewer'] as const)(
  'role%s lacks owned plan-creation controls and source lookup',
  async (role) => {
    state.role = role;
    const html = renderToStaticMarkup(await Page());
    expect(html).not.toContain('data-owned-panel');
    expect(state.calls.some(([table]) => table === 'engagements')).toBe(false);
  },
);
it.each(['staging', 'preprod', 'production', 'onprem'])(
  'owned target UI stays absent outside local/test: %s',
  async (environment) => {
    vi.stubEnv('ENVIRONMENT', environment);
    expect(renderToStaticMarkup(await Page())).not.toContain('data-owned-panel');
    expect(state.calls.some(([table]) => table === 'engagements')).toBe(false);
  },
);
it('explicit disablement or bypass Auth hides the owned control', async () => {
  vi.stubEnv('AXIOM_OWNED_SYNTHETIC_ENABLED', 'false');
  expect(renderToStaticMarkup(await Page())).not.toContain('data-owned-panel');
  vi.stubEnv('AXIOM_OWNED_SYNTHETIC_ENABLED', 'true');
  vi.stubEnv('AXIOM_AUTH_MODE', 'e2e-bypass');
  expect(renderToStaticMarkup(await Page())).not.toContain('data-owned-panel');
});
it('failed engagement selection reports uncertainty without losing retained-request recovery panel', async () => {
  state.error = true;
  const html = renderToStaticMarkup(await Page());
  expect(html).toContain('Owned target engagements are unavailable.');
  expect(html).toContain('data-owned-panel');
});
