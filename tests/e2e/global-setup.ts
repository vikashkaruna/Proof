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
    const state = JSON.parse(readFileSync(personaStatePath, 'utf8'));
    assertPersonaTarget(state);
    const writerKey = process.env.SUPABASE_HUMAN_ACTION_WRITER_KEY;
    if (!writerKey) throw new Error('BFF-only human action writer JWT is missing');
    // A non-existent tenant/actor makes this a read-only authority probe
    // (release moved to the human writer in 0100). It proves
    // that PostgREST accepted this exact key and reached the guarded RPC;
    // a wrong-target or generic service JWT cannot return this response.
    const response = await fetch(
      `${state.supabaseUrl}/rest/v1/rpc/release_approval_proof_archive`,
      {
        method: 'POST',
        signal: AbortSignal.timeout(10_000),
        headers: {
          apikey: state.anonKey,
          Authorization: `Bearer ${writerKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          p_tenant_id: '00000000-0000-4000-8000-0000000000ff',
          p_actor_id: '00000000-0000-4000-8000-0000000000fe',
          p_archive_id: '00000000-0000-4000-8000-0000000000fd',
          p_source_sha256: 'a'.repeat(64),
          p_version_id: 'probe',
          p_correlation_id: '00000000-0000-4000-8000-0000000000fc',
        }),
      },
    );
    const result: unknown = await response.json();
    if (
      !response.ok ||
      !result ||
      typeof result !== 'object' ||
      !('error' in result) ||
      result.error !== 'founder_authority_required'
    )
      throw new Error('Human writer JWT failed the exact PostgREST target and role probe');
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
