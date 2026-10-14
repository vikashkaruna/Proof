import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { withFreshMfaFixtureCounter } from '../../tests/e2e/fixtures/login-mfa-counter.js';

async function fixture(run: (directory: string, id: string) => Promise<void>) {
  const root = resolve('.axiom-runtime/review/mfa-counter-tests');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const parent = await mkdtemp(join(root, 'owned-'));
  try {
    await run(join(parent, 'locks'), randomUUID());
  } finally {
    await rm(parent, { recursive: true });
  }
}
function clock(start: number) {
  let now = start;
  const waits: number[] = [];
  return {
    now: () => now,
    wait: async (ms: number) => {
      waits.push(ms);
      now += ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
    waits,
  };
}

test('unknown consumption waits once; same-window replay waits; expired window does not wait', async () => {
  await fixture(async (directory, id) => {
    const time = clock(15_000);
    let verified = 0;
    const run = () => withFreshMfaFixtureCounter(directory, id, async () => ++verified, time);
    assert.equal(await run(), 1);
    assert.deepEqual(time.waits, [15_100]);
    assert.equal(await readFile(join(directory, `${id}.counter`), 'utf8'), '1');
    assert.equal(await run(), 2);
    assert.deepEqual(time.waits, [15_100, 30_000]);
    time.advance(30_000);
    assert.equal(await run(), 3);
    assert.deepEqual(time.waits, [15_100, 30_000]);
    assert.equal(verified, 3); // Timing metadata never substitutes for real verification.
  });
});

test('counter response rollover is conservatively recorded', async () => {
  await fixture(async (directory, id) => {
    const time = clock(15_000);
    await withFreshMfaFixtureCounter(directory, id, async () => time.advance(30_000), time);
    assert.equal(await readFile(join(directory, `${id}.counter`), 'utf8'), '2');
    await withFreshMfaFixtureCounter(directory, id, async () => {}, time);
    assert.deepEqual(time.waits, [15_100, 30_000]);
  });
});

test('verification refusal remains refusal and unknown hint is not authenticated', async () => {
  await fixture(async (directory, id) => {
    const time = clock(15_000);
    await assert.rejects(
      withFreshMfaFixtureCounter(
        directory,
        id,
        async () => {
          throw new Error('real verification refused');
        },
        time,
      ),
      /real verification refused/,
    );
    assert.equal(await readFile(join(directory, `${id}.counter`), 'utf8'), '');
    let called = false;
    await withFreshMfaFixtureCounter(
      directory,
      id,
      async () => {
        called = true;
      },
      time,
    );
    assert.equal(called, true);
    assert.deepEqual(time.waits, [15_100, 30_000]);
  });
});

test('independent calls serialize and reuse only expired counters', async () => {
  await fixture(async (directory, id) => {
    const time = clock(15_000);
    let active = 0;
    await Promise.all(
      [1, 2, 3].map(() =>
        withFreshMfaFixtureCounter(
          directory,
          id,
          async () => {
            assert.equal(++active, 1);
            time.advance(30_000);
            assert.equal(active--, 1);
          },
          time,
        ),
      ),
    );
    assert.deepEqual(time.waits, [15_100, 30_000, 30_000]);
  });
});

for (const malformed of ['secret-do-not-log', '-1', '2', '1.5', '01', '9'.repeat(33)]) {
  test(
    'malformed or future timing metadata refuses before verification: ' + malformed.length,
    async () => {
      await fixture(async (directory, id) => {
        await mkdir(directory, { mode: 0o700 });
        await writeFile(join(directory, `${id}.counter`), malformed, { mode: 0o600 });
        await assert.rejects(
          withFreshMfaFixtureCounter(
            directory,
            id,
            async () => assert.fail('must not verify'),
            clock(30_100),
          ),
        );
      });
    },
  );
}

test('symlink, hardlink and nonprivate hints refuse without touching their target', async () => {
  await fixture(async (directory, id) => {
    await mkdir(directory, { mode: 0o700 });
    const target = join(directory, 'preserved');
    const hint = join(directory, `${id}.counter`);
    await writeFile(target, '0', { mode: 0o600 });
    await symlink(target, hint);
    await assert.rejects(
      withFreshMfaFixtureCounter(
        directory,
        id,
        async () => assert.fail('must not verify'),
        clock(30_100),
      ),
    );
    await rm(hint);
    await link(target, hint);
    await assert.rejects(
      withFreshMfaFixtureCounter(
        directory,
        id,
        async () => assert.fail('must not verify'),
        clock(30_100),
      ),
    );
    await rm(hint);
    await writeFile(hint, '0', { mode: 0o600 });
    await chmod(hint, 0o644);
    await assert.rejects(
      withFreshMfaFixtureCounter(
        directory,
        id,
        async () => assert.fail('must not verify'),
        clock(30_100),
      ),
    );
    assert.equal(await readFile(target, 'utf8'), '0');
  });
});
