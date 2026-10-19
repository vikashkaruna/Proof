import { afterEach, expect, it, vi } from 'vitest';
import { createServerClient } from '@supabase/ssr';
import { createSupabaseServerClient } from './server';

const state = vi.hoisted(() => ({
  url: 'http://127.0.0.1:57121',
  cookies: new Map<string, string>(),
}));
vi.mock('@axiom/config', () => ({
  loadWebEnv: () => ({ SUPABASE_URL: state.url, SUPABASE_ANON_KEY: 'synthetic-public-key' }),
  isWebAuthBypassEnabled: () => false,
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    getAll: () => [...state.cookies].map(([name, value]) => ({ name, value })),
    get: (name: string) => ({ value: state.cookies.get(name) }),
    set: (name: string, value: string) => state.cookies.set(name, value),
  }),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  state.cookies.clear();
});
const configurations = [
  { url: 'http://127.0.0.1:57121', canonical: 'sb-127-auth-token', foreign: 'sb-host-auth-token' },
  {
    url: 'http://host.docker.internal:57121',
    canonical: 'sb-host-auth-token',
    foreign: 'sb-127-auth-token',
  },
];
function fixture(chunked = false) {
  const user = {
    id: '10000000-0000-4000-8000-000000000001',
    aud: 'authenticated',
    email: 'synthetic-session@example.invalid',
    app_metadata: {},
    user_metadata: chunked ? { synthetic: 'x'.repeat(6000) } : {},
    created_at: '2026-01-01T00:00:00Z',
  };
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const accessToken = [
    encode({ alg: 'HS256', typ: 'JWT' }),
    encode({
      sub: user.id,
      aud: 'authenticated',
      role: 'authenticated',
      iat: now,
      exp: now + 3600,
    }),
    'synthetic-signature-no-real-authority',
  ].join('.');
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    calls.push(url);
    if (url === state.url + '/auth/v1/token?grant_type=password')
      return Response.json({
        access_token: accessToken,
        refresh_token: 'synthetic-refresh-reference',
        expires_in: 3600,
        token_type: 'bearer',
        user,
      });
    if (url === state.url + '/auth/v1/user') return Response.json(user);
    throw Error('Unexpected synthetic auth request');
  });
  return { user, calls };
}
function middlewareClient() {
  // Actual middleware uses this SDK default namespace and legacy cookie adapter.
  return createServerClient(state.url, 'synthetic-public-key', {
    cookies: {
      get: (name) => state.cookies.get(name),
      set: (name, value) => {
        state.cookies.set(name, value);
      },
      remove: (name) => {
        state.cookies.delete(name);
      },
    },
  });
}
for (const configuration of configurations) {
  it.each(['', '.0', '-code-verifier'])(
    `new sign-in is readable by middleware at ${configuration.url} with foreign cookie suffix %s`,
    async (suffix) => {
      state.url = configuration.url;
      state.cookies.set(configuration.foreign + suffix, 'synthetic-foreign-cookie');
      const { user, calls } = fixture();
      const login = await createSupabaseServerClient();
      const signedIn = await login.auth.signInWithPassword({
        email: user.email,
        password: 'synthetic-input-never-sent-to-provider',
      });
      expect(signedIn.error).toBeNull();
      expect(state.cookies.has(configuration.canonical)).toBe(true);
      const authenticated = await middlewareClient().auth.getUser();
      expect(authenticated.error).toBeNull();
      expect(authenticated.data.user?.id).toBe(user.id);
      expect(calls).toEqual([
        state.url + '/auth/v1/token?grant_type=password',
        state.url + '/auth/v1/user',
      ]);
    },
  );
  it.each([false, true])(
    `reads incoming valid default session at ${configuration.url} despite first foreign cookie (chunked=%s)`,
    async (chunked) => {
      state.url = configuration.url;
      const { user, calls } = fixture(chunked);
      const setup = await middlewareClient().auth.signInWithPassword({
        email: user.email,
        password: 'synthetic-input-never-sent-to-provider',
      });
      expect(setup.error).toBeNull();
      const canonicalCookies = [...state.cookies];
      expect(
        canonicalCookies.some(([name]) => name === configuration.canonical + (chunked ? '.0' : '')),
      ).toBe(true);
      state.cookies.clear();
      state.cookies.set(configuration.foreign + '.0', 'synthetic-foreign-cookie');
      for (const [name, value] of canonicalCookies) state.cookies.set(name, value);
      const server = await createSupabaseServerClient();
      const result = await server.auth.getUser();
      expect(result.error).toBeNull();
      expect(result.data.user?.id).toBe(user.id);
      expect((await middlewareClient().auth.getUser()).data.user?.id).toBe(user.id);
      expect(calls.filter((url) => url.includes('/token?'))).toHaveLength(1);
    },
  );
}

for (const configuration of configurations) {
  it.each([false, true])(
    `never accepts a valid foreign session at ${configuration.url} when default is missing/invalid (invalid=%s)`,
    async (invalid) => {
      const foreignConfiguration = configurations.find((item) => item.url !== configuration.url)!;
      state.url = foreignConfiguration.url;
      const { user, calls } = fixture();
      const setup = await middlewareClient().auth.signInWithPassword({
        email: user.email,
        password: 'synthetic-input-never-sent-to-provider',
      });
      expect(setup.error).toBeNull();
      expect(state.cookies.has(configuration.foreign)).toBe(true);
      state.url = configuration.url;
      if (invalid) state.cookies.set(configuration.canonical, 'synthetic-invalid-cookie');
      const result = await (await createSupabaseServerClient()).auth.getUser();
      expect(result.data.user).toBeNull();
      expect(result.error?.name).toBe('AuthSessionMissingError');
      expect((await middlewareClient().auth.getUser()).data.user).toBeNull();
      expect(calls).toEqual([foreignConfiguration.url + '/auth/v1/token?grant_type=password']);
    },
  );
}
