import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./w9-live-performance.ts', import.meta.url));
const cwd = fileURLToPath(new URL('..', import.meta.url));

test('W9 performance probe refuses a non-disposable database before connecting', () => {
  for (const connection of [
    'postgres://user:pass@remote.example/axiom_w9_probe',
    'postgres://user:pass@127.0.0.1/production',
  ]) {
    const result = spawnSync('pnpm', ['exec', 'tsx', script], {
      cwd,
      env: { ...process.env, AXIOM_W9_DISPOSABLE: '1', AXIOM_W9_DISPOSABLE_URL: connection },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /refuses non-local or non-dedicated databases/);
  }
});

test('W9 performance probe requires explicit disposable opt-in', () => {
  const result = spawnSync('pnpm', ['exec', 'tsx', script], {
    cwd,
    env: {
      ...process.env,
      AXIOM_W9_DISPOSABLE: '0',
      AXIOM_W9_DISPOSABLE_URL: 'postgres://user:pass@127.0.0.1/axiom_w9_probe',
    },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Set AXIOM_W9_DISPOSABLE=1/);
});
