import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  signIn: vi.fn(),
  signUp: vi.fn(),
  signOut: vi.fn(),
  upsert: vi.fn(),
  deletes: [] as string[],
  sets: [] as string[],
}));
vi.mock('next/navigation', () => ({
  redirect: (path: string) => {
    throw new Error(`redirect:${path}`);
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    delete: (name: string) => state.deletes.push(name),
    set: (name: string) => state.sets.push(name),
    getAll: () => [{ name: 'sb-project-auth-token' }, { name: 'unrelated' }],
  }),
}));
vi.mock('@axiom/supabase', () => ({
  createSupabaseServerClient: async () => ({
    auth: { signInWithPassword: state.signIn, signUp: state.signUp, signOut: state.signOut },
    from: (table: string) => {
      if (table !== 'users') throw new Error('unexpected privileged table');
      return { upsert: state.upsert };
    },
  }),
}));
import { loginAction, logoutAction, signupAction } from './actions';

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};

beforeEach(() => {
  state.signIn.mockReset();
  state.signUp.mockReset();
  state.signOut.mockReset();
  state.upsert.mockReset();
  state.deletes = [];
  state.sets = [];
});

it('refuses missing credentials before any auth mutation', async () => {
  await expect(loginAction(form({ email: 'reader@example.invalid' }))).rejects.toThrow(
    'redirect:/login?error=',
  );
  expect(state.signIn).not.toHaveBeenCalled();
});

it('never grants a session when the identity provider is down', async () => {
  state.signIn.mockRejectedValue(new Error('fetch failed'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  await expect(
    loginAction(form({ email: 'reader@example.invalid', password: 'password' })),
  ).rejects.toThrow('Authentication%20service%20is%20unreachable');
  expect(state.upsert).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

it('redirects a valid login only after the provider returns an actual user', async () => {
  state.signIn.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
  await expect(
    loginAction(
      form({ email: ' reader@example.invalid ', password: 'password', redirect: '/dashboard' }),
    ),
  ).rejects.toThrow('redirect:/dashboard');
  expect(state.signIn).toHaveBeenCalledWith({
    email: 'reader@example.invalid',
    password: 'password',
  });
  expect(state.upsert).not.toHaveBeenCalled();
});

it('refuses weak signup passwords without calling the provider', async () => {
  await expect(
    signupAction(form({ email: 'reader@example.invalid', password: 'short' })),
  ).rejects.toThrow('Password%20must%20be%20at%20least%2012');
  expect(state.signUp).not.toHaveBeenCalled();
});

it('creates only the caller profile after a real signup session', async () => {
  state.signUp.mockResolvedValue({
    data: { user: { id: 'user-1' }, session: { access_token: 'jwt' } },
    error: null,
  });
  state.upsert.mockResolvedValue({ error: null });
  await expect(
    signupAction(
      form({
        email: 'reader@example.invalid',
        password: 'long-password-123',
        full_name: 'Ravi Sharma',
      }),
    ),
  ).rejects.toThrow('redirect:/dashboard');
  expect(state.upsert).toHaveBeenCalledWith({
    id: 'user-1',
    email: 'reader@example.invalid',
    full_name: 'Ravi Sharma',
  });
});

it('purges auth cookies and signs out before returning to the public site', async () => {
  state.signOut.mockResolvedValue({ error: null });
  await expect(logoutAction()).rejects.toThrow('redirect:/');
  expect(state.deletes).toContain('sb-project-auth-token');
  expect(state.deletes).not.toContain('unrelated');
  expect(state.signOut).toHaveBeenCalledOnce();
});
