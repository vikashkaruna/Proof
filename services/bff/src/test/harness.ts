import { vi } from 'vitest';

/**
 * Shared harness for the BFF middleware suite (W9).
 *
 * Two things make these middlewares awkward to test, and both are handled here:
 *
 *  1. They call `loadEnv()` at module scope, so `process.env` has to be set
 *     before the module under test is imported. `withEnv()` does that and
 *     returns a dynamic import.
 *  2. They construct a Supabase client per request. `mockSupabase()` installs
 *     a controllable double so a test can make auth succeed, fail, or become
 *     unreachable — the last being the case that used to fail *open* (SEC-1).
 */

export const FOUNDER_ID = '00000000-0000-0000-0000-000000000001';
export const TENANT_A = '11111111-1111-1111-1111-111111111111';
export const TENANT_B = '22222222-2222-2222-2222-222222222222';

export const BASE_ENV = {
  SUPABASE_URL: 'https://deployed.supabase.co',
  SUPABASE_ANON_KEY: 'a'.repeat(40),
  SUPABASE_SERVICE_KEY: 'b'.repeat(40),
  APPROVAL_SIGNING_KEY: 'k'.repeat(48),
  AGENT_RUNTIME_INTERNAL_TOKEN: 't'.repeat(32),
  AGENT_RUNTIME_URL: 'https://agent-runtime.internal',
  MODEL_GATEWAY_API_KEY: 'm'.repeat(32),
  AXIOM_MFA_ENCRYPTION_KEY: 'f'.repeat(48),
} as const;

/** Apply an environment to `process.env`, clearing the keys this suite owns. */
export function applyEnv(overrides: Record<string, string | undefined> = {}): void {
  for (const key of [
    'ENVIRONMENT',
    'NODE_ENV',
    'AXIOM_AUTH_MODE',
    'AXIOM_E2E_BYPASS_AUTH',
    ...Object.keys(BASE_ENV),
  ]) {
    delete process.env[key];
  }
  const merged: Record<string, string | undefined> = { ...BASE_ENV, ...overrides };
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

type AuthOutcome =
  | { kind: 'user'; id: string; email?: string }
  | { kind: 'error'; message: string }
  | { kind: 'unreachable'; message: string };

type MembershipOutcome = { role: string } | null;

/**
 * Installs a mock for `@supabase/supabase-js`. Must be called from inside a
 * `vi.mock` factory or before the module under test is imported.
 */
export function createSupabaseDouble(options: {
  auth?: AuthOutcome;
  membership?: MembershipOutcome;
  idempotencyHit?: { response_status: number; response_body: unknown } | null;
}) {
  const state = {
    auth: options.auth ?? { kind: 'user' as const, id: FOUNDER_ID },
    membership: options.membership ?? null,
    idempotencyHit: options.idempotencyHit ?? null,
    inserted: [] as unknown[],
    claimDecision: null as Record<string, unknown> | null,
    failRpc: null as string | null,
  };

  const createClient = vi.fn(() => ({
    rpc: async (name: string) => {
      if (state.failRpc === name) return { data: null, error: { message: 'database unavailable' } };
      if (name === 'complete_request') return { data: true, error: null };
      if (name === 'claim_request')
        return {
          data:
            state.claimDecision ??
            (state.idempotencyHit
              ? {
                  decision: 'replay',
                  status: state.idempotencyHit.response_status,
                  body: state.idempotencyHit.response_body,
                }
              : { decision: 'claimed', id: '44444444-4444-4444-8444-444444444444' }),
          error: null,
        };
      throw new Error(`Unmocked RPC: ${name}`);
    },
    auth: {
      getUser: async () => {
        if (state.auth.kind === 'unreachable') throw new Error(state.auth.message);
        if (state.auth.kind === 'error') {
          return { data: { user: null }, error: { message: state.auth.message } };
        }
        return {
          data: {
            user: {
              id: state.auth.id,
              email: state.auth.email ?? 'user@example.com',
              aud: 'authenticated',
              role: 'authenticated',
              app_metadata: {},
              user_metadata: {},
              created_at: '2026-01-01T00:00:00.000Z',
            },
          },
          error: null,
        };
      },
    },
    from: (table: string) => {
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      builder.select = chain;
      builder.eq = chain;
      builder.insert = (rows: unknown) => {
        state.inserted.push({ table, rows });
        return Promise.resolve({ data: null, error: null });
      };
      builder.single = async () =>
        state.membership
          ? { data: state.membership, error: null }
          : { data: null, error: { message: 'no rows' } };
      builder.maybeSingle = async () =>
        table === 'idempotency_keys'
          ? { data: state.idempotencyHit, error: null }
          : { data: state.membership, error: null };
      return builder;
    },
  }));

  return { createClient, state };
}
