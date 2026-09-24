import assert from 'node:assert/strict';
import { buildLibrarySeed } from '../../packages/control-library/src/seed.js';
/** Seed the real published library for synthetic report journeys, never overwrite it. */
export async function seedAcceptanceLibrary(url: string, apiKey: string, serviceKey: string) {
  const seed = buildLibrarySeed();
  const request = (path: string, body?: unknown) =>
    fetch(`${url}/rest/v1/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: {
        apikey: apiKey,
        Authorization: `Bearer ${serviceKey}`,
        'content-type': 'application/json',
        Prefer: 'resolution=ignore-duplicates,return=minimal',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const res = await request(
    `control_libraries?version=eq.${encodeURIComponent(seed.version)}&select=version,control_count`,
  );
  assert.equal(res.status, 200, 'Cannot inspect report library');
  const libraries = (await res.json()) as Array<{ control_count: number }>;
  if (libraries.length === 0) {
    assert.equal(
      (
        await request('control_libraries', {
          version: seed.version,
          published_at: seed.publishedAt,
          published_by: seed.publishedBy,
          change_log: seed.changeLog,
          control_count: seed.controls.length,
          is_current: false,
        })
      ).status,
      201,
      'Cannot seed published report library',
    );
  } else
    assert.equal(
      libraries[0]!.control_count,
      seed.controls.length,
      'Published library count differs; do not overwrite it',
    );
  assert.equal(
    (await request('controls?on_conflict=id,library_version', seed.controls)).status,
    201,
    'Cannot seed report controls',
  );
  const count = await request(
    `controls?library_version=eq.${encodeURIComponent(seed.version)}&select=id`,
  );
  assert.equal(count.status, 200);
  assert.equal(
    ((await count.json()) as unknown[]).length,
    seed.controls.length,
    'Incomplete report library',
  );
}
