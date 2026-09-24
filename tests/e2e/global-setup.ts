import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { acceptanceTarget, personaStatePath, assertPersonaTarget } from './target';
import { verifyAcceptanceTarget } from '../../scripts/lib/acceptance-target';

/**
 * Refuse to run persona journeys without seeded personas.
 *
 * Without this the suite would start, every sign-in would fail, and the
 * result would read as "the login page is broken" rather than "nobody ran the
 * seed". The distinction matters because the first is a defect report and the
 * second is a missing step.
 */
export default async function globalSetup() {
  if (acceptanceTarget) await verifyAcceptanceTarget(acceptanceTarget);
  if (existsSync(personaStatePath)) {
    assertPersonaTarget(JSON.parse(readFileSync(personaStatePath, 'utf8')));
    return;
  }

  throw new Error(
    [
      'No seeded personas found.',
      '',
      'These journeys sign in as real GoTrue accounts against the parity stack,',
      'because the former e2e bypass resolved every caller to one founder identity',
      'and could not tell a viewer from an owner.',
      '',
      'Run:',
      '  ./scripts/start-parity-supabase.sh',
      '  pnpm exec tsx scripts/seed-personas.ts',
    ].join('\n'),
  );
}
