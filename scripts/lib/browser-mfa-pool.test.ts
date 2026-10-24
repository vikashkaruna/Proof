import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { generateSecret } from '@axiom/mfa';
import {
  browserMfaPoolEnabled,
  mfaPoolFactorReadPath,
  verifyMfaPoolAccountRows,
  mfaPoolMembershipReadPath,
  BROWSER_MFA_POOL_DEMAND,
  prepareBrowserMfaPool,
  leaseBrowserMfaAccount,
  type MfaPoolAccount,
} from './browser-mfa-pool.js';

async function fixture(context: TestContext, count = 2) {
  const parent = await mkdtemp(join(await realpath(tmpdir()), 'axiom-browser-mfa-'));
  await chmod(parent, 0o700);
  context.after(() => rm(parent, { recursive: true, force: true }));
  const directory = join(parent, 'pool');
  const binding = {
    deploymentId: 'axiom-http-fixture',
    revision: 'a'.repeat(40),
    tenantId: randomUUID(),
    bffUrl: 'http://localhost:4000',
    webUrl: 'http://localhost:3001',
    marketingUrl: 'http://localhost:3000',
    supabaseUrl: 'http://localhost:54321',
  };
  let now = 29_000;
  const waits: number[] = [];
  const accounts: MfaPoolAccount[] = [];
  await prepareBrowserMfaPool({
    directory,
    binding,
    demand: [{ role: 'owner', internal: false, count }],
    clock: {
      now: () => now,
      wait: async (ms) => {
        waits.push(ms);
        now += ms;
      },
    },
    provision: async (identity) => {
      const account = {
        profileCase: 'ordinary' as const,
        ...identity,
        id: randomUUID(),
        email: `${randomUUID()}@example.invalid`,
        password: randomUUID(),
        totpSecret: generateSecret(20),
        consumedCounter: 0,
      };
      accounts.push(account);
      return account;
    },
  });
  const lease = (overrides: Partial<Parameters<typeof leaseBrowserMfaAccount>[0]> = {}) =>
    leaseBrowserMfaAccount({
      directory,
      binding,
      identity: { role: 'owner', internal: false },
      verify: async () => true,
      now: () => now,
      ...overrides,
    });
  return {
    parent,
    directory,
    binding,
    accounts,
    waits,
    lease,
    setNow: (value: number) => {
      now = value;
    },
  };
}
test('batch readiness waits once past the actually consumed activation counter', async (context) => {
  const f = await fixture(context, 12);
  assert.deepEqual(f.waits, [1500]);
  assert.equal((await f.lease()).consumedCounter, 0);
});
test('slow activation response already beyond its consumed boundary needs no additional window', async (context) => {
  const parent = await mkdtemp(join(await realpath(tmpdir()), 'axiom-browser-mfa-'));
  await chmod(parent, 0o700);
  context.after(() => rm(parent, { recursive: true, force: true }));
  const f = await fixture(context);
  const waits: number[] = [];
  await prepareBrowserMfaPool({
    directory: join(parent, 'pool'),
    binding: f.binding,
    demand: [{ role: 'owner', internal: false, count: 2 }],
    clock: {
      now: () => 31_000,
      wait: async (ms) => {
        waits.push(ms);
      },
    },
    provision: async () => f.accounts.pop()!,
  });
  assert.deepEqual(waits, []);
});
test('concurrent workers receive distinct accounts and exhaustion never falls back', async (context) => {
  const f = await fixture(context);
  const results = await Promise.all([f.lease(), f.lease()]);
  assert.notEqual(results[0].id, results[1].id);
  await assert.rejects(f.lease(), /exhausted/);
});
test('live readback refusal burns the account and cannot be retried or reused', async (context) => {
  const f = await fixture(context, 1);
  await assert.rejects(f.lease({ verify: async () => false }), /live account refused/);
  await assert.rejects(f.lease(), /exhausted/);
});
test('target, tenant, role and internal identity mismatches refuse before readback', async (context) => {
  const f = await fixture(context);
  let reads = 0;
  for (const binding of [
    { ...f.binding, revision: 'b'.repeat(40) },
    { ...f.binding, tenantId: randomUUID() },
    { ...f.binding, supabaseUrl: 'http://localhost:54322' },
  ])
    await assert.rejects(
      f.lease({
        binding,
        verify: async () => {
          reads++;
          return true;
        },
      }),
      /target or readiness/,
    );
  for (const identity of [
    { role: 'owner', internal: true },
    { role: 'admin', internal: false },
  ] as const)
    await assert.rejects(f.lease({ identity }), /exhausted/);
  assert.equal(reads, 0);
});
test('not-ready, future and stale timestamps refuse', async (context) => {
  const f = await fixture(context);
  for (const now of [28_000, 30_499, 629_001]) {
    f.setNow(now);
    await assert.rejects(f.lease(), /readiness/);
  }
});
test('missing and corrupt manifests fail closed', async (context) => {
  const f = await fixture(context);
  const path = join(f.directory, 'manifest.json');
  const original = await readFile(path, 'utf8');
  for (const content of [
    '{}',
    original + ' ',
    '{"version":1,"version":1}',
    original.replace('"owner"', '"administrator"'),
  ]) {
    await writeFile(path, content, { mode: 0o600 });
    await assert.rejects(f.lease());
  }
  await rm(path);
  await assert.rejects(f.lease());
});
test('unsafe file permissions and symlinks refuse without following foreign data', async (context) => {
  const f = await fixture(context);
  const path = join(f.directory, 'manifest.json');
  await chmod(path, 0o644);
  await assert.rejects(f.lease(), /file refused/);
  await chmod(path, 0o600);
  const foreign = join(f.parent, 'foreign');
  await writeFile(foreign, await readFile(path), { mode: 0o600 });
  await rm(path);
  await symlink(foreign, path);
  await assert.rejects(f.lease());
  assert.ok((await readFile(foreign)).length > 0);
});
test('corrupt existing leases refuse; a lease is never silently reclaimed', async (context) => {
  const f = await fixture(context, 1);
  await writeFile(join(f.directory, `${f.accounts[0]!.id}.lease`), '{}', { mode: 0o600 });
  await assert.rejects(f.lease(), /path refused/);
});
test('stale existing pool is not overwritten', async (context) => {
  const f = await fixture(context);
  let provisions = 0;
  await assert.rejects(
    prepareBrowserMfaPool({
      directory: f.directory,
      binding: f.binding,
      provision: async () => {
        provisions++;
        return f.accounts[0]!;
      },
    }),
  );
  assert.equal(provisions, 0);
});
test('catalogue demand includes dynamic roles and formats without sharing identities', () => {
  assert.equal(
    BROWSER_MFA_POOL_DEMAND.reduce((sum, entry) => sum + entry.count, 0),
    75,
  );
  assert.equal(
    BROWSER_MFA_POOL_DEMAND.filter((entry) => entry.role === 'viewer').reduce(
      (sum, entry) => sum + entry.count,
      0,
    ),
    1,
  );
  const analysts = BROWSER_MFA_POOL_DEMAND.filter((entry) => entry.role === 'axiom_analyst');
  assert.equal(
    analysts.reduce((sum, entry) => sum + entry.count, 0),
    4,
  );
  assert.ok(analysts.every((entry) => entry.internal));
});

