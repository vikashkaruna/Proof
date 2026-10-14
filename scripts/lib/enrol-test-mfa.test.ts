import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { generateSecret, generateTotp } from '@axiom/mfa';
import { enrolTestMfa } from './enrol-test-mfa.js';

function fixture(
  context: TestContext,
  options: {
    activationDelay?: number;
    activationStatus?: number;
    throwOnActivation?: boolean;
  } = {},
) {
  let now = 29_000;
  const secret = generateSecret(20);
  const waits: number[] = [];
  const paths: string[] = [];
  const originalSetTimeout = globalThis.setTimeout;
  context.mock.method(Date, 'now', () => now);
  context.mock.method(globalThis, 'setTimeout', (callback: () => void, milliseconds: number) => {
    waits.push(milliseconds);
    now += milliseconds;
    callback();
    return originalSetTimeout(() => {}, 0);
  });
  context.mock.method(globalThis, 'fetch', async (url: string | URL, init: RequestInit) => {
    const path = new URL(url).pathname;
    paths.push(path);
    if (path === '/auth/v1/token') return Response.json({ access_token: randomUUID() });
    if (path === '/v1/mfa/enrol') return Response.json({ secret }, { status: 201 });
    assert.equal(path, '/v1/mfa/enrol/activate');
    const body: unknown = JSON.parse(String(init.body));
    assert.ok(
      typeof body === 'object' &&
        body !== null &&
        'code' in body &&
        body.code === generateTotp(secret, now),
      'Activation code must use its sampled generation time',
    );
    now += options.activationDelay ?? 0;
    if (options.throwOnActivation) throw new Error('Synthetic activation transport failure');
    return Response.json({}, { status: options.activationStatus ?? 200 });
  });
  return {
    waits,
    paths,
    secret,
    now: () => now,
    input: {
      bffUrl: 'https://bff.example.invalid',
      supabaseUrl: 'https://auth.example.invalid',
      anonKey: randomUUID(),
      email: `${randomUUID()}@example.invalid`,
      password: randomUUID(),
      tenantId: randomUUID(),
    },
  };
}

test('default readiness waits only for the activation counter and existing margin', async (context) => {
  const f = fixture(context);
  assert.ok((await enrolTestMfa(f.input)) === f.secret, 'Verified activation returns its secret');
  assert.deepEqual(f.waits, [1_500]);
  assert.equal(f.now(), 30_500);
  assert.deepEqual(f.paths, ['/auth/v1/token', '/v1/mfa/enrol', '/v1/mfa/enrol/activate']);
});

test('activation response crossing the boundary does not wait for a second counter', async (context) => {
  const f = fixture(context, { activationDelay: 2_000 });
  await enrolTestMfa(f.input);
  assert.deepEqual(f.waits, []);
  assert.equal(f.now(), 31_000);
});

test('boundary crossed inside the margin waits only the remaining readiness margin', async (context) => {
  const f = fixture(context, { activationDelay: 1_200 });
  await enrolTestMfa(f.input);
  assert.deepEqual(f.waits, [300]);
  assert.equal(f.now(), 30_500);
});

test('explicit deferred readiness retains the successful activation without waiting', async (context) => {
  const f = fixture(context);
  await enrolTestMfa({ ...f.input, waitForNextCode: false });
  assert.deepEqual(f.waits, []);
  assert.equal(f.now(), 29_000);
});

test('refused activation does not return readiness or wait', async (context) => {
  const f = fixture(context, { activationStatus: 401 });
  await assert.rejects(enrolTestMfa(f.input), /Fixture MFA activation failed \(401\)/);
  assert.deepEqual(f.waits, []);
});

test('lost activation response never becomes successful enrollment', async (context) => {
  const f = fixture(context, { throwOnActivation: true });
  await assert.rejects(enrolTestMfa(f.input), /Synthetic activation transport failure/);
  assert.deepEqual(f.waits, []);
});

test('pool callback binds the sampled activation counter despite delayed response', async (context) => {
  const f = fixture(context, { activationDelay: 2_000 });
  const counters: number[] = [];
  await enrolTestMfa({
    ...f.input,
    waitForNextCode: false,
    onActivated: (counter) => counters.push(counter),
  });
  assert.deepEqual(counters, [0]);
  assert.deepEqual(f.waits, []);
});
test('refused activation cannot publish pool readiness', async (context) => {
  const f = fixture(context, { activationStatus: 401 });
  const counters: number[] = [];
  await assert.rejects(
    enrolTestMfa({
      ...f.input,
      waitForNextCode: false,
      onActivated: (counter) => counters.push(counter),
    }),
  );
  assert.deepEqual(counters, []);
});
