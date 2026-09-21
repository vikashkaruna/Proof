import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Refuse to run persona journeys without seeded personas.
 *
 * Without this the suite would start, every sign-in would fail, and the
 * result would read as "the login page is broken" rather than "nobody ran the
 * seed". The distinction matters because the first is a defect report and the
 * second is a missing step.
 */
export default async function globalSetup() {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const state = path.join(repoRoot, '.axiom-runtime/personas/state.json');
  if (existsSync(state)) return;

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
