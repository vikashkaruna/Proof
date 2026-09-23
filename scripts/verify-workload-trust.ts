/** Runs only inside the trusted acceptance controller image. Stdin may contain
 * a synthetic SVID; stdout contains only fixed boolean outcomes, never keys. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { WorkloadApiJwtTrust } from '../services/bff/src/workloads/workload-api-trust.js';
import { JwtSvidVerifier } from '../services/bff/src/workloads/jwt-svid.js';
let phase = 'input';
async function main() {
  const input = z
    .object({
      mode: z.enum(['registered', 'unregistered', 'unavailable']),
      token: z.string().max(16384),
    })
    .strict()
    .parse(JSON.parse(readFileSync(0, 'utf8')));
  const trust = new WorkloadApiJwtTrust({
    socketPath: '/run/workload/api.sock',
    trustDomains: ['local.axiomproof.test'],
    timeoutMs: 2000,
  });
  const verifier = new JwtSvidVerifier(
    {
      audience: 'axiom-credential-broker',
      trustDomains: ['local.axiomproof.test'],
      maxLifetimeSeconds: 300,
    },
    trust,
  );
  phase = 'load';
  if (input.mode === 'registered') {
    assert(await trust.load('local.axiomproof.test'));
    phase = 'verify';
    const identity = await verifier.verify(input.token);
    assert.equal(identity.spiffeId, 'spiffe://local.axiomproof.test/agent/parikshan');
    phase = 'currentness';
    assert(await trust.stillCurrent(identity.trustDomain, identity.bundleRevision));
    assert.equal(await trust.load('foreign.test'), null);
  } else {
    assert.equal(await trust.load('local.axiomproof.test'), null);
    await assert.rejects(verifier.verify(input.token), {
      message: 'Workload identity was refused.',
    });
  }
  process.stdout.write(JSON.stringify({ passed: true, mode: input.mode }));
}
main().catch(() => {
  process.stderr.write(`Protected Workload API acceptance refused at ${phase}.\n`);
  process.exitCode = 1;
});
