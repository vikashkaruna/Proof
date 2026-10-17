import assert from 'node:assert/strict';
import { test } from 'node:test';
import { custodyBrowserFixtureGuard } from './acceptance-local-custody-browser';
import { selectParityFixture, validateParityFixtureEvidence } from './parity-fixture-target-core';

const root = '/owned/axiom';
const persona = {
  supabaseUrl: 'http://127.0.0.1:56321',
  serviceKey: 'synthetic-service',
  publishableKey: 'synthetic-publishable',
  anonKey: 'synthetic-anon',
};
function fixture() {
  const selection = selectParityFixture(root, {});
  const labels = {
    'com.supabase.cli.project': selection.projectId,
    'com.supabase.cli.workdir': selection.stateDirectory,
  };
  return validateParityFixtureEvidence(selection, {
    resolvedRoot: root,
    resolvedStateDirectory: selection.stateDirectory,
    resolvedConfigPath: selection.configPath,
    resolvedStatusPath: selection.statusPath,
    config: `project_id = "${selection.projectId}"`,
    status: {
      API_URL: persona.supabaseUrl,
      SERVICE_ROLE_KEY: persona.serviceKey,
      PUBLISHABLE_KEY: persona.publishableKey,
      ANON_KEY: persona.anonKey,
    },
    databaseId: 'a'.repeat(64),
    databaseLabels: labels,
    apiLabels: labels,
    databasePorts: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '56322' }] },
    apiPorts: { '8000/tcp': [{ HostIp: '127.0.0.1', HostPort: '56321' }] },
  });
}
test('owned parity is checked before each synthetic mutation', () => {
  let loads = 0,
    writes = 0;
  const guard = custodyBrowserFixtureGuard(root, persona, () => {
    loads++;
    return fixture();
  });
  guard();
  writes++;
  guard();
  writes++;
  assert.equal(loads, 2);
  assert.equal(writes, 2);
});
for (const field of ['supabaseUrl', 'serviceKey', 'publishableKey', 'anonKey'] as const) {
  test(`foreign persona ${field} refuses before account or fixture mutation`, () => {
    let writes = 0;
    const wrong = {
      ...persona,
      [field]: field === 'supabaseUrl' ? 'http://127.0.0.1:57121' : 'foreign-synthetic',
    };
    const guard = custodyBrowserFixtureGuard(root, wrong, () => fixture());
    assert.throws(() => {
      guard();
      writes++;
    }, /binding refused/);
    assert.equal(writes, 0);
  });
}
test('loader ownership refusal cannot reach any fixture write', () => {
  let writes = 0;
  const guard = custodyBrowserFixtureGuard(root, persona, () => {
    throw Error('Fixture Docker ownership refused');
  });
  assert.throws(() => {
    guard();
    writes++;
  }, /ownership refused/);
  assert.equal(writes, 0);
});
for (const field of ['databaseId', 'projectId', 'stateDirectory'] as const) {
  test(`replacement ${field} is refused after initial valid setup`, () => {
    let current = fixture(),
      writes = 0;
    const guard = custodyBrowserFixtureGuard(root, persona, () => current);
    guard();
    writes++;
    current = { ...current, [field]: field === 'databaseId' ? 'b'.repeat(64) : 'replacement' };
    assert.throws(() => {
      guard();
      writes++;
    }, /replacement refused/);
    assert.equal(writes, 1);
  });
}
