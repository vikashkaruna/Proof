/** Operator-controlled restart between prepare and verify; never prints ownership proof. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { loadAcceptanceTarget, verifyAcceptanceTarget } from './lib/acceptance-target.js';
async function main() {
  const target = loadAcceptanceTarget();
  assert(target, 'AXIOM_ACCEPTANCE_TARGET is required');
  await verifyAcceptanceTarget(target);
  const dir = resolve('.axiom-runtime/acceptance', target.deploymentId);
  const stateFile = resolve(dir, 'gap-scan-private.json');
  const get = (path: string, options: RequestInit = {}) =>
    fetch(`${target.marketingUrl}${path}`, {
      ...options,
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
  if (process.argv[2] === 'prepare') {
    const res = await get('/api/gap-scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: randomUUID(),
        answers: { q1: true, q2: false },
        contactEmail: 'fixture@example.invalid',
      }),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { id: string; accessToken?: string };
    assert(!body.accessToken, 'Browser JSON must not contain ownership proof');
    const sessionCookies = res.headers
      .getSetCookie()
      .filter((line) => line.startsWith('__session='));
    assert(sessionCookies.length === 1, 'Exactly one marked report session cookie required');
    const fields = sessionCookies[0]!.split(';').map((field) => field.trim());
    const proof = /^__session=gap-scan\.([a-f0-9]{64})$/.exec(fields[0]!)?.[1];
    assert(proof, 'Marked report session ownership proof required');
    const attributes = new Map(
      fields.slice(1).map((field) => {
        const separator = field.indexOf('=');
        return separator < 0
          ? [field.toLowerCase(), '']
          : [field.slice(0, separator).toLowerCase(), field.slice(separator + 1)];
      }),
    );
    assert(attributes.has('httponly'), 'Ownership cookie must be HttpOnly');
    assert(attributes.get('path') === '/', 'Ownership cookie requires host root path');
    assert(
      attributes.get('samesite')?.toLowerCase() === 'lax',
      'Ownership cookie requires SameSite Lax',
    );
    assert(
      attributes.get('max-age') === String(7 * 24 * 60 * 60),
      'Bounded ownership cookie lifetime required',
    );
    assert(!attributes.has('domain'), 'Ownership cookie must remain host-only');
    const secureExpected =
      new URL(target.marketingUrl).protocol === 'https:' ||
      ['preprod', 'staging', 'production'].includes(target.environment);
    assert(
      attributes.has('secure') === secureExpected,
      'Ownership cookie transport security differs',
    );
    await mkdir(dirname(stateFile), { recursive: true, mode: 0o700 });
    await writeFile(
      stateFile,
      JSON.stringify({
        id: body.id,
        proof,
        revision: target.expectedRevision,
        marketingUrl: target.marketingUrl,
      }),
      { mode: 0o600 },
    );
    console.log('Synthetic report durably submitted; private restart probe saved.');
  } else {
    assert.equal(
      process.argv[2],
      'verify',
      'Use prepare, restart BFF/marketing processes, then verify',
    );
    const stored = JSON.parse(await readFile(stateFile, 'utf8')) as {
      id: string;
      proof: string;
      revision: string;
      marketingUrl: string;
    };
    assert.equal(stored.revision, target.expectedRevision);
    assert.equal(stored.marketingUrl, target.marketingUrl);
    const path = `/gap-scan/report/${stored.id}`;
    const owner = await get(path, { headers: { cookie: `__session=gap-scan.${stored.proof}` } });
    assert.equal(owner.status, 200);
    assert((await owner.text()).includes(stored.id));
    assert.equal((await get(path)).status, 404);
    assert.equal(
      (
        await get('/api/gap-scan/send-email', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: stored.id, email: 'fixture@example.invalid' }),
        })
      ).status,
      404,
    );
    const resultPath = resolve(dir, 'api-results.json');
    const result = JSON.parse(await readFile(resultPath, 'utf8')) as {
      passed: boolean;
      revision: string;
      outcomes: Record<string, number | boolean>;
    };
    assert.equal(result.passed, true);
    assert.equal(result.revision, target.expectedRevision);
    Object.assign(result.outcomes, {
      gap_scan_after_process_restart: true,
      gap_scan_ssr_owner_only: true,
      gap_scan_ssr_resend_owner_only: true,
    });
    await writeFile(resultPath, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
    console.log(
      'Report survived BFF/marketing process restart; foreign reads and email dispatch refused.',
    );
  }
}
void main().catch(() => {
  console.error(
    'Gap-scan durability probe failed. Check the private target, service health and required prepare/restart/verify order.',
  );
  process.exitCode = 1;
});
