import { expect, it } from 'vitest';
import { readOwnedSyntheticConfiguration } from './owned-synthetic-composition.js';
function token(
  role = 'owned_target_controller',
  exp = Math.floor(Date.now() / 1000) + 3600,
  extra: Record<string, unknown> = {},
) {
  return `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ role, exp, ...extra })).toString('base64url')}.component-claims-only-not-authenticated`;
}
function source() {
  return {
    AXIOM_OWNED_SYNTHETIC_ENABLED: 'true',
    ENVIRONMENT: 'local',
    AXIOM_AUTH_MODE: 'strict',
    SUPABASE_OWNED_TARGET_CONTROLLER_KEY: token(),
  };
}
it.each(['staging', 'preprod', 'production', 'onprem', 'development', ''])(
  'synthetic target configuration unavailable in%s',
  (environment) => {
    expect(readOwnedSyntheticConfiguration({ ...source(), ENVIRONMENT: environment })).toBeNull();
  },
);
it('synthetic configuration requires explicit enablement and strict Auth', () => {
  expect(
    readOwnedSyntheticConfiguration({ ...source(), AXIOM_OWNED_SYNTHETIC_ENABLED: 'false' }),
  ).toBeNull();
  expect(
    readOwnedSyntheticConfiguration({ ...source(), AXIOM_AUTH_MODE: 'e2e-bypass' }),
  ).toBeNull();
});
it.each([
  'service_role',
  'human_action_writer',
  'agent_ledger_writer',
  'evidence_ingestion_writer',
  'authenticated',
])('unscoped/wrong role%s refused', (role) => {
  expect(
    readOwnedSyntheticConfiguration({
      ...source(),
      SUPABASE_OWNED_TARGET_CONTROLLER_KEY: token(role),
    }),
  ).toBeNull();
});
it.each([0, Math.floor(Date.now() / 1000) - 1, Number.MAX_VALUE, 3.2])(
  'expired or invalid expiration%s refused',
  (exp) => {
    expect(
      readOwnedSyntheticConfiguration({
        ...source(),
        SUPABASE_OWNED_TARGET_CONTROLLER_KEY: token('owned_target_controller', exp),
      }),
    ).toBeNull();
  },
);
it('future nbf and malformed JWT refused', () => {
  expect(
    readOwnedSyntheticConfiguration({
      ...source(),
      SUPABASE_OWNED_TARGET_CONTROLLER_KEY: token(
        'owned_target_controller',
        Math.floor(Date.now() / 1000) + 3600,
        { nbf: Math.floor(Date.now() / 1000) + 60 },
      ),
    }),
  ).toBeNull();
  expect(
    readOwnedSyntheticConfiguration({
      ...source(),
      SUPABASE_OWNED_TARGET_CONTROLLER_KEY: 'not-a-token',
    }),
  ).toBeNull();
});
it.each([
  'SUPABASE_SERVICE_KEY',
  'SUPABASE_HUMAN_ACTION_WRITER_KEY',
  'SUPABASE_AGENT_LEDGER_WRITER_KEY',
  'SUPABASE_EVIDENCE_INGESTION_WRITER_KEY',
])('target key cannot equal %s', (field) => {
  const s = source();
  expect(
    readOwnedSyntheticConfiguration({ ...s, [field]: s.SUPABASE_OWNED_TARGET_CONTROLLER_KEY }),
  ).toBeNull();
});
it('valid distinct local/test scoped claims expose no target registration or endpoint selection', () => {
  const s = source();
  expect(readOwnedSyntheticConfiguration(s)).toEqual({
    targetKey: s.SUPABASE_OWNED_TARGET_CONTROLLER_KEY,
  });
  expect(readOwnedSyntheticConfiguration({ ...s, ENVIRONMENT: 'test' })).not.toBeNull();
});

it.each(['permissive', 'disabled', 'Strict', ''])(
  'unrecognized Auth mode %s refuses target configuration',
  (mode) => {
    expect(readOwnedSyntheticConfiguration({ ...source(), AXIOM_AUTH_MODE: mode })).toBeNull();
  },
);
