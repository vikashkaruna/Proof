import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { middleware } from './middleware';

const state = vi.hoisted(() => ({
  getUser: vi.fn(),
  createServerClient: vi.fn(),
  next: vi.fn(),
  redirect: vi.fn(),
}));
vi.mock('@supabase/ssr', () => ({ createServerClient: state.createServerClient }));
vi.mock('next/server', () => ({ NextResponse: {
  next: state.next,
  redirect: state.redirect,
} }));

function request(pathname: string, cookieValues: Record<string, string> = {}): NextRequest {
  const origin = 'https://app.axiomproof.ai';
  return {
    nextUrl: {
      pathname,
      clone: () => new URL(pathname, origin),
    },
    cookies: {
      get: (name: string) => cookieValues[name] ? { value: cookieValues[name] } : undefined,
      set: vi.fn(),
    },
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', 'https://auth.example.invalid');
  vi.stubEnv('SUPABASE_ANON_KEY', 'public-anon-key');
  state.getUser.mockReset();
  state.createServerClient.mockReset().mockReturnValue({ auth: { getUser: state.getUser } });
  state.next.mockReset().mockImplementation(() => ({ kind: 'next', cookies: { set: vi.fn() } }));
  state.redirect.mockReset().mockImplementation((url: URL) => ({ kind: 'redirect', url: url.toString() }));
});
afterEach(() => vi.unstubAllEnvs());

it('allows only declared public paths before contacting auth', async () => {
  const response = await middleware(request('/invite'));
  expect(response).toMatchObject({ kind: 'next' });
  expect(state.createServerClient).not.toHaveBeenCalled();
});

it('fails closed when the anon key is missing', async () => {
  vi.stubEnv('SUPABASE_ANON_KEY', '');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', '');
  const response = await middleware(request('/dashboard'));
  expect(response).toMatchObject({ kind: 'redirect' });
  expect(state.redirect.mock.calls[0]?.[0].pathname).toBe('/login');
  expect(state.createServerClient).not.toHaveBeenCalled();
});

it('does not accept an E2E bypass cookie as an authenticated session', async () => {
  state.getUser.mockResolvedValue({ data: { user: null } });
  const response = await middleware(request('/dashboard', { axiom_e2e_bypass: 'true' }));
  expect(response).toMatchObject({ kind: 'redirect' });
  const target = state.redirect.mock.calls[0]?.[0] as URL;
  expect(target.pathname).toBe('/login');
  expect(target.searchParams.get('redirect')).toBe('/dashboard');
  expect(state.getUser).toHaveBeenCalledOnce();
});

it('redirects when the auth provider fails, and admits a validated user', async () => {
  state.getUser.mockRejectedValueOnce(new Error('provider unavailable'));
  expect(await middleware(request('/ledger'))).toMatchObject({ kind: 'redirect' });
  state.getUser.mockResolvedValueOnce({ data: { user: { id: 'user-1' } } });
  expect(await middleware(request('/ledger'))).toMatchObject({ kind: 'next' });
  expect(state.redirect).toHaveBeenCalledOnce();
});
