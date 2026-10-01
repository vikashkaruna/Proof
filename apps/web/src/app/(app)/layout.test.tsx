import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import AppLayout from './layout';

const state = vi.hoisted(() => ({
  user: null as unknown,
  memberships: null as unknown,
  error: null as Error | null,
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => ({ value: 'beta' }) }) }));
vi.mock('next/navigation', () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT ${path}`);
  },
}));
vi.mock('@axiom/supabase', () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
    from: () => {
      const query = {
        select: () => query,
        eq: async () => ({ data: state.memberships, error: state.error }),
      };
      return query;
    },
  }),
}));
vi.mock('./app-shell', () => ({
  AppShell: ({ tenants, children }: { tenants: unknown; children: React.ReactNode }) => (
    <div>
      <pre>{JSON.stringify(tenants)}</pre>
      {children}
    </div>
  ),
}));
vi.mock('../(auth)/login/actions', () => ({ logoutAction: async () => {} }));
beforeEach(() => {
  state.user = null;
  state.memberships = null;
  state.error = null;
});

it('does not render protected content without an authenticated user', async () => {
  await expect(AppLayout({ children: <p>Protected</p> })).rejects.toThrow('REDIRECT /login');
});

it('fails closed when tenant membership read is unavailable', async () => {
  state.user = { id: 'user-1' };
  state.error = new Error('provider failure');
  await expect(AppLayout({ children: <p>Protected</p> })).rejects.toThrow(
    'Tenant memberships are unavailable',
  );
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
