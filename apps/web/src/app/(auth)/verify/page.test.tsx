import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import VerifyPage from './page';

const state = vi.hoisted(() => ({
  user: { id: 'user-1', email: 'owner@example.invalid' } as { id: string; email: string } | null,
  factors: [{ id: 'factor-1' }] as Array<{ id: string }> | null,
  memberships: [{ tenant_id: 'tenant-1' }] as Array<{ tenant_id: string }> | null,
  factorError: null as Error | null,
  membershipError: null as Error | null,
}));
vi.mock('next/navigation', () => ({
  redirect: (target: string) => {
    throw new Error(`REDIRECT ${target}`);
  },
}));
vi.mock('@axiom/supabase', () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
    from: (table: string) => {
      const query = {
        select: () => query,
        eq: () => query,
        limit: async () =>
          table === 'user_mfa_factors'
            ? { data: state.factors, error: state.factorError }
            : { data: state.memberships, error: state.membershipError },
      };
      return query;
    },
  }),
}));
vi.mock('./verify-form', () => ({
  VerifyForm: (props: unknown) => <pre>{JSON.stringify(props)}</pre>,
}));
beforeEach(() => {
  state.user = { id: 'user-1', email: 'owner@example.invalid' };
  state.factors = [{ id: 'factor-1' }];
  state.memberships = [{ tenant_id: 'tenant-1' }];
  state.factorError = null;
  state.membershipError = null;
});

it('binds verification to a recorded membership and refuses an external redirect', async () => {
  const view = renderToStaticMarkup(
    await VerifyPage({ searchParams: Promise.resolve({ redirect: '//evil.example' }) }),
  );
  expect(view).toContain('&quot;tenantId&quot;:&quot;tenant-1&quot;');
  expect(view).toContain('&quot;redirectTo&quot;:&quot;/dashboard&quot;');
  expect(view).not.toContain('evil.example');
});

it('refuses missing authentication or factor enrolment', async () => {
  state.user = null;
  await expect(VerifyPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
    'REDIRECT /login',
  );
  state.user = { id: 'user-1', email: 'owner@example.invalid' };
  state.factors = [];
  await expect(VerifyPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
    'REDIRECT /settings/security?enrol=required',
  );
});

it('does not turn factor or membership read failures into enrolment or onboarding', async () => {
  state.factorError = new Error('source failed');
  await expect(VerifyPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
    'MFA factor status is unavailable',
  );
  state.factorError = null;
  state.factors = null;
  await expect(VerifyPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
    'MFA factor status is unavailable',
  );
  state.factors = [{ id: 'factor-1' }];
  state.membershipError = new Error('source failed');
  await expect(VerifyPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
    'Tenant membership is unavailable',
  );
  state.membershipError = null;
  state.memberships = null;
  await expect(VerifyPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
    'Tenant membership is unavailable',
  );
});

it('sends a user without a recorded tenant to onboarding', async () => {
  state.memberships = [];
  await expect(VerifyPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
    'REDIRECT /onboarding',
  );
});