test('live row guard binds actual actor, tenant, role, internal status and active factor', async (context) => {
  const f = await fixture(context);
  const account = f.accounts[0]!;
  const rows = {
    profile: [{ id: account.id, is_axiom_internal: false, email: account.email }],
    memberships: [{ user_id: account.id, tenant_id: f.binding.tenantId, role: 'owner' }],
    factors: [{ user_id: account.id, factor_type: 'totp', status: 'active' }],
  };
  assert.equal(verifyMfaPoolAccountRows(account, f.binding, rows), true);
  for (const changed of [
    { ...rows, profile: [{ id: randomUUID(), is_axiom_internal: false, email: account.email }] },
    { ...rows, profile: [{ id: account.id, is_axiom_internal: true, email: account.email }] },
    { ...rows, memberships: [{ ...rows.memberships[0], user_id: randomUUID() }] },
    { ...rows, memberships: [{ ...rows.memberships[0], tenant_id: randomUUID() }] },
    { ...rows, memberships: [{ ...rows.memberships[0], role: 'founder' }] },
    { ...rows, memberships: [] },
    { ...rows, profile: null },
    { ...rows, factors: [{ ...rows.factors[0], user_id: randomUUID() }] },
    { ...rows, factors: [{ ...rows.factors[0], status: 'pending' }] },
  ])
    assert.equal(verifyMfaPoolAccountRows(account, f.binding, changed), false);
});

