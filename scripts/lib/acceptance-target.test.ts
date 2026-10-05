import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateAcceptanceTarget,
  acceptanceStatePath,
  verifyAcceptanceTarget,
  canSelectSyntheticCurrentLibrary,
} from './acceptance-target.js';
const valid = () => ({
  schemaVersion: 1,
  syntheticFixtures: true,
  deploymentId: 'preprod-check',
  environment: 'preprod',
  topology: 'remote',
  expectedRevision: 'a'.repeat(40),
  bffUrl: 'https://bff.example.invalid',
  webUrl: 'https://web.example.invalid',
  marketingUrl: 'https://marketing.example.invalid',
  supabaseUrl: 'https://auth.example.invalid',
  anonKey: 'anon'.repeat(10),
  publishableKey: 'public'.repeat(10),
  serviceKey: 'secret'.repeat(10),
});
test('target binds isolated state to a named deployment', () => {
  const target = validateAcceptanceTarget(valid());
  assert.match(acceptanceStatePath(target), /acceptance\/preprod-check\/personas.json$/);
  assert.notEqual(acceptanceStatePath(target), acceptanceStatePath(null));
});
for (const patch of [
  { syntheticFixtures: false },
  { bffUrl: 'http://bff.example.invalid' },
  { bffUrl: 'https://user:password@bff.example.invalid' },
  { webUrl: 'https://web.example.invalid/another-app' },
  { webUrl: 'https://localhost' },
  { deploymentId: '../../other' },
  { expectedRevision: 'latest' },
  { MFA_KEY: 'should-never-be-supplied' },
])
  test(`rejects unsafe or ambiguous target field ${Object.keys(patch)[0]}`, () => {
    assert.throws(() => validateAcceptanceTarget({ ...valid(), ...patch }));
  });
test('loopback HTTP needs explicit local Docker provenance', () => {
  const target = {
    ...valid(),
    topology: 'local-docker',
    bffUrl: 'http://127.0.0.1:5400',
    webUrl: 'http://localhost:5301',
    marketingUrl: 'http://localhost:5300',
    supabaseUrl: 'http://localhost:56321',
  };
  const local = validateAcceptanceTarget(target);
  assert.equal(local.topology, 'local-docker');
  assert.equal(canSelectSyntheticCurrentLibrary(local), true);
  assert.equal(canSelectSyntheticCurrentLibrary(null), true);
  assert.equal(canSelectSyntheticCurrentLibrary(validateAcceptanceTarget(valid())), false);
  assert.throws(() => validateAcceptanceTarget({ ...target, bffUrl: 'http://outside.invalid' }));
});
test('preflight refuses wrong revision before contacting marketing', async (t) => {
  const mock = t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        JSON.stringify({
          status: 'ok',
          environment: 'preprod',
          authMode: 'strict',
          revision: 'b'.repeat(40),
        }),
      ),
  );
  await assert.rejects(verifyAcceptanceTarget(validateAcceptanceTarget(valid())), /does not match/);
  assert.equal(mock.mock.callCount(), 1);
});
test('preflight refuses configured external email instead of sending test mail', async (t) => {
  let n = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    n++;
    return n === 1
      ? Response.json({ environment: 'preprod', authMode: 'strict', revision: 'a'.repeat(40) })
      : n === 2
        ? new Response('', { status: 401 })
        : n === 3
          ? Response.json({ emailDeliveryEnabled: false })
          : n <= 5
            ? Response.json({
                environment: 'preprod',
                authMode: 'strict',
                revision: 'a'.repeat(40),
              })
            : Response.json({ emailConfigured: true });
  });
  await assert.rejects(
    verifyAcceptanceTarget(validateAcceptanceTarget(valid())),
    /disabled external email/,
  );
});

test('refuses broadly readable target credentials', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { loadAcceptanceTarget } = await import('./acceptance-target.js');
  const dir = mkdtempSync(`${tmpdir()}/axiom-target-`);
  try {
    const file = `${dir}/target.json`;
    writeFileSync(file, JSON.stringify(valid()), { mode: 0o644 });
    if (process.platform !== 'win32') assert.throws(() => loadAcceptanceTarget(file), /chmod 600/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('preflight refuses report delivery before creating anonymous reports', async (t) => {
  let n = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    n++;
    if (n === 1)
      return Response.json({
        environment: 'preprod',
        authMode: 'strict',
        revision: 'a'.repeat(40),
      });
    if (n === 2) return new Response('', { status: 401 });
    return Response.json({ emailDeliveryEnabled: true });
  });
  await assert.rejects(
    verifyAcceptanceTarget(validateAcceptanceTarget(valid())),
    /disabled external email/,
  );
  assert.equal(n, 3);
});

test('named local browser fixtures cannot overwrite retained default persona state', () => {
  assert.equal(
    acceptanceStatePath(null, '/isolated-review', 'assessment-request'),
    '/isolated-review/.axiom-runtime/personas/assessment-request/state.json',
  );
  assert.notEqual(
    acceptanceStatePath(null, '/isolated-review', 'assessment-request'),
    acceptanceStatePath(null, '/isolated-review'),
  );
  assert.notEqual(
    acceptanceStatePath(null, '/isolated-review', 'assessment-request'),
    acceptanceStatePath(null, '/isolated-review', 'another-review'),
  );
});
test('rejects unsafe local persona names instead of escaping protected fixture state', () => {
  for (const name of ['', '../retained', '/absolute', 'path/name', 'name.with.dot', 'x'.repeat(65)])
    assert.throws(() => acceptanceStatePath(null, '/isolated-review', name), /safe run name/);
});
test('deployed target cannot use a local persona override', () => {
  assert.throws(
    () =>
      acceptanceStatePath(
        validateAcceptanceTarget(valid()),
        '/isolated-review',
        'assessment-request',
      ),
    /isolated local target/,
  );
});
