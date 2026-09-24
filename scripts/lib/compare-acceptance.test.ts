import test from 'node:test';
import assert from 'node:assert/strict';
import { compareAcceptance, type Evidence } from './compare-acceptance.js';
const results = (): Evidence[] =>
  ['preprod', 'production'].map((environment) => ({
    schemaVersion: 1,
    passed: true,
    completedAt: new Date().toISOString(),
    kind: 'deployed-http',
    deploymentId: environment,
    environment,
    topology: 'local-docker',
    revision: 'a'.repeat(40),
    bffUrl: `https://${environment}.example.invalid`,
    outcomes: { unauthenticated: 401, isolation: true },
  }));
test('compares equivalent successful suites across two deployments', () =>
  compareAcceptance(results()));
for (const patch of [
  { revision: 'b'.repeat(40) },
  { topology: 'remote' },
  { passed: false },
  { completedAt: '' },
  { deploymentId: 'preprod' },
  { bffUrl: 'https://preprod.example.invalid' },
  { environment: 'preprod' },
  { outcomes: {} },
  { outcomes: { unauthenticated: 200, isolation: true } },
])
  test(`refuses incomplete/divergent evidence: ${JSON.stringify(patch)}`, () => {
    const pair = results();
    Object.assign(pair[1]!, patch);
    assert.throws(() => compareAcceptance(pair));
  });
test('matching failures cannot be mistaken for passing browser parity', () => {
  const pair = results().map((r) => ({
    ...r,
    kind: 'deployed-browser',
    webUrl: r.bffUrl,
    outcomes: { journey: false },
  }));
  assert.throws(() => compareAcceptance(pair));
});
