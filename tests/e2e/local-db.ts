import { resolve } from 'node:path';
import { insertLocalFixtureRows, type FixtureTable } from '../../scripts/lib/local-fixture-db';
import { repoRoot } from './target';

/**
 * Local-only privileged insert of one SYNTHETIC fixture row (see
 * scripts/lib/local-fixture-db.ts). Persona journeys use it because 0099 removed
 * plan/action DML from the service credential.
 */
export function insertLocalFixtureRow(
  table: FixtureTable,
  row: Record<string, unknown>,
): Promise<void> {
  const stateDir = process.env.AXIOM_PARITY_STATE_DIR ?? resolve(repoRoot, '.axiom-runtime/parity');
  return insertLocalFixtureRows({ repoRoot, stateDir }, table, [row]);
}
