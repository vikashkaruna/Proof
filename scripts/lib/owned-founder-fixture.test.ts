import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  designateOwnedFixtureFounder,
  wantsGlobalFounder,
  assertLocalFounderFixtureTarget,
} from './owned-founder-fixture.js';

test('only a genuine internal founder fixture defaults to global designation', () => {
  assert.equal(wantsGlobalFounder({ role: 'founder', isInternal: true }), true);
  for (const options of [
    {},
    { role: 'owner', isInternal: true },
    { role: 'founder', isInternal: false },
    { role: 'founder', isInternal: true, globalFounder: false },
  ])
    assert.equal(wantsGlobalFounder(options), false);
  assert.throws(() => wantsGlobalFounder({ role: 'owner', isInternal: true, globalFounder: true }));
  assert.throws(() => wantsGlobalFounder({ role: 'founder', globalFounder: true }));
});

test('reserved or real accounts never reach the protected designation callback', async () => {
  let called = false;
  for (const email of [
    'founder-test@example.invalid',
    'founder@axiomproof.ai',
    'journey-owned@axiomproof.ai',
  ])
    await assert.rejects(
      designateOwnedFixtureFounder({
        root: '/missing-owned-fixture',
        supabaseUrl: 'http://localhost:54321',
        serviceKey: 'synthetic',
        userId: randomUUID(),
        email,
        designate: async () => {
          called = true;
        },
      }),
      /Synthetic founder account required/,
    );
  assert.equal(called, false);
});

test('a fresh synthetic identity cannot designate without actual owned parity proof', async () => {
  let called = false;
  await assert.rejects(
    designateOwnedFixtureFounder({
      root: '/missing-owned-fixture',
      supabaseUrl: 'http://localhost:54321',
      serviceKey: 'synthetic',
      userId: randomUUID(),
      email: 'journey-owner-12345678@example.invalid',
      designate: async () => {
        called = true;
      },
    }),
  );
  assert.equal(called, false);
});

test('verified disposable binding calls only the protected designation RPC and rechecks ownership', async (t) => {
  const { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const childProcess = (await import('node:child_process')).default;
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'axiom-founder-fixture-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, '.axiom-runtime/parity');
  mkdirSync(join(directory, 'supabase'), { recursive: true });
  writeFileSync(join(directory, 'supabase/config.toml'), 'project_id = "axiom-w0-parity"\n');
  writeFileSync(
    join(directory, 'status.json'),
    JSON.stringify({ API_URL: 'http://127.0.0.1:56321', SERVICE_ROLE_KEY: 'synthetic-owned-key' }),
  );
  let ownership = directory;
  t.mock.method(childProcess, 'execFileSync', (_command: string, args: string[]) =>
    JSON.stringify({
      id: 'a'.repeat(64),
      labels: {
        'com.supabase.cli.project': 'axiom-w0-parity',
        'com.supabase.cli.workdir': ownership,
      },
      ports: args.at(-1)?.startsWith('supabase_db')
        ? { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '56322' }] }
        : { '8000/tcp': [{ HostIp: '127.0.0.1', HostPort: '56321' }] },
    }),
  );
  const calls: unknown[] = [];
  const input = {
    root,
    environment: {},
    supabaseUrl: 'http://127.0.0.1:56321',
    serviceKey: 'synthetic-owned-key',
    userId: randomUUID(),
    email: 'persona-founder-1234abcd@example.invalid',
    designate: async (body: unknown) => {
      calls.push(body);
    },
  };
  await designateOwnedFixtureFounder(input);
  assert.equal(calls.length, 1);
  assert.equal((calls[0] as { p_user_id: string }).p_user_id, input.userId);
  for (const patch of [
    { serviceKey: 'foreign-key' },
    { supabaseUrl: 'https://retained.example.invalid' },
  ])
    await assert.rejects(designateOwnedFixtureFounder({ ...input, ...patch }), /target differs/);
  ownership = '/foreign/worktree';
  await assert.rejects(designateOwnedFixtureFounder(input), /ownership refused/);
  assert.equal(calls.length, 1);
});

test('remote fixture authority is refused before account creation', () => {
  assertLocalFounderFixtureTarget(undefined);
  assertLocalFounderFixtureTarget('local-docker');
  assert.throws(() => assertLocalFounderFixtureTarget('remote'), /owned local parity/);
});
