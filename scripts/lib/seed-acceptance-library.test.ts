import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildLibrarySeed } from '../../packages/control-library/src/seed.js';
import { seedAcceptanceLibrary } from './seed-acceptance-library.js';

const seed = buildLibrarySeed();

async function fixtureLibrary(
  options: { existing?: boolean; declaredCount?: number; actualCount?: number } = {},
) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    if (method === 'POST') return new Response(null, { status: 201 });
    if (url.includes('/control_libraries?'))
      return Response.json(
        options.existing ? [{ control_count: options.declaredCount ?? seed.controls.length }] : [],
      );
    if (url.includes('/controls?'))
      return Response.json(
        seed.controls
          .slice(0, options.actualCount ?? seed.controls.length)
          .map(({ id }) => ({ id })),
      );
    throw new Error('Unexpected fixture request');
  };
  try {
    return {
      version: await seedAcceptanceLibrary(
        'https://fixture.invalid',
        'fixture-public',
        'fixture-service',
      ),
      calls,
    };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('returns the exact complete published library after creating and reading back its controls', async () => {
  const { version, calls } = await fixtureLibrary();
  assert.equal(version, seed.version);
  assert.ok(seed.controls.length > 0);
  const published = calls.find(
    ({ url, method }) => url.endsWith('/control_libraries') && method === 'POST',
  );
  assert.deepEqual(published?.body, {
    version: seed.version,
    published_at: seed.publishedAt,
    published_by: seed.publishedBy,
    change_log: seed.changeLog,
    control_count: seed.controls.length,
    is_current: false,
  });
  assert.ok(calls.at(-1)?.url.includes(`library_version=eq.${encodeURIComponent(version)}`));
});

test('reuses the same complete library without replacing its published metadata', async () => {
  const { version, calls } = await fixtureLibrary({ existing: true });
  assert.equal(version, seed.version);
  assert.equal(
    calls.some(({ url, method }) => url.endsWith('/control_libraries') && method === 'POST'),
    false,
  );
});

test('refuses existing library metadata with a zero control count before inserting controls', async () => {
  await assert.rejects(
    fixtureLibrary({ existing: true, declaredCount: 0 }),
    /Published library count differs/,
  );
});

test('does not return a usable baseline when persisted controls are incomplete', async () => {
  await assert.rejects(
    fixtureLibrary({ existing: true, actualCount: seed.controls.length - 1 }),
    /Incomplete report library/,
  );
});
