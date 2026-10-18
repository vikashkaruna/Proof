import { beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  resetPasswordForEmail: vi.fn(),
  getUser: vi.fn(),
  updateUser: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock('@axiom/supabase', () => ({ createSupabaseServerClient: async () => ({ auth }) }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error('REDIRECT ' + to);
  },
}));
import { requestPasswordResetAction, updatePasswordAction } from './password-reset-actions';

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const redirectOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return decodeURIComponent(String((e as Error).message).replace('REDIRECT ', ''));
  }
  throw new Error('no redirect');
};

beforeEach(() => {
  for (const fn of Object.values(auth)) fn.mockReset();
  auth.resetPasswordForEmail.mockResolvedValue({ error: null });
  auth.getUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'p@example.invalid' } } });
  auth.updateUser.mockResolvedValue({ error: null });
  auth.signOut.mockResolvedValue({ error: null });
});

describe('requestPasswordResetAction', () => {
  it('sends the recovery link back to the callback and answers neutrally', async () => {
    const to = await redirectOf(requestPasswordResetAction(form({ email: 'p@example.invalid' })));
    expect(auth.resetPasswordForEmail).toHaveBeenCalledWith('p@example.invalid', {
      redirectTo: 'http://localhost:3001/auth/reset-callback',
    });
    expect(to).toContain('/forgot-password?message=If an account exists');
  });
  it('gives the same answer when the provider fails (no account enumeration)', async () => {
    auth.resetPasswordForEmail.mockRejectedValue(new Error('User not found'));
    const to = await redirectOf(
      requestPasswordResetAction(form({ email: 'nobody@example.invalid' })),
    );
    expect(to).toContain('If an account exists');
    expect(to).not.toContain('not found');
  });
  it('refuses an empty or malformed address without calling the provider', async () => {
    const to = await redirectOf(requestPasswordResetAction(form({ email: 'nope' })));
    expect(to).toContain('/forgot-password?error=');
    expect(auth.resetPasswordForEmail).not.toHaveBeenCalled();
  });
});

describe('updatePasswordAction', () => {
  it('sets the password, then signs the account out everywhere', async () => {
    const to = await redirectOf(
      updatePasswordAction(
        form({ password: 'a-strong-password-1', confirm: 'a-strong-password-1' }),
      ),
    );
    expect(auth.updateUser).toHaveBeenCalledWith({ password: 'a-strong-password-1' });
    expect(auth.signOut).toHaveBeenCalledWith({ scope: 'global' });
    expect(to).toContain('/login?message=Password changed');
    expect(to).toContain('authenticator');
  });
  it('refuses short or mismatched passwords before touching the account', async () => {
    expect(
      await redirectOf(updatePasswordAction(form({ password: 'short', confirm: 'short' }))),
    ).toContain('at least 12');
    expect(
      await redirectOf(
        updatePasswordAction(
          form({ password: 'a-strong-password-1', confirm: 'different-pass-22' }),
        ),
      ),
    ).toContain('do not match');
    expect(auth.updateUser).not.toHaveBeenCalled();
  });
  it('sends an expired or used link back to request a new one', async () => {
    auth.getUser.mockResolvedValue({ data: { user: null } });
    const to = await redirectOf(
      updatePasswordAction(
        form({ password: 'a-strong-password-1', confirm: 'a-strong-password-1' }),
      ),
    );
    expect(to).toContain('/forgot-password?error=');
    expect(auth.updateUser).not.toHaveBeenCalled();
  });
  it('does not sign out or claim success when the provider refuses the change', async () => {
    auth.updateUser.mockResolvedValue({ error: { message: 'weak' } });
    const to = await redirectOf(
      updatePasswordAction(
        form({ password: 'a-strong-password-1', confirm: 'a-strong-password-1' }),
      ),
    );
    expect(to).toContain('/reset-password?error=');
    expect(auth.signOut).not.toHaveBeenCalled();
  });
});
