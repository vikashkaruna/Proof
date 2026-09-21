/** Private stdin from the isolated SPIRE test. Never log tokens or subprocess errors. */
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { JwtSvidVerifier } from '../services/bff/src/workloads/jwt-svid.js';
const agents = [
  'drishti',
  'vibhaag',
  'parikshan',
  'saakshi',
  'sudhaar',
  'karya',
  'lekha',
  'nazar',
  'prativedan',
  'sanket',
] as const;
const inputSchema = z
  .object({
    cases: z
      .array(
        z
          .object({ agent: z.enum(agents), token: z.string().max(16384), jwks: z.unknown() })
          .strict(),
      )
      .length(10),
  })
  .strict();
async function main() {
  const input = inputSchema.parse(JSON.parse(readFileSync(0, 'utf8')));
  if (new Set(input.cases.map((c) => c.agent)).size !== 10) throw new Error('fixture');
  const outcomes: Record<string, boolean> = {};
  for (const item of input.cases) {
    const config = {
      audience: 'axiom-credential-broker',
      trustDomains: ['local.axiomproof.test'],
      maxLifetimeSeconds: 300,
    };
    let current = true;
    const trust = {
      async load() {
        return { revision: 'isolated-current', validUntil: Date.now() + 60000, jwks: item.jwks };
      },
      async stillCurrent() {
        return current;
      },
    };
    const verifier = new JwtSvidVerifier(config, trust);
    const identity = await verifier.verify(item.token);
    if (identity.spiffeId !== `spiffe://local.axiomproof.test/agent/${item.agent}`)
      throw new Error('identity');
    outcomes[item.agent + '.signature'] = true;
    const refuses = async (attempt: () => Promise<unknown>) => {
      try {
        await attempt();
      } catch {
        return;
      }
      throw new Error('unexpected acceptance');
    };
    await refuses(() =>
      new JwtSvidVerifier({ ...config, audience: 'another-service' }, trust).verify(item.token),
    );
    outcomes[item.agent + '.audience-refusal'] = true;
    const parts = item.token.split('.');
    await refuses(() =>
      verifier.verify(parts[0] + '.' + parts[1] + '.' + Buffer.alloc(64).toString('base64url')),
    );
    outcomes[item.agent + '.signature-refusal'] = true;
    current = false;
    await refuses(() => verifier.verify(item.token));
    outcomes[item.agent + '.retired-bundle-refusal'] = true;
  }
  process.stdout.write(JSON.stringify({ passed: true, outcomes }) + '\n');
}
main().catch(() => {
  process.stderr.write(
    'Workload identity verification failed. Private identity material was not logged.\n',
  );
  process.exitCode = 1;
});