test('twenty simultaneous claims never observe partial lease metadata or reuse a factor', async (context) => {
  const f = await fixture(context, 20);
  const accounts = await Promise.all(Array.from({ length: 20 }, () => f.lease()));
  assert.equal(new Set(accounts.map((account) => account.id)).size, 20);
  await assert.rejects(f.lease(), /exhausted/);
});
test('a forged lower readiness fence cannot release an already-consumed counter', async (context) => {
  const f = await fixture(context);
  const path = join(f.directory, 'manifest.json');
  const value = JSON.parse(await readFile(path, 'utf8'));
  value.readyAfter = 0;
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  f.setNow(29_000);
  await assert.rejects(f.lease());
});

test('preparation refusal awaits the other lane but starts no later provisioning', async (context) => {
  const f = await fixture(context);
  const directory = join(f.parent, 'failed');
  let calls = 0;
  let finished = false;
  await assert.rejects(
    prepareBrowserMfaPool({
      directory,
      binding: f.binding,
      demand: [{ role: 'owner', internal: false, count: 10 }],
      provision: async () => {
        const index = calls++;
        if (index === 0) throw new Error('private enrollment values');
        await new Promise((resolve) => setImmediate(resolve));
        finished = true;
        return f.accounts[0]!;
      },
    }),
    { message: 'MFA pool preparation refused' },
  );
  assert.equal(calls, 2);
  assert.equal(finished, true);
  await assert.rejects(readFile(join(directory, 'manifest.json')));
});
test('private readback exceptions never leak through a burned lease', async (context) => {
  const f = await fixture(context, 1);
  await assert.rejects(
    f.lease({
      verify: async () => {
        throw new Error('private secret contents');
      },
    }),
    { message: 'MFA pool live account refused' },
  );
  await assert.rejects(f.lease(), /exhausted/);
});

test('only explicit isolated W0 enables a pool; ordinary and remote runs never provision one', () => {
  const target = {
    topology: 'local-docker',
    deploymentId: 'http-preprod',
    syntheticFixtures: true,
  };
  assert.equal(browserMfaPoolEnabled(target, { ci: 'true', github: 'true' }), false);
  assert.equal(browserMfaPoolEnabled(null, {}), false);
  const environment = { requested: 'isolated-w0', ci: 'true', github: 'true' };
  assert.equal(browserMfaPoolEnabled(target, environment), true);
  for (const changed of [
    null,
    { ...target, topology: 'remote' },
    { ...target, deploymentId: 'retained-owner-local' },
    { ...target, syntheticFixtures: false },
  ])
    assert.throws(() => browserMfaPoolEnabled(changed, environment), /authority refused/);
  for (const changed of [
    { ...environment, ci: undefined },
    { ...environment, github: undefined },
    { ...environment, requested: 'true' },
  ])
    assert.throws(() => browserMfaPoolEnabled(target, changed), /authority refused/);
});

for (const field of ['totpSecret', 'email'] as const) {
  test(`a duplicated ${field} refuses pool publication instead of sharing an identity or factor`, async (context) => {
    const f = await fixture(context);
    let index = 0;
    await assert.rejects(
      prepareBrowserMfaPool({
        directory: join(f.parent, 'duplicates'),
        binding: f.binding,
        demand: [{ role: 'owner', internal: false, count: 2 }],
        clock: { now: () => 31_000, wait: async () => {} },
        provision: async () => ({ ...f.accounts[index++]!, [field]: f.accounts[0]![field] }),
      }),
    );
    await assert.rejects(readFile(join(f.parent, 'duplicates', 'manifest.json')));
  });
}

