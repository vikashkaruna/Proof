import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import SecuritySettingsPage from './page';

const state = vi.hoisted(() => ({
  rows: [] as unknown[] | null,
  error: null as Error | null,
  recovery: null as unknown,
  recoveryError: null as Error | null,
  founder: false,
}));
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
          if (table === 'platform_founders') {
            const query = {
              select: () => query,
              eq: () => query,
              is: async () => ({ data: state.founder ? [{ user_id: 'u1' }] : [], error: null }),
            };
            return query;
          }
          if (table !== 'user_mfa_factors') throw new Error('unexpected source');
          return { select: async () => ({ data: state.rows, error: state.error }) };
        },
        rpc: async (name: string) => {
          if (name !== 'read_my_mfa_recovery') throw new Error('unexpected rpc');
          return { data: state.recovery, error: state.recoveryError };
        },
      },
      userId: 'u1',
    };
  },
}));
vi.mock('./mfa-enrolment', () => ({
  MfaEnrolment: (props: unknown) => <pre>{JSON.stringify(props)}</pre>,
}));
vi.mock('./recovery-panels', () => ({
  RecoveryBeneficiary: (props: unknown) => <pre>{'BENEFICIARY ' + JSON.stringify(props)}</pre>,
  RecoveryConsole: () => <pre>CONSOLE</pre>,
}));
vi.mock('./delegation-panels', () => ({
  DelegationManager: () => <pre>DELEGATIONS</pre>,
  OwnerRecoveryPanel: () => <pre>OWNER-RECOVERY</pre>,
}));
beforeEach(() => {
  state.rows = [];
  state.error = null;
  state.recovery = null;
  state.recoveryError = null;
  state.founder = false;
});

const activeTotp = {
  id: 'f1',
  factor_type: 'totp',
  status: 'active',
  label: 'Primary',
  activated_at: '2026-09-30',
  last_used_at: null,
  consumed_at: null,
};

it('replaces ordinary enrolment with the recovery panel while the account is under recovery', async () => {
  state.rows = [activeTotp];
  state.founder = true;
  state.recovery = { case_id: 'c1', state: 'bound', bound_here: true, session_id: 's1' };
  const view = renderToStaticMarkup(
    await SecuritySettingsPage({ searchParams: Promise.resolve({}) }),
  );
  expect(view).toContain('BENEFICIARY');
  expect(view).toContain('&quot;caseId&quot;:&quot;c1&quot;');
  expect(view).not.toContain('&quot;enrolled&quot;');
  expect(view).not.toContain('CONSOLE');
});

it('offers the recovery console only to an enrolled platform founder', async () => {
  state.rows = [activeTotp];
  state.founder = true;
  expect(
    renderToStaticMarkup(await SecuritySettingsPage({ searchParams: Promise.resolve({}) })),
  ).toContain('CONSOLE');
  state.founder = false;
  expect(
    renderToStaticMarkup(await SecuritySettingsPage({ searchParams: Promise.resolve({}) })),
  ).not.toContain('CONSOLE');
  state.founder = true;
  state.rows = [];
  expect(
    renderToStaticMarkup(await SecuritySettingsPage({ searchParams: Promise.resolve({}) })),
  ).not.toContain('CONSOLE');
});

it('offers owner recovery only to an enrolled, non-founder owner; delegation management only to founders', async () => {
  state.rows = [activeTotp];
  state.founder = false;
  const owner = renderToStaticMarkup(
    await SecuritySettingsPage({ searchParams: Promise.resolve({}) }),
  );
  expect(owner).toContain('OWNER-RECOVERY');
  expect(owner).not.toContain('DELEGATIONS');
  state.founder = true;
  const founder = renderToStaticMarkup(
    await SecuritySettingsPage({ searchParams: Promise.resolve({}) }),
  );
  expect(founder).toContain('DELEGATIONS');
  expect(founder).not.toContain('OWNER-RECOVERY');
  state.founder = false;
  state.rows = [];
  expect(
    renderToStaticMarkup(await SecuritySettingsPage({ searchParams: Promise.resolve({}) })),
  ).not.toContain('OWNER-RECOVERY');
});

it('refuses to render when recovery state is unreadable', async () => {
  state.recoveryError = new Error('rpc down');
  await expect(SecuritySettingsPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
    'Recovery status is unavailable',
  );
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
