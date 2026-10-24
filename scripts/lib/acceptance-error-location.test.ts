import test from 'node:test';
import assert from 'node:assert/strict';
import AcceptanceReporter from '../../tests/e2e/acceptance-reporter.js';
import { acceptanceErrorLocation } from './acceptance-error-location.js';

test('reports a known source location with no host path', () => {
  assert.equal(
    acceptanceErrorLocation({
      file: '/private/operator/tests/e2e/tests/gap-scan.spec.ts',
      line: 113,
      column: 5,
    }),
    'tests/e2e/tests/gap-scan.spec.ts:113:5',
  );
});

test('omits unknown paths and malformed source coordinates', () => {
  for (const location of [
    undefined,
    null,
    { file: '/tests/e2e/tests/synthetic-private-secret.spec.ts', line: 1, column: 1 },
    { file: '/untrusted/gap-scan.spec.ts', line: 1, column: 1 },
    { file: 'tests/e2e/tests/gap-scan.spec.ts\nsecret', line: 1, column: 1 },
    ...[0, -1, 1.5, Infinity, NaN, '1', Number.MAX_SAFE_INTEGER + 1].flatMap((value) => [
      { file: 'tests/e2e/tests/gap-scan.spec.ts', line: value, column: 1 },
      { file: 'tests/e2e/tests/gap-scan.spec.ts', line: 1, column: value },
    ]),
  ]) {
    assert.equal(acceptanceErrorLocation(location), undefined);
  }
});

test('actual reporter exposes only known locations and preserves outcome output', () => {
  const secret = 'synthetic-private-secret';
  const output: string[] = [];
  const original = console.log;
  console.log = (message: string) => output.push(message);
  try {
    const reporter = new AcceptanceReporter();
    const testCase = { titlePath: () => ['gap-scan.spec.ts', 'static test'] } as Parameters<
      AcceptanceReporter['onTestEnd']
    >[0];
    reporter.onTestEnd(testCase, {
      status: 'failed',
      errors: [
        {
          message: secret,
          stack: secret,
          snippet: secret,
          location: {
            file: `/${secret}/tests/e2e/tests/gap-scan.spec.ts`,
            line: 113,
            column: 5,
          },
        },
        {
          message: secret,
          location: { file: `/tests/e2e/tests/${secret}.spec.ts`, line: 1, column: 1 },
        },
      ],
    } as Parameters<AcceptanceReporter['onTestEnd']>[1]);
    reporter.onEnd({ status: 'failed', startTime: new Date(0), duration: 0 });
  } finally {
    console.log = original;
  }
  assert.deepEqual(output, [
    'failed: gap-scan.spec.ts / static test',
    'Acceptance failure location: tests/e2e/tests/gap-scan.spec.ts:113:5',
    'Browser acceptance finished: failed',
  ]);
  assert.equal(output.join('\n').includes(secret), false);
});

test('reporter emits only valid numeric durations and omits private or invalid values', () => {
  const output: string[] = [];
  const original = console.log;
  console.log = (message: string) => output.push(message);
  try {
    const reporter = new AcceptanceReporter();
    const testCase = { titlePath: () => ['static test'] } as Parameters<
      AcceptanceReporter['onTestEnd']
    >[0];
    for (const duration of [
      0,
      123.9,
      undefined,
      NaN,
      Infinity,
      -1,
      'private-secret',
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      reporter.onTestEnd(testCase, {
        status: 'passed',
        errors: [],
        duration,
      } as unknown as Parameters<AcceptanceReporter['onTestEnd']>[1]);
    }
  } finally {
    console.log = original;
  }
  assert.deepEqual(output, [
    'passed: static test (0ms)',
    'passed: static test (123ms)',
    ...Array<string>(6).fill('passed: static test'),
  ]);
});

test('global setup errors expose only fixed categories, never private cause values', (context) => {
  const messages: string[] = [];
  context.mock.method(console, 'log', (value: string) => messages.push(value));
  const reporter = new AcceptanceReporter();
  reporter.onError({
    message: 'private-credential MFA pool directory refused other-private-input',
  });
  reporter.onError({ message: 'private-credential https://private.example.invalid' });
  assert.deepEqual(messages, [
    'Acceptance setup failure: mfa_pool_permissions',
    'Acceptance setup failure: unclassified_private_error',
  ]);
  assert.ok(
    messages.every(
      (value) => !value.includes('private-credential') && !value.includes('example.invalid'),
    ),
  );
});

test('registered fixture assertion retains only its exact reviewed source coordinate', () => {
  assert.equal(
    acceptanceErrorLocation({
      file: '/private-persona/tests/e2e/fixtures/public-asset-workflow.ts',
      line: 147,
      column: 29,
    }),
    'tests/e2e/fixtures/public-asset-workflow.ts:147:29',
  );
  for (const file of [
    '/private/tests/e2e/fixtures/foreign.ts',
    '/private/fixtures/public-asset-workflow.ts',
    '/private/tests/e2e/fixtures/public-asset-workflow.ts/private-secret',
    '/private/tests/e2e/fixtures/public-asset-workflow.ts\nprivate-secret',
  ])
    assert.equal(acceptanceErrorLocation({ file, line: 147, column: 29 }), undefined);
});

test('reports the reviewed dashboard specification location without private failure details', () => {
  assert.equal(
    acceptanceErrorLocation({
      file: '/private/host/tests/e2e/tests/dashboard-posture-estimate.spec.ts',
      line: 71,
      column: 5,
    }),
    'tests/e2e/tests/dashboard-posture-estimate.spec.ts:71:5',
  );
});
