import { beforeEach, expect, it, vi } from 'vitest';
import { UserRole } from '@axiom/types';
import type { TenantContext } from './tenant-context';
import { hasLiveFounderReportAccess } from './founder-report-access';
const rpc = vi.fn(),
  abortSignal = vi.fn();
const context = () =>
  ({
    userId: '10000000-0000-4000-8000-000000000001',
    role: UserRole.FOUNDER,
    isAxiomInternal: true,
    supabase: { rpc },
  }) as unknown as TenantContext;
beforeEach(() => {
  rpc.mockReset().mockReturnValue({ abortSignal });
  abortSignal.mockReset().mockResolvedValue({ data: true, error: null });
});
it('requires current authenticated live designation for the actual trusted internal founder', async () => {
  const c = context();
  expect(await hasLiveFounderReportAccess(c)).toBe(true);
  expect(rpc).toHaveBeenCalledWith('is_live_platform_founder', { p_user_id: c.userId });
  expect(abortSignal).toHaveBeenCalledWith(expect.any(AbortSignal));
});
it.each([
  UserRole.OWNER,
  UserRole.ADMIN,
  UserRole.REVIEWER,
  UserRole.VIEWER,
  UserRole.AXIOM_ANALYST,
])('uses live global authority independently of lower explicit tenant role %s', async (role) => {
  expect(await hasLiveFounderReportAccess({ ...context(), role })).toBe(true);
  expect(rpc).toHaveBeenCalled();
});
it('refuses an internal-looking legacy role when authoritative global designation says false', async () => {
  abortSignal.mockResolvedValue({ data: false, error: null });
  expect(await hasLiveFounderReportAccess({ ...context(), isAxiomInternal: false })).toBe(false);
  expect(rpc).toHaveBeenCalled();
});
it.each([
  { data: false, error: null },
  { data: 'true', error: null },
  { data: true, error: { message: 'unavailable' } },
  { data: null, error: null },
])(
  'fails closed for revoked/former-live explicit founder rows, malformed result or lookup failure %o',
  async (result) => {
    abortSignal.mockResolvedValue(result);
    expect(await hasLiveFounderReportAccess(context())).toBe(false);
  },
);
it('fails closed on transport failure rather than trusting the legacy founder membership', async () => {
  abortSignal.mockRejectedValue(Error('Transportfailed'));
  expect(await hasLiveFounderReportAccess(context())).toBe(false);
});
