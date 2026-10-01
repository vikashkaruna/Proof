import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  insertLocalFixtureRows,
  localDatabaseUrl,
  updateLocalFixtureRow,
  type FixtureTable,
} from './local-fixture-db.js';

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
