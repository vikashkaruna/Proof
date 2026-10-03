import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  insertLocalFixtureRows,
  localDatabaseUrl,
  remoteFixtureDatabaseUrl,
  updateLocalFixtureRow,
  verifyRemoteFixtureBinding,
  type FixtureTable,
} from './local-fixture-db.js';
import type { AcceptanceTarget } from './acceptance-target.js';

function stateWith(status: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'axiom-fixture-db-'));
  writeFileSync(join(dir, 'status.json'), JSON.stringify(status));
  return dir;
}

const repoRoot = process.cwd();

test('only a loopback database is ever targeted', () => {
  for (const host of ['127.0.0.1', 'localhost']) {
    const dir = stateWith({ DB_URL: `postgresql://postgres:x@${host}:5432/postgres` });
    assert.equal(localDatabaseUrl(dir), `postgresql://postgres:x@${host}:5432/postgres`);
  }
  for (const url of [
    'postgresql://postgres:x@db.internal.example:5432/postgres',
    'postgresql://postgres:x@10.0.0.5:5432/postgres',
    'postgresql://postgres:x@34.1.2.3:5432/postgres',
  ]) {
    assert.throws(() => localDatabaseUrl(stateWith({ DB_URL: url })), /non-loopback/);
  }
  assert.throws(
    () =>
      localDatabaseUrl(
        stateWith({ DB_URL: 'postgresql://postgres:x@127.0.0.1:5432/postgres?host=db.internal' }),
      ),
    /query parameters/,
  );
  assert.throws(() => localDatabaseUrl(stateWith({})), /no DB_URL/);
});

test('refuses a table outside the allow-list before connecting', async () => {
  const stateDir = stateWith({ DB_URL: 'postgresql://postgres:x@127.0.0.1:1/postgres' });
  await assert.rejects(
    insertLocalFixtureRows({ repoRoot, stateDir }, 'audit_ledger' as unknown as FixtureTable, [
      { id: '1' },
    ]),
    /Unsupported fixture table/,
  );
  await assert.rejects(
    updateLocalFixtureRow({ repoRoot, stateDir }, 'tenants' as unknown as FixtureTable, 'x', {
      name: 'x',
    }),
    /Unsupported fixture table/,
  );
});

test('refuses column names that are not plain identifiers', async () => {
  const stateDir = stateWith({ DB_URL: 'postgresql://postgres:x@127.0.0.1:1/postgres' });
  for (const column of ['id; drop table x', 'Id', 'a b', '"id"', '']) {
    await assert.rejects(
      updateLocalFixtureRow({ repoRoot, stateDir }, 'remediation_plans', 'x', { [column]: 1 }),
      /Invalid fixture column name/,
      `accepted column ${JSON.stringify(column)}`,
    );
  }
  await assert.rejects(
    insertLocalFixtureRows({ repoRoot, stateDir }, 'remediation_plans', [
      { 'id) values (1); --': 1 },
    ]),
    /Invalid fixture column name/,
  );
  await assert.rejects(
    updateLocalFixtureRow({ repoRoot, stateDir }, 'remediation_plans', 'x', {}),
    /Invalid fixture column name/,
  );
});

const remoteTarget = {
  topology: 'remote',
  environment: 'preprod',
  deploymentId: 'preprod-fixture',
  expectedRevision: 'a'.repeat(40),
} as AcceptanceTarget;

function remoteFile(overrides: Record<string, unknown> = {}, mode = 0o600): string {
  const dir = mkdtempSync(join(tmpdir(), 'axiom-remote-fixture-'));
  const file = join(dir, 'database.json');
  writeFileSync(
    file,
    JSON.stringify({
      schemaVersion: 1,
      deploymentId: remoteTarget.deploymentId,
      environment: remoteTarget.environment,
      expectedRevision: remoteTarget.expectedRevision,
      databaseUrl: 'postgresql://owner:secret@127.0.0.1:15432/postgres',
      ...overrides,
    }),
    { mode: 0o600 },
  );
  chmodSync(file, mode);
  return file;
}

test('remote fixture credential is private, target-bound and tunnel-only', () => {
  assert.equal(
    remoteFixtureDatabaseUrl(remoteTarget, remoteFile()),
    'postgresql://owner:secret@127.0.0.1:15432/postgres',
  );
  assert.throws(() => remoteFixtureDatabaseUrl(remoteTarget, ''), /AXIOM_ACCEPTANCE_FIXTURE_DB/);
  assert.throws(
    () => remoteFixtureDatabaseUrl(remoteTarget, remoteFile({ deploymentId: 'another' })),
    /does not match/,
  );
  assert.throws(
    () => remoteFixtureDatabaseUrl(remoteTarget, remoteFile({ expectedRevision: 'b'.repeat(40) })),
    /does not match/,
  );
  assert.throws(
    () =>
      remoteFixtureDatabaseUrl(
        remoteTarget,
        remoteFile({ databaseUrl: 'postgresql://owner:secret@db.internal/postgres' }),
      ),
    /non-loopback/,
  );
  assert.throws(
    () =>
      remoteFixtureDatabaseUrl(
        remoteTarget,
        remoteFile({
          databaseUrl: 'postgresql://owner:secret@127.0.0.1:15432/postgres?host=db.internal',
        }),
      ),
    /query parameters/,
  );
  assert.throws(() => remoteFixtureDatabaseUrl(remoteTarget, remoteFile({}, 0o644)), /private/);
  assert.throws(
    () => remoteFixtureDatabaseUrl({ ...remoteTarget, environment: 'production' }, remoteFile()),
    /non-production/,
  );
});

test('remote fixture write requires the freshly seeded engagement on that database', async () => {
  const calls: unknown[][] = [];
  const proof = [
    { tenantId: 'tenant-a', engagementId: 'engagement-a' },
    { tenantId: 'tenant-b', engagementId: 'engagement-b' },
  ];
  const client = {
    query: async (_sql: string, values: unknown[]) => {
      calls.push(values);
      return { rowCount: values[1] === 'engagement-b' ? 0 : 1 };
    },
  };
  await assert.rejects(verifyRemoteFixtureBinding(client, []), /requires a seeded engagement/);
  await assert.rejects(verifyRemoteFixtureBinding(client, proof), /does not contain/);
  assert.deepEqual(calls, [
    ['tenant-a', 'engagement-a'],
    ['tenant-b', 'engagement-b'],
  ]);
});
