// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import SecuritySettingsPage from './page';

const state = vi.hoisted(() => ({
  userId: 'user-a',
  email: 'first@example.invalid',
  tenantId: 'tenant-a',
  enrolled: true,
}));
vi.mock('@/lib/tenant-context', () => ({
  requireTenantContext: async () => ({
    userId: state.userId,
    email: state.email,
    tenantId: state.tenantId,
    tenantName: 'Test tenant',
    role: 'approver',
    supabase: {
      rpc: async () => ({ data: null, error: null }),
      from: (table: string) =>
        table === 'platform_founders'
          ? { select: () => ({ eq: () => ({ is: async () => ({ data: [], error: null }) }) }) }
          : {
              select: async () => ({
                data: state.enrolled
                  ? [
                      {
                        id: 'factor-a',
                        factor_type: 'totp',
                        status: 'active',
                        label: 'First factor',
                      },
                    ]
                  : [],
                error: null,
              }),
            },
    },
  }),
}));
beforeEach(() => {
  state.userId = 'user-a';
  state.email = 'first@example.invalid';
  state.tenantId = 'tenant-a';
  state.enrolled = true;
});
afterEach(cleanup);

it('discards the previous account factor state when the signed-in account changes', async () => {
  const view = render(await SecuritySettingsPage({ searchParams: Promise.resolve({}) }));
  expect(screen.getByRole('button', { name: 'Replace authenticator' })).toBeTruthy();
  state.userId = 'user-b';
  state.email = 'second@example.invalid';
  state.enrolled = false;
  view.rerender(
    await SecuritySettingsPage({ searchParams: Promise.resolve({ enrol: 'required' }) }),
  );
  expect(screen.getByRole('button', { name: 'Enrol an authenticator' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Replace authenticator' })).toBeNull();
  expect(screen.queryByText('First factor')).toBeNull();
});

it('reinitialises factor state when the tenant context changes', async () => {
  const view = render(await SecuritySettingsPage({ searchParams: Promise.resolve({}) }));
  expect(screen.getByRole('button', { name: 'Replace authenticator' })).toBeTruthy();
  state.tenantId = 'tenant-b';
  state.enrolled = false;
  view.rerender(await SecuritySettingsPage({ searchParams: Promise.resolve({}) }));
  expect(screen.getByRole('button', { name: 'Enrol an authenticator' })).toBeTruthy();
});
