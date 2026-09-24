import path from 'node:path';
import { loadAcceptanceTarget, acceptanceStatePath } from '../../scripts/lib/acceptance-target';
import type { PersonaState } from './personas';
export const repoRoot = path.resolve(__dirname, '..', '..');
export const acceptanceTarget = loadAcceptanceTarget();
if (process.env.PLAYWRIGHT_BASE_URL && !acceptanceTarget)
  throw new Error(
    'Deployed browser tests require AXIOM_ACCEPTANCE_TARGET; a base URL alone cannot bind credentials safely.',
  );
if (
  process.env.PLAYWRIGHT_BASE_URL &&
  new URL(process.env.PLAYWRIGHT_BASE_URL).origin !== acceptanceTarget?.webUrl
)
  throw new Error('Browser base URL differs from the acceptance target');
export const personaStatePath = acceptanceStatePath(acceptanceTarget, repoRoot);
export const webOrigin = acceptanceTarget?.webUrl ?? 'http://localhost:3001';
export const marketingUrl = acceptanceTarget?.marketingUrl ?? 'http://localhost:3000';
export function tenantCookie(slug: string) {
  return {
    name: 'axiom_active_tenant',
    value: slug,
    url: `${webOrigin}/`,
    sameSite: 'Lax' as const,
  };
}
export function assertPersonaTarget(state: PersonaState) {
  if (acceptanceTarget) {
    const expected = acceptanceTarget;
    const actual = state.deployment;
    if (
      !actual ||
      actual.id !== expected.deploymentId ||
      actual.environment !== expected.environment ||
      actual.revision !== expected.expectedRevision ||
      actual.webUrl !== expected.webUrl ||
      actual.bffUrl !== expected.bffUrl ||
      actual.marketingUrl !== expected.marketingUrl ||
      state.supabaseUrl !== expected.supabaseUrl ||
      state.serviceKey !== expected.serviceKey ||
      state.anonKey !== expected.anonKey ||
      state.publishableKey !== expected.publishableKey
    )
      throw new Error(
        'Persona state does not match the selected acceptance deployment; seed that target first',
      );
  } else if (state.deployment)
    throw new Error('Deployed persona state cannot be used with local dev servers');
}