test('actual W0 shell scopes the pool marker to CI and preserves ordinary local invocation', async (context) => {
  const parent = await mkdtemp(join(await realpath(tmpdir()), 'axiom-w0-shell-'));
  await chmod(parent, 0o700);
  context.after(() => rm(parent, { recursive: true, force: true }));
  await mkdir(join(parent, 'scripts'), { mode: 0o700 });
  const stub = join(parent, 'scripts/run-deployed-acceptance.sh');
  await writeFile(
    stub,
    '#!/usr/bin/env bash\nprintf "%s" "${AXIOM_BROWSER_MFA_POOL-unset}|${SUPABASE_ARCHIVE_WRITER_KEY-unset}|${SUPABASE_HUMAN_ACTION_WRITER_KEY-unset}|${SUPABASE_EVIDENCE_INGESTION_WRITER_KEY-unset}" > "$AXIOM_POOL_RESULT"\n',
    { mode: 0o700 },
  );
  const source = await readFile(new URL('../test-deployed-http.sh', import.meta.url), 'utf8');
  const wrapper = source.match(/^run_browser_acceptance\(\) \{\n[\s\S]*?^\}/m)?.[0];
  assert.ok(wrapper, 'Actual reviewed W0 shell wrapper is present');
  const output = join(parent, 'result');
  for (const [ci, github, expected] of [
    ['true', 'true', 'isolated-w0'],
    ['true', '', 'unset'],
    ['', 'true', 'unset'],
    ['', '', 'unset'],
  ]) {
    execFileSync(
      'bash',
      [
        '-c',
        wrapper +
          '\nSUPABASE_ARCHIVE_WRITER_KEY=fixture-archive SUPABASE_HUMAN_ACTION_WRITER_KEY=fixture-human SUPABASE_EVIDENCE_INGESTION_WRITER_KEY=fixture-evidence run_browser_acceptance fixture',
      ],
      {
        cwd: parent,
        env: { PATH: process.env.PATH, CI: ci, GITHUB_ACTIONS: github, AXIOM_POOL_RESULT: output },
      },
    );
    assert.equal(
      await readFile(output, 'utf8'),
      `${expected}|fixture-archive|fixture-human|fixture-evidence`,
    );
  }
});

test('live TOTP projection survives retained recovery and revoked factors without accepting either', () => {
  const actor = randomUUID();
  const rows = [
    { user_id: actor, factor_type: 'totp', status: 'active' },
    { user_id: actor, factor_type: 'recovery_code', status: 'active' },
    { user_id: actor, factor_type: 'totp', status: 'revoked' },
  ];
  const query = new URL(mfaPoolFactorReadPath(actor), 'https://fixture.invalid').searchParams;
  const projected = rows.filter(
    (row) =>
      query.get('user_id') === `eq.${row.user_id}` &&
      (query.get('factor_type') === null || query.get('factor_type') === `eq.${row.factor_type}`) &&
      (query.get('status') === null || query.get('status') === `eq.${row.status}`),
  );
  assert.deepEqual(projected, [rows[0]]);
  assert.throws(() => mfaPoolFactorReadPath(actor + '&status=eq.revoked'));
});

test('global founder pool membership projection follows live authority and retains the exact pool tenant', async (context) => {
  const f = await fixture(context);
  const account = { ...f.accounts[0]!, role: 'founder' as const, internal: true };
  const memberships = [
    { user_id: account.id, tenant_id: f.binding.tenantId, role: 'founder' },
    { user_id: account.id, tenant_id: randomUUID(), role: 'founder' },
  ];
  const rows = {
    profile: [{ id: account.id, email: account.email, is_axiom_internal: true }],
    factors: [{ user_id: account.id, factor_type: 'totp', status: 'active' }],
  };
  assert.equal(verifyMfaPoolAccountRows(account, f.binding, { ...rows, memberships }), false);
  for (const authority of [undefined, false, 'true', 1, { live: true }])
    assert.throws(
      () => mfaPoolMembershipReadPath(account, f.binding, authority),
      /live global founder authority refused/,
    );
  const query = new URL(
    mfaPoolMembershipReadPath(account, f.binding, true),
    'https://fixture.invalid',
  ).searchParams;
  const project = (values: typeof memberships) =>
    values.filter(
      (row) =>
        query.get('user_id') === `eq.${row.user_id}` &&
        query.get('tenant_id') === `eq.${row.tenant_id}`,
    );
  assert.equal(
    verifyMfaPoolAccountRows(account, f.binding, { ...rows, memberships: project(memberships) }),
    true,
  );
  assert.equal(
    verifyMfaPoolAccountRows(account, f.binding, {
      ...rows,
      memberships: project(memberships.slice(1)),
    }),
    false,
  );
  assert.equal(
    verifyMfaPoolAccountRows(account, f.binding, {
      ...rows,
      memberships: project([{ ...memberships[0]!, user_id: randomUUID() }]),
    }),
    false,
  );
  const ordinary = f.accounts[0]!;
  const ordinaryQuery = new URL(
    mfaPoolMembershipReadPath(ordinary, f.binding, true),
    'https://fixture.invalid',
  ).searchParams;
  assert.equal(
    ordinaryQuery.has('tenant_id'),
    false,
    'Ordinary membership verification must retain its existing exact-one-row check',
  );
});
