import { resolve } from 'node:path';
import {
  insertLocalFixtureRows,
  insertOwnedFixtureEngagements,
  remoteFixtureDatabaseUrl,
  type FixtureTable,
  type FixtureTarget,
} from '../../scripts/lib/local-fixture-db';
import { acceptanceTarget, repoRoot } from './target';

/**
 * Privileged insert of one SYNTHETIC fixture row (see
 * scripts/lib/local-fixture-db.ts). Persona journeys use it because 0099 removed
 * plan/action DML from the service credential.
 */
export function insertLocalFixtureRow(
  table: FixtureTable,
  row: Record<string, unknown>,
  proof: { tenantId: string; engagementId: string },
): Promise<void> {
  const stateDir = process.env.AXIOM_PARITY_STATE_DIR ?? resolve(repoRoot, '.axiom-runtime/parity');
  const target: FixtureTarget =
    acceptanceTarget?.topology === 'remote'
      ? {
          repoRoot,
          remote: {
            databaseUrl: remoteFixtureDatabaseUrl(acceptanceTarget),
            proof: [proof],
          },
        }
      : { repoRoot, stateDir };
  return insertLocalFixtureRows(target, table, [row]);
}

/** Imports synthetic historical parents only into the proven disposable parity stack. */
export function insertOwnedEngagementFixtures(
  rows: unknown,
  apiUrl: string,
  serviceKey: string,
): void {
  if (acceptanceTarget?.topology === 'remote')
    throw new Error('Owned engagement fixtures refuse remote targets');
  insertOwnedFixtureEngagements({
    repoRoot,
    apiUrl,
    serviceKey,
    stateDir: process.env.AXIOM_PARITY_STATE_DIR ?? resolve(repoRoot, '.axiom-runtime/parity'),
    rows,
  });
}
