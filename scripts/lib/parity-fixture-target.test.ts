import test from 'node:test';
import childProcess from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import {
  selectParityFixture,
  validateParityFixtureEvidence,
  type ParityFixtureEvidence,
  guardedParitySql,
  loadParityFixture,
} from './parity-fixture-target.js';
const root = '/owned/axiom';
function fixture(alternate = false) {
  const selection = selectParityFixture(
    root,
    alternate
      ? {
          AXIOM_PARITY_PROJECT_ID: 'axiom-assessment-request-acceptance',
          AXIOM_PARITY_STATE_DIR: '/owned/axiom/.axiom-runtime/parity-assessment-request',
        }
      : {},
  );
  const labels = {
    'com.supabase.cli.project': selection.projectId,
    'com.supabase.cli.workdir': selection.stateDirectory,
  };
  const evidence: ParityFixtureEvidence = {
    resolvedRoot: root,
    resolvedStateDirectory: selection.stateDirectory,
    resolvedConfigPath: selection.configPath,
    resolvedStatusPath: selection.statusPath,
    config: `project_id = "${selection.projectId}"\n`,
    status: { API_URL: 'http://127.0.0.1:56321' },
    databaseId: 'a'.repeat(64),
    databaseLabels: { ...labels },
    apiLabels: { ...labels },
    databasePorts: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '56322' }] },
    apiPorts: { '8000/tcp': [{ HostIp: '127.0.0.1', HostPort: '56321' }] },
  };
  return { selection, evidence };
}
for (const alternate of [false, true])
  test(`verified ${alternate ? 'alternate' : 'default'} fixture preserves fixed loopback API and exact ownership`, () => {
    const { selection, evidence } = fixture(alternate),
      valid = validateParityFixtureEvidence(selection, evidence);
    assert.equal(valid.apiOrigin, 'http://127.0.0.1:56321');
    assert.equal(valid.databaseContainer, `supabase_db_${selection.projectId}`);
    if (alternate)
      assert.equal(valid.stateDirectory, '/owned/axiom/.axiom-runtime/parity-assessment-request');
  });
for (const patch of [
  { AXIOM_PARITY_PROJECT_ID: 'foreign' },
  { AXIOM_PARITY_PROJECT_ID: 'axiom-x;bad' },
  { AXIOM_PARITY_PROJECT_ID: 'axiom-../../x' },
  { AXIOM_PARITY_STATE_DIR: '/other/worktree/.axiom-runtime/parity' },
  { AXIOM_PARITY_STATE_DIR: '../other/parity' },
  { AXIOM_PARITY_STATE_DIR: '.axiom-runtime' },
])
  test(`rejects invalid selection ${JSON.stringify(patch)}`, () =>
    assert.throws(() => selectParityFixture(root, patch)));
for (const url of [
  'https://127.0.0.1:56321',
  'http://outside.invalid:56321',
  'http://127.0.0.1:59621',
  'http://user:secret@127.0.0.1:56321',
  'http://127.0.0.1:56321/private',
  'http://127.0.0.1:56321/?credentials=hidden',
  'http://127.0.0.1:56321/#fragment',
  'http://127.0.0.1:56321/?',
  'http://127.0.0.1:56321/#',
  'http://@127.0.0.1:56321',
  'broken',
])
  test(`refuses status URL ${url.split('@').pop()}`, () => {
    const { selection, evidence } = fixture(true);
    evidence.status.API_URL = url;
    assert.throws(() => validateParityFixtureEvidence(selection, evidence));
  });
for (const field of [
  'resolvedRoot',
  'resolvedStateDirectory',
  'resolvedConfigPath',
  'resolvedStatusPath',
] as const)
  test(`refuses symlink/foreign canonical ${field}`, () => {
    const { selection, evidence } = fixture();
    evidence[field] = '/other/worktree';
    assert.throws(() => validateParityFixtureEvidence(selection, evidence));
  });
for (const field of ['databaseLabels', 'apiLabels'] as const)
  for (const label of ['com.supabase.cli.project', 'com.supabase.cli.workdir'])
    test(`refuses ${field} ${label} mismatch even on default project`, () => {
      const { selection, evidence } = fixture();
      evidence[field][label] = '/foreign/retained/worktree';
      assert.throws(() => validateParityFixtureEvidence(selection, evidence));
    });
for (const config of [
  'project_id = "axiom-foreign"',
  'project_id = "axiom-w0-parity"\nproject_id = "axiom-w0-parity"',
  'no_project = "axiom-w0-parity"',
])
  test('refuses ambiguous or mismatched config ' + config, () => {
    const { selection, evidence } = fixture();
    evidence.config = config;
    assert.throws(() => validateParityFixtureEvidence(selection, evidence));
  });
