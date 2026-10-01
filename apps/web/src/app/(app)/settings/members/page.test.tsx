import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import MembersPage from './page';

const state = vi.hoisted(() => ({
  calls: [] as Array<[string, string, unknown]>,
  rows: {} as Record<string, unknown>, errors: {} as Record<string, Error>,
}));
vi.mock('@/lib/tenant-context', () => ({ requireCapabilityContext: async () => ({
  tenantId: 'tenant-1', tenantName: 'Actual tenant', role: 'admin',
  supabase: { from: (table: string) => {
    const result = () => ({ data: state.rows[table] ?? [], error: state.errors[table] ?? null });
    const query = { select: () => query,
      eq: (key: string, value: unknown) => { state.calls.push([table, key, value]); return query; },
      order: () => query, limit: () => query,
      returns: async () => result(),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve),
    };
    return query;
  } },
}) }));
vi.mock('./members-client', () => ({ MembersClient: (props: unknown) => <pre data-testid="members">{JSON.stringify(props)}</pre> }));
beforeEach(() => { state.calls = []; state.rows = {}; state.errors = {}; });

it('passes only recorded tenant members and invitations to a non-owner admin', async () => {
  state.rows.tenant_users = [{ user_id: 'user-1', role: 'viewer', accepted_at: '2026-10-01', users: { email: 'person@example.invalid' } }];
  state.rows.tenant_invitations = [{ id: 'invite-1', email: 'guest@example.invalid', role: 'viewer' }];
  const view = renderToStaticMarkup(await MembersPage());
  expect(state.calls).toContainEqual(['tenant_users', 'tenant_id', 'tenant-1']);
  expect(state.calls).toContainEqual(['tenant_invitations', 'tenant_id', 'tenant-1']);
  expect(view).toContain('person@example.invalid');
  expect(view).toContain('guest@example.invalid');
  expect(view).toContain('&quot;canInviteOwners&quot;:false');
});

it('refuses partial membership reads', async () => {
  state.errors.tenant_invitations = new Error('read failed');
  const view = renderToStaticMarkup(await MembersPage());
  expect(view).toContain('Members could not be loaded');
  expect(view).not.toContain('data-testid="members"');
});
