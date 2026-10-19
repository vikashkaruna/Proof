import { afterEach, expect, it, vi } from 'vitest';
import { ownedDeploymentAccess } from './owned-deployment-access';
afterEach(() => vi.unstubAllEnvs());
it('limits local setup entry points to owner, admin or a genuinely internal founder', () => {
  vi.stubEnv('AXIOM_OWNED_SYNTHETIC_ENABLED', 'true');
  vi.stubEnv('ENVIRONMENT', 'local');
  vi.stubEnv('AXIOM_AUTH_MODE', 'strict');
  for (const role of ['owner', 'admin'])
    expect(ownedDeploymentAccess(role, false).available).toBe(true);
  expect(ownedDeploymentAccess('founder', true).available).toBe(true);
  for (const role of ['viewer', 'reviewer', 'approver', 'founder', 'axiom_analyst'])
    expect(ownedDeploymentAccess(role, false).available).toBe(false);
  vi.stubEnv('ENVIRONMENT', 'prod');
  expect(ownedDeploymentAccess('owner', true).available).toBe(false);
  vi.stubEnv('ENVIRONMENT', 'local');
  vi.stubEnv('AXIOM_AUTH_MODE', 'dev');
  expect(ownedDeploymentAccess('owner', true).available).toBe(false);
  vi.stubEnv('AXIOM_AUTH_MODE', 'strict');
  vi.stubEnv('AXIOM_OWNED_SYNTHETIC_ENABLED', 'false');
  expect(ownedDeploymentAccess('founder', true).available).toBe(false);
});