for (const field of ['databasePorts', 'apiPorts'] as const)
  for (const bad of [
    null,
    [],
    [{ HostIp: '127.0.0.1', HostPort: '59621' }],
    [{ HostIp: '192.168.1.1', HostPort: field === 'apiPorts' ? '56321' : '56322' }],
  ])
    test(`refuses missing/wrong ${field} ${JSON.stringify(bad)}`, () => {
      const { selection, evidence } = fixture(true);
      evidence[field][field === 'apiPorts' ? '8000/tcp' : '5432/tcp'] = bad;
      assert.throws(() => validateParityFixtureEvidence(selection, evidence));
    });

for (const id of [undefined, null, '', 'name-not-id', 'a'.repeat(63), 'Z'.repeat(64)])
  test('rejects missing/invalid immutable Docker ID ' + String(id), () => {
    const { selection, evidence } = fixture();
    evidence.databaseId = id as string;
    assert.throws(() => validateParityFixtureEvidence(selection, evidence));
  });
test('administrative SQL rechecks ownership every call and pins the verified container ID', (t) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'axiom-fixture-guard-')));
  try {
    const env = {
      AXIOM_PARITY_PROJECT_ID: 'axiom-assessment-request-acceptance',
      AXIOM_PARITY_STATE_DIR: join(directory, '.axiom-runtime/parity-assessment-request'),
    };
    const selection = selectParityFixture(directory, env);
    mkdirSync(join(selection.stateDirectory, 'supabase'), { recursive: true });
    writeFileSync(selection.configPath, `project_id = "${selection.projectId}"\n`);
    writeFileSync(selection.statusPath, JSON.stringify({ API_URL: 'http://127.0.0.1:56321' }));
    let ownership = selection.stateDirectory;
    const calls: string[][] = [];
    t.mock.method(childProcess, 'execFileSync', (_command: string, args: string[]) => {
      calls.push(args);
      if (args[0] === 'exec') return 'fixture-row\n';
      const database = args.at(-1) === selection.databaseContainer;
      return JSON.stringify({
        id: 'a'.repeat(64),
        labels: {
          'com.supabase.cli.project': selection.projectId,
          'com.supabase.cli.workdir': ownership,
        },
        ports: {
          [database ? '5432/tcp' : '8000/tcp']: [
            { HostIp: '127.0.0.1', HostPort: database ? '56322' : '56321' },
          ],
        },
      });
    });
    assert.equal(guardedParitySql('select 1;', 'supabase_admin', directory, env), 'fixture-row\n');
    assert.equal(calls.filter((args) => args[0] === 'exec').length, 1);
    assert.equal(calls.find((args) => args[0] === 'exec')![2], 'a'.repeat(64));
    ownership = '/foreign/retained/worktree';
    assert.throws(() => guardedParitySql('select 1;', 'supabase_admin', directory, env));
    assert.equal(
      calls.filter((args) => args[0] === 'exec').length,
      1,
      'foreign replacement must not receive another SQL invocation',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects a symlinked status before reading credentials or inspecting Docker', (t) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'axiom-fixture-symlink-')));
  try {
    const selection = selectParityFixture(directory, {});
    mkdirSync(join(selection.stateDirectory, 'supabase'), { recursive: true });
    writeFileSync(selection.configPath, `project_id = "${selection.projectId}"\n`);
    const external = join(directory, 'foreign-private-status.json');
    writeFileSync(external, JSON.stringify({ API_URL: 'http://127.0.0.1:56321' }));
    symlinkSync(external, selection.statusPath);
    const inspect = t.mock.method(childProcess, 'execFileSync', () => {
      throw new Error('Docker must not be contacted');
    });
    assert.throws(() => loadParityFixture(directory, {}), /canonical paths refused/);
    assert.equal(inspect.mock.callCount(), 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// Exercise Playwright's real CommonJS TypeScript config loader, not tsx's ESM loader.
test('registered browser helper loads in Playwright CommonJS config without CLI side effects', () => {
  const repo = process.cwd();
  const parent = join(repo, '.axiom-runtime');
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(parent, 'parity-config-import-'));
  try {
    const config = join(directory, 'playwright.config.ts');
    writeFileSync(
      config,
      `import { registeredBrowserRequested } from ${JSON.stringify(resolve(repo, 'scripts/lib/acceptance-public-asset-browser.ts'))};\nif (registeredBrowserRequested({})) throw new Error('unexpected fixture mode');\nexport default { testDir: ${JSON.stringify(directory)}, testMatch: 'absent.spec.ts' };\n`,
      { mode: 0o600 },
    );
    const result = childProcess.spawnSync(
      process.execPath,
      [
        resolve(repo, 'tests/e2e/node_modules/@playwright/test/cli.js'),
        'test',
        '--list',
        '--pass-with-no-tests',
        '--config',
        config,
      ],
      {
        cwd: repo,
        encoding: 'utf8',
        timeout: 10000,
        env: { ...process.env, AXIOM_REGISTERED_WEBSITE_BROWSER: '' },
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Total: 0 tests/);
    assert.equal(result.stderr.includes('Owned parity fixture refused'), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
