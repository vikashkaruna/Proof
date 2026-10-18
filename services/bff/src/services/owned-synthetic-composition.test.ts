import { expect, it } from 'vitest';
import { readOwnedSyntheticConfiguration } from './owned-synthetic-composition.js';
function source() {
  return {
    AXIOM_OWNED_SYNTHETIC_ENABLED: 'true',
    ENVIRONMENT: 'local',
    AXIOM_AUTH_MODE: 'strict',
    AXIOM_OWNED_TARGET_CREDENTIAL_DIRECTORY: '/protected/owned-target-credentials',
  };
}
it.each(['staging', 'preprod', 'production', 'onprem', 'development', ''])(
  'refuses unreviewed synthetic environment%s',
  (environment) =>
    expect(readOwnedSyntheticConfiguration({ ...source(), ENVIRONMENT: environment })).toBeNull(),
);
it.each(['e2e-bypass', 'permissive', 'disabled', 'Strict', ''])(
  'requires strict real Auth rather than%s',
  (mode) =>
    expect(readOwnedSyntheticConfiguration({ ...source(), AXIOM_AUTH_MODE: mode })).toBeNull(),
);
it('requires explicit enablement and an absolute unambiguous protected directory', () => {
  expect(
    readOwnedSyntheticConfiguration({ ...source(), AXIOM_OWNED_SYNTHETIC_ENABLED: 'false' }),
  ).toBeNull();
  for (const directory of ['', 'relative/credentials', '/protected/../foreign'])
    expect(
      readOwnedSyntheticConfiguration({
        ...source(),
        AXIOM_OWNED_TARGET_CREDENTIAL_DIRECTORY: directory,
      }),
    ).toBeNull();
});
it('refuses the legacy global target key even with an otherwise valid directory', () => {
  expect(
    readOwnedSyntheticConfiguration({
      ...source(),
      SUPABASE_OWNED_TARGET_CONTROLLER_KEY: 'legacy-global-target-key',
    }),
  ).toBeNull();
});
it('returns a directory only; credentials resolve by current tenant/binding authority per request', () => {
  expect(readOwnedSyntheticConfiguration(source())).toEqual({
    credentialDirectory: '/protected/owned-target-credentials',
  });
  expect(readOwnedSyntheticConfiguration({ ...source(), ENVIRONMENT: 'test' })).not.toBeNull();
});
