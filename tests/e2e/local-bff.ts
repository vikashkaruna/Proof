/** Local-owned Playwright entrypoint only. Production/deployed acceptance keeps
 * services/bff/src/index.ts. Browser job responses remain explicit simulations;
 * this fixture exposes scoped configuration metadata and ALWAYS refuses dispatch. */
import { readFileSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { z } from 'zod';
import { loadParityFixture } from '../../scripts/lib/parity-fixture-target.js';
import { localAssessmentUiFixture } from '../../scripts/lib/local-assessment-ui-fixture.js';
import { acceptanceTarget, personaStatePath, assertPersonaTarget, repoRoot } from './target.js';
import type { PersonaState } from './personas.js';

async function main() {
  const parity = loadParityFixture(repoRoot);
  const state: PersonaState = JSON.parse(readFileSync(personaStatePath, 'utf8'));
  assertPersonaTarget(state);
  const { tenant, producer } = localAssessmentUiFixture({
    environment: process.env.ENVIRONMENT,
    authMode: process.env.AXIOM_AUTH_MODE,
    deployed: Boolean(acceptanceTarget),
    application: {
      url: process.env.SUPABASE_URL,
      anonKey: process.env.SUPABASE_ANON_KEY,
      serviceKey: process.env.SUPABASE_SERVICE_KEY,
    },
    parity,
    persona: state,
  });
  // Confirm the same synthetic tenant exists in the verified owned database.
  const response = await fetch(
    `${parity.apiOrigin}/rest/v1/tenants?id=eq.${tenant.id}&select=id,slug,name`,
    {
      headers: { apikey: state.anonKey, Authorization: `Bearer ${state.serviceKey}` },
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    },
  );
  if (response.status !== 200) throw new Error('Fixture tenant read refused');
  const [saved] = z
    .array(z.object({ id: z.uuid(), slug: z.string(), name: z.string() }))
    .length(1)
    .parse(await response.json());
  if (!saved || saved.id !== tenant.id || saved.slug !== tenant.slug || saved.name !== tenant.name)
    throw new Error('Fixture tenant identity refused');
  const port = z.coerce.number().int().min(1024).max(65535).parse(process.env.BFF_PORT);
  const { createHumanActionWriter, createEvidenceIngestionWriter } =
    await import('../../packages/supabase/src/index.js');
  createHumanActionWriter();
  createEvidenceIngestionWriter();
  const { createApp } = await import('../../services/bff/src/app.js');
  const app = createApp({ assessmentRequests: producer });
  serve({ fetch: app.fetch, port, hostname: '127.0.0.1' });
}
main().catch(() => {
  // Never print credential-bearing Zod issues, file contents or fetch errors.
  process.stderr.write(
    'Local assessment UI fixture startup refused. Private diagnostics withheld.\n',
  );
  process.exitCode = 1;
});
