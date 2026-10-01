import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import SecuritySettingsPage from './page';

const state = vi.hoisted(() => ({ rows: [] as unknown[] | null, error: null as Error | null }));
vi.mock('@/lib/tenant-context', () => ({
  requireTenantContext: async (_tenant: unknown, options: unknown) => {
    if (JSON.stringify(options) !== JSON.stringify({ allowUnverifiedMfa: true }))
      throw new Error('MFA enrolment quarantined');
    return {
      tenantId: 'tenant-1',
      tenantName: 'Actual tenant',
      email: 'owner@example.invalid',
      role: 'owner',
      supabase: {
        from: (table: string) => {
          if (table !== 'user_mfa_factors') throw new Error('unexpected source');
          return { select: async () => ({ data: state.rows, error: state.error }) };
        },
      },
    };
  },
}));
vi.mock('./mfa-enrolment', () => ({
  MfaEnrolment: (props: unknown) => <pre>{JSON.stringify(props)}</pre>,
}));
beforeEach(() => {
  state.rows = [];
  state.error = null;
});

it('shows the actual personal factor and recovery state', async () => {
  state.rows = [
    {
      id: 'f1',
      factor_type: 'totp',
      status: 'active',
      label: 'Primary',
      activated_at: '2026-09-30',
      last_used_at: null,
      consumed_at: null,
    },
    { id: 'r1', factor_type: 'recovery_code', status: 'active', consumed_at: null },
    { id: 'r2', factor_type: 'recovery_code', status: 'active', consumed_at: '2026-10-01' },
  ];
  const view = renderToStaticMarkup(
    await SecuritySettingsPage({ searchParams: Promise.resolve({ enrol: 'required' }) }),
  );
  expect(view).toContain('Enrol before continuing');
  expect(view).toContain('&quot;enrolled&quot;:true');
  expect(view).toContain('&quot;recoveryCodesRemaining&quot;:1');
  expect(view).toContain('&quot;label&quot;:&quot;Primary&quot;');
  expect(view).not.toContain('&quot;id&quot;:&quot;r1&quot;');
});

it('refuses an unreadable factor source rather than offering a false enrolment state', async () => {
  state.error = new Error('read failed');
  await expect(SecuritySettingsPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
    'MFA factor status is unavailable',
  );
  state.error = null;
  state.rows = null;
  await expect(SecuritySettingsPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
    'MFA factor status is unavailable',
  );
});
