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
