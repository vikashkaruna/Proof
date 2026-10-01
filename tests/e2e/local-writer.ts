import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mintLocalPostgrestRoleKey } from '../../packages/supabase/src/local-proof-writer-key';
import { repoRoot } from './target';
import type { PersonaState } from './personas';

/**
 * Local-only Bearer for a restricted PostgREST role of the isolated parity
 * stack. Fixture RPCs that append human-labelled ledger events (0099: only
 * human_action_writer may execute them) must use this, never the service key.
 */
export function localRoleBearer(role: 'human_action_writer', state: PersonaState) {
  const status = JSON.parse(
    readFileSync(
      resolve(
        process.env.AXIOM_PARITY_STATE_DIR ?? resolve(repoRoot, '.axiom-runtime/parity'),
        'status.json',
      ),
      'utf8',
    ),
  ) as Record<string, string>;
  if (status.API_URL !== state.supabaseUrl || status.SERVICE_ROLE_KEY !== state.serviceKey)
    throw new Error('Persona state and local Supabase signing target differ');
  return mintLocalPostgrestRoleKey({
    role,
    jwtSecret: status.JWT_SECRET!,
    serviceKey: state.serviceKey,
  });
}
