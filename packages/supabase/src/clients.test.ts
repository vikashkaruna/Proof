import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadEnv: vi.fn(),
  loadWebEnv: vi.fn(),
  bypass: vi.fn(),
  webBypass: vi.fn(),
  createClient: vi.fn(),
  createServerClient: vi.fn(),
  cookies: vi.fn(),
}));
vi.mock('@axiom/config', () => ({
  loadEnv: mocks.loadEnv,
  loadWebEnv: mocks.loadWebEnv,
  isAuthBypassEnabled: mocks.bypass,
  isWebAuthBypassEnabled: mocks.webBypass,
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createClient }));
vi.mock('@supabase/ssr', () => ({ createServerClient: mocks.createServerClient }));
vi.mock('next/headers', () => ({ cookies: mocks.cookies }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.bypass.mockReturnValue(false);
  mocks.webBypass.mockReturnValue(false);
  mocks.loadEnv.mockReturnValue({
    SUPABASE_URL: 'http://supabase.local',
    SUPABASE_SERVICE_KEY: 'private-key',
  });
  mocks.loadWebEnv.mockReturnValue({
    SUPABASE_URL: 'http://supabase.local',
    SUPABASE_ANON_KEY: 'public-key',
  });
  mocks.createClient.mockReturnValue({ marker: 'real-admin' });
  mocks.createServerClient.mockReturnValue({ marker: 'real-session' });
  mocks.cookies.mockResolvedValue({ getAll: () => [], get: () => undefined, set: vi.fn() });
});

describe('Supabase deployed-client boundaries', () => {
  it('uses the real server-side service key and caches the admin client', async () => {
    const { createSupabaseAdmin } = await import('./admin');
    expect(createSupabaseAdmin()).toMatchObject({ marker: 'real-admin' });
    expect(createSupabaseAdmin()).toMatchObject({ marker: 'real-admin' });
    expect(mocks.createClient).toHaveBeenCalledOnce();
    expect(mocks.createClient).toHaveBeenCalledWith('http://supabase.local', 'private-key', {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  });

  it('returns a fixture only when the central local/test bypass says so', async () => {
    mocks.bypass.mockReturnValue(true);
    const { createSupabaseAdmin } = await import('./admin');
    const client = createSupabaseAdmin();
    expect((await client.auth.getUser()).data.user?.email).toBe('founder@axiomminds.ai');
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it('passes the validated session-cookie name to the SSR client', async () => {
    const set = vi.fn();
    const cookies = [{ name: 'sb-project-auth-token.0', value: 'part-one' }];
    mocks.cookies.mockResolvedValue({ getAll: () => cookies, get: () => undefined, set });
    const { createSupabaseServerClient } = await import('./server');
    expect(await createSupabaseServerClient()).toMatchObject({ marker: 'real-session' });
    const [url, key, options] = mocks.createServerClient.mock.calls[0]!;
    expect([url, key]).toEqual(['http://supabase.local', 'public-key']);
    expect(options.cookieOptions).toEqual({ name: 'sb-project-auth-token' });
    expect(options.cookies.getAll()).toEqual(cookies);
    options.cookies.setAll([{ name: 'new-session', value: 'new', options: { httpOnly: true } }]);
    expect(set).toHaveBeenCalledWith('new-session', 'new', { httpOnly: true });
  });

  it('does not use the fixture after an explicit local logout and tolerates read-only cookies', async () => {
    mocks.webBypass.mockReturnValue(true);
    mocks.cookies.mockResolvedValue({
      getAll: () => [{ name: 'sb-project-auth-token.0', value: '' }],
      get: (name: string) => ({ value: name === 'axiom_e2e_logged_out' ? 'true' : '' }),
      set: () => {
        throw new Error('read-only server component');
      },
    });
    const { createSupabaseServerClient } = await import('./server');
    expect(await createSupabaseServerClient()).toMatchObject({ marker: 'real-session' });
    const options = mocks.createServerClient.mock.calls[0]![2];
    expect(options.cookieOptions).toBeUndefined();
    expect(() =>
      options.cookies.setAll([{ name: 'new-session', value: 'new', options: {} }]),
    ).not.toThrow();
  });

  it('uses a named fixture user only for an enabled local/test web bypass', async () => {
    mocks.webBypass.mockReturnValue(true);
    mocks.cookies.mockResolvedValue({
      getAll: () => [],
      get: (name: string) =>
        name === 'axiom_user_email' ? { value: 'reviewer@example.invalid' } : undefined,
      set: vi.fn(),
    });
    const { createSupabaseServerClient } = await import('./server');
    const client = await createSupabaseServerClient();
    expect((await client.auth.getUser()).data.user?.email).toBe('reviewer@example.invalid');
    expect(mocks.createServerClient).not.toHaveBeenCalled();
  });
});
