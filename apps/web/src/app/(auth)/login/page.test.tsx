import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import LoginPage from './page';

const state = vi.hoisted(() => ({ user: null as { email: string } | null, loggedOut: false, authError: false }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => state.loggedOut ? { value: 'true' } : undefined }) }));
vi.mock('next/navigation', () => ({ redirect: (path: string) => { throw new Error(`REDIRECT ${path}`); } }));
vi.mock('@axiom/supabase', () => ({ createSupabaseServerClient: async () => ({ auth: { getUser: async () => {
  if (state.authError) throw new Error('provider offline');
  return { data: { user: state.user } };
} } }) }));
vi.mock('@axiom/config', () => ({ BRAND: { primaryDomain: 'axiomproof.ai', dataResidencyRegion: 'ap-south-1' } }));
vi.mock('./actions', () => ({ loginAction: async () => {}, signupAction: async () => {} }));
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
beforeEach(() => { state.user = null; state.loggedOut = false; state.authError = false; });

it('shows unauthenticated signup fields without claiming verified deployment residency', async () => {
  const view = renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve({ mode: 'signup' }) }));
  expect(view).toContain('Create your account');
  expect(view).toContain('name="full_name"');
  expect(view).toContain('Configured residency target: ap-south-1; verify deployment separately');
  expect(view).not.toContain('Signed in as');
});

it('redirects an authenticated user only to a safe local destination', async () => {
  state.user = { email: 'member@example.invalid' };
  await expect(LoginPage({ searchParams: Promise.resolve({ redirect: '/portal' }) })).rejects.toThrow('REDIRECT /portal');
  await expect(LoginPage({ searchParams: Promise.resolve({ redirect: '//evil.example' }) })).rejects.toThrow('REDIRECT /dashboard');
});

it('does not auto-redirect a deliberately logged-out session or a failed auth read', async () => {
  state.user = { email: 'member@example.invalid' }; state.loggedOut = true;
  let view = renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve({ redirect: '/portal' }) }));
  expect(view).toContain('Sign in');
  expect(view).not.toContain('Signed in as');
  state.loggedOut = false; state.authError = true;
  view = renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve({ redirect: '/portal' }) }));
  expect(view).not.toContain('Signed in as');
});
