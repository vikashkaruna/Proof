import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import OnboardingProposalsPage from './page';

const state = vi.hoisted(() => ({
  session: { access_token: 'token' } as { access_token: string } | null,
  estateRows: [] as unknown[] | null, estateError: null as Error | null,
  calls: [] as Array<[string, string, unknown]>,
}));
vi.mock('@/lib/tenant-context', () => ({ requireCapabilityContext: async () => ({
  tenantId: 'tenant-1', userId: 'user-1', role: 'viewer',
  supabase: {
    auth: { getSession: async () => ({ data: { session: state.session } }) },
    from: (table: string) => {
      if (table !== 'estates') throw new Error('unexpected source');
      const query = { select: () => query,
        eq: (key: string, value: unknown) => { state.calls.push([table, key, value]); return query; },
        returns: async () => ({ data: state.estateRows, error: state.estateError }),
      };
      return query;
    },
  },
}) }));
vi.mock('./proposal-client', () => ({ ProposalClient: (props: unknown) => <pre data-testid="proposals">{JSON.stringify(props)}</pre> }));
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
beforeEach(() => { state.session = { access_token: 'token' }; state.estateRows = []; state.estateError = null; state.calls = []; vi.unstubAllGlobals(); });

it('passes only active tenant estates and recorded proposal data to the reviewer', async () => {
  state.estateRows = [{ id: 'estate-1', name: 'Saved estate' }];
  const fetcher = vi.fn().mockResolvedValue(Response.json({ data: { proposals: [{ id: 'proposal-1' }] } }));
  vi.stubGlobal('fetch', fetcher);
  const view = renderToStaticMarkup(await OnboardingProposalsPage());
  expect(state.calls).toContainEqual(['estates', 'tenant_id', 'tenant-1']);
  expect(state.calls).toContainEqual(['estates', 'status', 'active']);
  expect(fetcher.mock.calls[0]![1]).toMatchObject({ cache: 'no-store', headers: { Authorization: 'Bearer token', 'X-Tenant-Id': 'tenant-1' } });
  expect(view).toContain('Saved estate');
  expect(view).toContain('proposal-1');
  expect(view).toContain('&quot;canPrepare&quot;:false');
});

it('refuses missing session, proposal transport and estate errors', async () => {
  const fetcher = vi.fn().mockRejectedValue(new Error('offline'));
  vi.stubGlobal('fetch', fetcher);
  state.session = null;
  let view = renderToStaticMarkup(await OnboardingProposalsPage());
  expect(view).toContain('Onboarding proposals could not be loaded');
  expect(fetcher).not.toHaveBeenCalled();
  state.session = { access_token: 'token' };
  view = renderToStaticMarkup(await OnboardingProposalsPage());
  expect(view).not.toContain('data-testid="proposals"');
  state.estateError = new Error('estate read failed');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ data: { proposals: [] } })));
  view = renderToStaticMarkup(await OnboardingProposalsPage());
  expect(view).toContain('Onboarding proposals could not be loaded');
});
