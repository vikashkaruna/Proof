import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import OnboardingProposalsPage from './page';

const state = vi.hoisted(() => ({
  session: { access_token: 'token' } as { access_token: string } | null,
  estateRows: [] as unknown[] | null,
  estateError: null as Error | null,
  calls: [] as Array<[string, string, unknown]>,
}));
vi.mock('@/lib/tenant-context', () => ({
  requireCapabilityContext: async () => ({
    tenantId: 'tenant-1',
    userId: 'user-1',
    role: 'viewer',
    supabase: {
      auth: { getSession: async () => ({ data: { session: state.session } }) },
      from: (table: string) => {
        if (table !== 'estates') throw new Error('unexpected source');
        const query = {
          select: () => query,
          eq: (key: string, value: unknown) => {
            state.calls.push([table, key, value]);
            return query;
          },
          returns: async () => ({ data: state.estateRows, error: state.estateError }),
        };
        return query;
      },
    },
  }),
}));
vi.mock('./proposal-client', () => ({
  ProposalClient: (props: unknown) => <pre data-testid="proposals">{JSON.stringify(props)}</pre>,
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
beforeEach(() => {
  state.session = { access_token: 'token' };
  state.estateRows = [];
  state.estateError = null;
  state.calls = [];
  vi.unstubAllGlobals();
});

it('passes only active tenant estates and recorded proposal data to the reviewer', async () => {
  const estateId = '11111111-1111-4111-8111-111111111111';
  const proposalId = '22222222-2222-4222-8222-222222222222';
  const userId = '33333333-3333-4333-8333-333333333333';
  state.estateRows = [{ id: estateId, name: 'Saved estate' }];
  const fetcher = vi.fn().mockResolvedValue(
    Response.json({
      data: {
        intake: [{ name: 'Payroll', type: 'database' }],
        proposals: [
          {
            id: proposalId,
            estate_id: estateId,
            prepared_by: userId,
            estate_snapshot: {
              id: estateId,
              name: 'Saved estate',
              slug: 'saved',
              description: '',
              status: 'active',
              version: 1,
            },
            source_snapshot: [{ name: 'Payroll', type: 'database' }],
            systems: [
              {
                name: 'Payroll',
                systemKind: 'database',
                description: '',
                externalRef: null,
                dataCategories: ['identity'],
              },
            ],
            content_sha256: 'a'.repeat(64),
            status: 'pending',
            review_reason: null,
            reviewed_by: null,
            onboarding_proposal_systems: [],
          },
        ],
      },
    }),
  );
  vi.stubGlobal('fetch', fetcher);
  const view = renderToStaticMarkup(await OnboardingProposalsPage());
  expect(state.calls).toContainEqual(['estates', 'tenant_id', 'tenant-1']);
  expect(state.calls).toContainEqual(['estates', 'status', 'active']);
  expect(fetcher.mock.calls[0]![1]).toMatchObject({
    cache: 'no-store',
    headers: { Authorization: 'Bearer token', 'X-Tenant-Id': 'tenant-1' },
  });
  expect(view).toContain('Saved estate');
  expect(view).toContain(proposalId);
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

it.each([
  { intake: null, proposals: [] },
  { intake: [], proposals: [{ id: 'partial-proposal' }] },
])('refuses malformed successful proposal data (%j)', async (data) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ data })));
  const view = renderToStaticMarkup(await OnboardingProposalsPage());
  expect(view).toContain('Onboarding proposals could not be loaded');
  expect(view).not.toContain('data-testid="proposals"');
});

it('refuses a null-success estate list before showing a proposal', async () => {
  state.estateRows = null;
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(Response.json({ data: { intake: [], proposals: [] } })),
  );
  const view = renderToStaticMarkup(await OnboardingProposalsPage());
  expect(view).toContain('Onboarding proposals could not be loaded');
  expect(view).not.toContain('data-testid="proposals"');
});
