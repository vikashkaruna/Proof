import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { withMfaFixtureLock } from './login-mfa-lock';

const artifactRoot = resolve('.axiom-runtime/review/mfa-lock-tests');
async function fixture(operation: (parent: string, locks: string, user: string) => Promise<void>) {
  await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
  const parent = await mkdtemp(join(artifactRoot, 'owned-'));
  const locks = join(parent, 'locks');
  try {
    await operation(parent, locks, randomUUID());
  } finally {
    await rm(parent, { recursive: true });
  }
}

test('two independent callers cannot hold the same user lock simultaneously', async () => {
  await fixture(async (_, locks, user) => {
    let active = 0;
    let completed = 0;
    const run = () =>
      withMfaFixtureLock(
        locks,
        user,
        async () => {
          assert.equal(++active, 1);
          await delay(15);
          assert.equal(active--, 1);
          completed++;
        },
        { pollMs: 2, timeoutMs: 1_000 },
      );
    await Promise.all([run(), run()]);
    assert.equal(completed, 2);
    assert.deepEqual(await readdir(locks), []);
    assert.equal((await lstat(locks)).mode & 0o777, 0o700);
  });
});

test('a refused verification releases only its own lock', async () => {
  await fixture(async (_, locks, user) => {
    await assert.rejects(
      withMfaFixtureLock(locks, user, async () => {
        throw new Error('verification refused');
      }),
      /verification refused/,
    );
    assert.deepEqual(await readdir(locks), []);
    assert.equal(await withMfaFixtureLock(locks, user, async () => 'reacquired'), 'reacquired');
  });
});

test('an existing foreign lock times out without stealing or deleting it', async () => {
  await fixture(async (_, locks, user) => {
    await mkdir(join(locks, user), { recursive: true, mode: 0o700 });
    const owner = join(locks, user, 'owner');
    await writeFile(owner, 'synthetic-foreign-owner', { mode: 0o600 });
    await assert.rejects(
      withMfaFixtureLock(locks, user, async () => assert.fail('must not run'), {
        timeoutMs: 5,
        pollMs: 2,
      }),
      /no stale lock was stolen/,
    );
    assert.equal(await readFile(owner, 'utf8'), 'synthetic-foreign-owner');
  });
});

test('symlink root or per-user lock refuses before executing verification', async () => {
  await fixture(async (parent, locks, user) => {
    const destination = join(parent, 'destination');
    await mkdir(destination, { mode: 0o700 });
    await symlink(destination, locks);
    await assert.rejects(
      withMfaFixtureLock(locks, user, async () => assert.fail('must not run')),
      /not a symlink/,
    );
    assert.deepEqual(await readdir(destination), []);
    await rm(locks);
    await mkdir(locks, { mode: 0o700 });
    await symlink(destination, join(locks, user));
    await assert.rejects(
      withMfaFixtureLock(locks, user, async () => assert.fail('must not run')),
      /not a symlink/,
    );
    assert.deepEqual(await readdir(destination), []);
  });
});

test('nonprivate fixture root refuses without changing permissions', async () => {
  await fixture(async (_, locks, user) => {
    await mkdir(locks, { mode: 0o700 });
    // Set the owned negative fixture explicitly; mkdir modes depend on umask.
    await chmod(locks, 0o755);
    await assert.rejects(
      withMfaFixtureLock(locks, user, async () => assert.fail('must not run')),
      /private/,
    );
    assert.equal((await lstat(locks)).mode & 0o777, 0o755);
    assert.deepEqual(await readdir(locks), []);
  });
});

test('changed ownership token fails closed and leaves replacement untouched', async () => {
  await fixture(async (_, locks, user) => {
    const owner = join(locks, user, 'owner');
    await assert.rejects(
      withMfaFixtureLock(locks, user, async () => {
        assert.equal((await lstat(owner)).mode & 0o777, 0o600);
        await writeFile(owner, 'synthetic-replacement-token');
      }),
      /foreign lock left untouched/,
    );
    assert.equal(await readFile(owner, 'utf8'), 'synthetic-replacement-token');
  });
});

test('invalid identity cannot escape the private fixture directory', async () => {
  await fixture(async (_, locks) => {
    await assert.rejects(
      withMfaFixtureLock(locks, '../foreign', async () => assert.fail('must not run')),
      /identity/,
    );
  });
});

// Separate Node processes exercise the same ownership boundary as Playwright workers.
test('independent worker processes serialize one identity without an in-memory mutex', async () => {
  await fixture(async (parent, locks, user) => {
    const moduleUrl = pathToFileURL(resolve('tests/e2e/fixtures/login-mfa-lock.ts')).href;
    const occupied = join(parent, 'occupied');
    const source = `
      const { withMfaFixtureLock } = await import(process.argv[1]);
      const { writeFile, unlink } = await import('node:fs/promises');
      const { setTimeout } = await import('node:timers/promises');
      await withMfaFixtureLock(process.argv[2], process.argv[3], async () => {
        await writeFile(process.argv[4], 'occupied', { flag: 'wx', mode: 0o600 });
        await setTimeout(100);
        await unlink(process.argv[4]);
      }, { pollMs: 2, timeoutMs: 5000 });
    `;
    const worker = () =>
      new Promise<void>((resolveWorker, reject) => {
        const child = spawn(
          process.execPath,
          [
            '--import',
            'tsx',
            '--input-type=module',
            '-e',
            source,
            moduleUrl,
            locks,
            user,
            occupied,
          ],
          { stdio: ['ignore', 'ignore', 'pipe'] },
        );
        let diagnostic = '';
        child.stderr.on('data', (chunk: Buffer) => {
          diagnostic += chunk.toString();
        });
        child.on('error', reject);
        child.on('exit', (code) =>
          code === 0
            ? resolveWorker()
            : reject(new Error(`Synthetic worker failed: ${diagnostic}`)),
        );
      });
    await Promise.all([worker(), worker(), worker()]);
    assert.deepEqual(await readdir(locks), []);
  });
});
