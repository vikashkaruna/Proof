import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import { AuthRetryableFetchError } from '@supabase/supabase-js';
import AppLayout from './layout';

const state = vi.hoisted(() => ({
  user: null as unknown,
  memberships: null as unknown,
  error: null as Error | null,
  firstError: null as Error | null,
  membershipReads: 0,
  authError: null as Error | null,
  authThrows: false,
  profileInternal: true,
  founderLive: false,
  organizations: [] as Array<{ id: string; slug: string; name: string; is_demo?: boolean }>,
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => ({ value: 'beta' }) }) }));
vi.mock('next/navigation', () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT ${path}`);
  },
}));
vi.mock('@axiom/supabase', () => ({
  createSupabaseServerClient: async () => ({
    auth: {
      getUser: async () => {
        if (state.authThrows) throw new Error('provider unavailable');
        return { data: { user: state.user }, error: state.authError };
      },
    },
    rpc: () => ({ abortSignal: async () => ({ data: state.founderLive, error: null }) }),
    from: (table: string) => {
      if (table === 'users') {
        const profile = {
          select: () => profile,
          eq: () => profile,
          maybeSingle: async () => ({
            data: { is_axiom_internal: state.profileInternal },
            error: null,
          }),
        };
        return profile;
      }
      const query = {
        select: () => query,
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve(resolve({ data: state.organizations, error: state.error })),
        eq: async () => {
          state.membershipReads += 1;
          return {
            data: state.memberships,
            error: state.membershipReads === 1 && state.firstError ? state.firstError : state.error,
          };
        },
      };
      return query;
    },
  }),
}));
vi.mock('./app-shell', () => ({
  AppShell: ({
    tenants,
    children,
    canReviewFounderReports,
  }: {
    tenants: unknown;
    children: React.ReactNode;
    canReviewFounderReports: boolean;
  }) => (
    <div>
      <pre>{JSON.stringify(tenants)}</pre>
      <output data-testid="founder-report-navigation">{String(canReviewFounderReports)}</output>
      {children}
    </div>
  ),
}));
vi.mock('../(auth)/login/actions', () => ({ logoutAction: async () => {} }));
beforeEach(() => {
  state.user = null;
  state.memberships = null;
  state.error = null;
  state.firstError = null;
  state.membershipReads = 0;
  state.authError = null;
  state.authThrows = false;
  state.profileInternal = true;
  state.founderLive = false;
  state.organizations = [];
});

it('does not render protected content without an authenticated user', async () => {
  await expect(AppLayout({ children: <p>Protected</p> })).rejects.toThrow('REDIRECT /login');
});

it('reports provider failure without treating a valid cookie as a missing session', async () => {
  state.authThrows = true;
  await expect(AppLayout({ children: <p>Protected</p> })).rejects.toThrow(
    'Authentication service is temporarily unavailable',
  );
  state.authThrows = false;
  state.profileInternal = true;
  state.founderLive = false;
  state.authError = new AuthRetryableFetchError('provider unavailable', 503);
  await expect(AppLayout({ children: <p>Protected</p> })).rejects.toThrow(
    'Authentication service is temporarily unavailable',
  );
});

it('fails closed when tenant membership read is unavailable', async () => {
  state.user = { id: 'user-1' };
  state.error = new Error('provider failure');
  await expect(AppLayout({ children: <p>Protected</p> })).rejects.toThrow(
    'Tenant memberships are unavailable',
  );
  expect(state.membershipReads).toBe(1);
});

it('retries only PostgREST JWT issued-at-future after a fresh sign-in', async () => {
  state.user = { id: 'user-1' };
  state.memberships = [
    { tenant_id: 'tenant-beta', role: 'viewer', tenants: { name: 'Beta', slug: 'beta' } },
  ];
  state.firstError = Object.assign(new Error('JWT issued at future'), { code: 'PGRST303' });
  const view = renderToStaticMarkup(await AppLayout({ children: <p>Protected</p> }));
  expect(view).toContain('Beta');
  expect(state.membershipReads).toBe(2);
});

it('passes only recorded tenant memberships into the shell', async () => {
  state.user = { id: 'user-1' };
  state.memberships = [
    { tenant_id: 'tenant-beta', role: 'viewer', tenants: { name: 'Beta', slug: 'beta' } },
  ];
  const view = renderToStaticMarkup(await AppLayout({ children: <p>Protected</p> }));
  expect(view).toContain('Beta');
  expect(view).toContain('Protected');
  expect(view).not.toContain('Meridian');
});

it('derives founder report navigation from current live designation rather than an explicit legacy founder label', async () => {
  state.user = { id: 'actor' };
  state.memberships = [
    {
      tenant_id: 'tenant',
      role: 'founder',
      tenants: { slug: 'beta', name: 'Selected organization' },
    },
  ];
  state.founderLive = false;
  expect(renderToStaticMarkup(await AppLayout({ children: <p>Reader</p> }))).toContain(
    'data-testid="founder-report-navigation">false',
  );
  state.founderLive = true;
  state.organizations = [{ id: 'tenant', slug: 'beta', name: 'Selected organization' }];
  expect(renderToStaticMarkup(await AppLayout({ children: <p>Reader</p> }))).toContain(
    'data-testid="founder-report-navigation">true',
  );
  state.profileInternal = false;
  expect(renderToStaticMarkup(await AppLayout({ children: <p>Reader</p> }))).toContain(
    'data-testid="founder-report-navigation">true',
  );
});

it('lists every RLS-visible organization with founder authority without requiring any membership row', async () => {
  state.user = { id: 'global-founder' };
  state.memberships = [];
  state.founderLive = true;
  state.organizations = [
    { id: 'inactive', slug: 'inactive', name: 'Inactive organization' },
    { id: 'foreign', slug: 'foreign', name: 'Organization without membership' },
  ];
  const view = renderToStaticMarkup(await AppLayout({ children: <p>Global</p> }));
  expect(view).toContain('Inactive organization');
  expect(view).toContain('Organization without membership');
  expect(view.match(/&quot;role&quot;:&quot;founder&quot;/g)).toHaveLength(2);
  expect(state.membershipReads).toBe(0);
});
