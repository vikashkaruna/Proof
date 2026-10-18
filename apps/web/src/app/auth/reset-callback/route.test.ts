import { beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const exchange = vi.hoisted(() => vi.fn());
vi.mock('@axiom/supabase', () => ({
  createSupabaseServerClient: async () => ({ auth: { exchangeCodeForSession: exchange } }),
}));
import { GET } from './route';

beforeEach(() => exchange.mockReset());

it('exchanges a valid one-time code and continues to choose a password', async () => {
  exchange.mockResolvedValue({ error: null });
  const res = await GET(
    new NextRequest('http://localhost:3001/auth/reset-callback?code=abc12345-def'),
  );
  expect(exchange).toHaveBeenCalledWith('abc12345-def');
  expect(new URL(res.headers.get('location')!).pathname).toBe('/reset-password');
});

it('sends a missing, malformed, used or expired code back to request a new link', async () => {
  exchange.mockResolvedValue({ error: { message: 'expired' } });
  for (const url of [
    'http://localhost:3001/auth/reset-callback',
    'http://localhost:3001/auth/reset-callback?code=%3Cscript%3E',
    'http://localhost:3001/auth/reset-callback?code=abc12345-def',
  ]) {
    const res = await GET(new NextRequest(url));
    const to = new URL(res.headers.get('location')!);
    expect(to.pathname).toBe('/forgot-password');
    expect(to.searchParams.get('error')).toContain('expired or was already used');
  }
});
