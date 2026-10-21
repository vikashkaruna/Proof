import { beforeEach, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { readOrganizationContexts, readLiveFounderDesignation } from './organization-contexts';
const state = {
  live: false as unknown,
  error: null as unknown,
  organizations: [
    { id: 'tenant-z', slug: 'suspended', name: 'Suspended organization', is_demo: false },
  ],
  memberships: [
    {
      tenant_id: 'tenant-a',
      role: 'viewer',
      approval_scopes: ['limited'],
      tenants: { slug: 'alpha', name: 'Alpha' },
    },
  ],
};
const from = vi.fn();
const rpc = vi.fn();
const client = { rpc, from } as unknown as SupabaseClient;
beforeEach(() => {
  state.live = false;
  state.error = null;
  rpc.mockReset().mockImplementation(() => ({
    abortSignal: async () => ({ data: state.live, error: state.error }),
  }));
  from.mockReset().mockImplementation((table: string) => ({
    select: () =>
      table === 'tenants'
        ? Promise.resolve({ data: state.organizations, error: null })
        : { eq: async () => ({ data: state.memberships, error: null }) },
  }));
});
it('uses authoritative designation and RLS-visible all-organization rows, never lower explicit membership authority', async () => {
  state.live = true;
  const value = await readOrganizationContexts(client, 'actual-user');
  expect(rpc).toHaveBeenCalledWith('is_live_platform_founder', { p_user_id: 'actual-user' });
  expect(value).toEqual({
    globalFounder: true,
    rows: [
      {
        tenant_id: 'tenant-z',
        role: 'founder',
        approval_scopes: [],
        tenants: { slug: 'suspended', name: 'Suspended organization', is_demo: false },
      },
    ],
  });
  expect(from).toHaveBeenCalledExactlyOnceWith('tenants');
});
it('returns only recorded memberships immediately after designation revocation', async () => {
  state.live = true;
  await readOrganizationContexts(client, 'actual-user');
  from.mockClear();
  state.live = false;
  const value = await readOrganizationContexts(client, 'actual-user');
  expect(value.globalFounder).toBe(false);
  expect(value.rows).toEqual(state.memberships);
  expect(from).toHaveBeenCalledExactlyOnceWith('tenant_users');
});
it.each(['true', null, undefined, {}, 1])(
  'refuses malformed authoritative designation %j before any inventory read',
  async (value) => {
    state.live = value;
    await expect(readOrganizationContexts(client, 'actual-user')).rejects.toThrow(
      'Founder designation is unavailable',
    );
    expect(from).not.toHaveBeenCalled();
  },
);
it('fails closed on designation lookup errors and transport failures without using role/email fallbacks', async () => {
  state.live = true;
  state.error = { message: 'unavailable' };
  await expect(readLiveFounderDesignation(client, 'actual-user')).rejects.toThrow(
    'Founder designation is unavailable',
  );
  rpc.mockImplementation(() => ({
    abortSignal: async () => {
      throw Error('transport unavailable');
    },
  }));
  await expect(readOrganizationContexts(client, 'actual-user')).rejects.toThrow(
    'Founder designation is unavailable',
  );
  expect(from).not.toHaveBeenCalled();
});
