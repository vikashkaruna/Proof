import { z } from 'zod';
import { probeRegisteredResponse } from './registered-response-probe.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  chmodSync,
  linkSync,
  statSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  registeredBrowserDiagnostics,
  readRegisteredBrowserDiagnostics,
  readRegisteredBrowserProgress,
  assertRegisteredDiagnosticDestinationAbsent,
  writeRegisteredResponseProbe,
  readRegisteredResponseProbes,
  registeredResponseProbePath,
} from './registered-browser-diagnostics.js';
const secret = 'private-persona-secret https://private.invalid/?token=secret';
const lifecycle = {
  exitCode: 1,
  signal: null,
  phase: 'normal-auth-public-source-browser-submission-wait',
  report: 'available' as const,
};
const payload = {
  suites: [
    {
      specs: [
        {
          file: 'tests/board-reports-provider.spec.ts',
          title:
            'finalized source, released board PDF, and source-bound Pramaan dossier use exact retained versions',
          tests: [
            {
              results: [
                {
                  status: 'failed',
                  errors: [
                    {
                      message: `Error: expect(locator).toBeVisible()\n${secret}`,
                      stack: secret,
                      snippet: secret,
                      location: {
                        file: '/private/tests/e2e/tests/board-reports-provider.spec.ts',
                        line: 555,
                        column: 9,
                      },
                    },
                  ],
                  stdout: [secret],
                  attachments: [{ body: secret }],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};
test('safe evidence retains the exact case/status/location/matcher and no private values', () => {
  const result = registeredBrowserDiagnostics(payload, lifecycle);
  assert.deepEqual(result.results, [
    {
      caseId: 'registered-source-board-auditor-recovery',
      status: 'failed',
      location: 'tests/e2e/tests/board-reports-provider.spec.ts:555:9',
      matcher: 'toBeVisible',
    },
  ]);
  assert.equal(result.phase, 'submission-wait');
  assert.equal(result.exitCode, 1);
  assert(!JSON.stringify(result).includes('private'));
});
test('unreviewed cases, malformed fields, private lifecycle and unknown matchers never echo input', () => {
  for (const input of [
    null,
    secret,
    {},
    { suites: [payload, { specs: [{ title: secret, file: secret }] }] },
  ]) {
    const output = registeredBrowserDiagnostics(input, {
      exitCode: secret,
      signal: secret,
      phase: secret,
      report: 'refused',
    });
    assert.equal(output.exitCode, null);
    assert.equal(output.signal, null);
    assert.equal(output.phase, 'other');
    assert(!JSON.stringify(output).includes(secret));
  }
  assert.equal(registeredBrowserDiagnostics({}, lifecycle).category, 'child-exit-before-result');
});
test('missing, truncated, oversized and symlinked reports have safe distinct fallback metadata', () => {
  const directory = mkdtempSync(join(tmpdir(), 'axiom-diagnostic-'));
  const path = join(directory, 'report.private.json');
  try {
    assert.equal(readRegisteredBrowserDiagnostics(path, lifecycle).report, 'missing');
    for (const bytes of ['{', secret, 'x'.repeat(4_194_305)]) {
      writeFileSync(path, bytes, { mode: 0o600 });
      const output = readRegisteredBrowserDiagnostics(path, lifecycle);
      assert.equal(output.report, 'refused');
      assert(!JSON.stringify(output).includes(secret));
    }
    rmSync(path);
    symlinkSync(join(directory, 'missing'), path);
    assert.equal(readRegisteredBrowserDiagnostics(path, lifecycle).report, 'refused');
    rmSync(path);
    writeFileSync(path, JSON.stringify(payload), { mode: 0o600 });
    assert.equal(readRegisteredBrowserDiagnostics(path, lifecycle).results.length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('cancelled/early child without report retains only bounded lifecycle and refuses stale evidence targets', () => {
  const directory = mkdtempSync(join(tmpdir(), 'axiom-diagnostic-preflight-'));
  const path = join(directory, 'diagnostic.json');
  try {
    assertRegisteredDiagnosticDestinationAbsent(path);
    const output = readRegisteredBrowserDiagnostics(path, {
      exitCode: null,
      signal: 'SIGINT',
      phase: 'normal-auth-public-source-browser-submission-wait',
    });
    assert.equal(output.category, 'child-signal-before-result');
    assert.equal(output.signal, 'SIGINT');
    assert.equal(output.report, 'missing');
    writeFileSync(path, secret, { mode: 0o600 });
    assert.throws(
      () => assertRegisteredDiagnosticDestinationAbsent(path),
      /archive prior owned evidence/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('actual helper failure coordinate and fixed progress survive without private browser fields', () => {
  const input = structuredClone(payload);
  input.suites[0]!.specs[0]!.tests[0]!.results[0]!.errors[0]!.location = {
    file: '/private-persona/tests/e2e/fixtures/public-asset-workflow.ts',
    line: 147,
    column: 29,
  };
  const result = registeredBrowserDiagnostics(input, {
    ...lifecycle,
    progress: 'capture-response-loss',
  });
  assert.equal(result.results[0]?.location, 'tests/e2e/fixtures/public-asset-workflow.ts:147:29');
  assert.equal(result.progress, 'capture-response-loss');
  assert(!JSON.stringify(result).includes('private'));
  for (const progress of [secret, 'capture-response-loss ' + secret, 1, null]) {
    const refused = registeredBrowserDiagnostics(input, { ...lifecycle, progress });
    assert.equal(refused.progress, 'unknown');
    assert(!JSON.stringify(refused).includes(secret));
  }
});

test('owned log tail yields only the last fixed marker and refuses unsafe files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'axiom-progress-'));
  const path = join(directory, 'browser.private.log');
  try {
    assert.equal(readRegisteredBrowserProgress(path), 'unknown');
    writeFileSync(
      path,
      secret +
        '\n[registered-website-stage] login\n' +
        '[registered-website-stage] capture-response-loss\n' +
        '[registered-website-stage] ' +
        secret +
        '\n',
      { mode: 0o600 },
    );
    assert.equal(readRegisteredBrowserProgress(path), 'capture-response-loss');
    // Prefix markers outside the fixed read bound must not be read as current progress.
    writeFileSync(path, '[registered-website-stage] login\n' + 'x'.repeat(131072) + '\n');
    assert.equal(readRegisteredBrowserProgress(path), 'unknown');
    writeFileSync(path, secret.repeat(2048) + '\n[registered-website-stage] human-review\n');
    assert.equal(readRegisteredBrowserProgress(path), 'human-review');
    chmodSync(path, 0o644);
    assert.equal(readRegisteredBrowserProgress(path), 'unknown');
    rmSync(path);
    symlinkSync(join(directory, 'foreign'), path);
    assert.equal(readRegisteredBrowserProgress(path), 'unknown');
    rmSync(path);
    assert.equal(readRegisteredBrowserProgress(directory), 'unknown');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('saved-target boundary retains only fixed checkpoints and HTTP status or equality booleans', () => {
  for (const [progress, expected] of [
    ['saved-targets-http-status:200', { checkpoint: 'http-status', httpStatus: 200 }],
    ['saved-targets-http-status:403', { checkpoint: 'http-status', httpStatus: 403 }],
    ['saved-targets-response-schema', { checkpoint: 'response-schema' }],
    ['saved-targets-request-tenant:false', { checkpoint: 'request-tenant', matches: false }],
    ['saved-targets-response-actor:true', { checkpoint: 'response-actor', matches: true }],
    [
      'saved-targets-target-digest:false:false',
      { checkpoint: 'target-digest', matches: false, targetPresent: false },
    ],
    [
      'saved-targets-target-digest:false:true',
      { checkpoint: 'target-digest', matches: false, targetPresent: true },
    ],
    [
      'saved-targets-target-inventory-current:false',
      { checkpoint: 'target-inventory-current', matches: false },
    ],
  ] as const) {
    const result = registeredBrowserDiagnostics(payload, { ...lifecycle, progress });
    assert.deepEqual(result.targetSelection, expected);
    assert.equal(result.progress, `saved-targets-${expected.checkpoint}`);
    assert(!JSON.stringify(result).includes(secret));
  }
  for (const progress of [
    'saved-targets-http-status:99',
    'saved-targets-http-status:600',
    'saved-targets-http-status:0200',
    'saved-targets-http-status:200:' + secret,
    'saved-targets-request-tenant:1',
    'saved-targets-request-tenant:true:false',
    'saved-targets-target-digest:false',
    'saved-targets-response-secret:true',
    'saved-targets-response-schema:' + secret,
  ]) {
    const result = registeredBrowserDiagnostics(payload, { ...lifecycle, progress });
    assert.equal(result.targetSelection, undefined);
    assert.equal(result.progress, 'unknown');
    assert(!JSON.stringify(result).includes(secret));
  }
});

test('actual bounded log reader transports the latest failing target checkpoint with no values', () => {
  const directory = mkdtempSync(join(tmpdir(), 'axiom-selection-progress-'));
  const path = join(directory, 'browser.private.log');
  try {
    writeFileSync(
      path,
      `${secret}\n[registered-website-stage] load-saved-targets\n` +
        '[registered-website-stage] saved-targets-http-status:200\n' +
        '[registered-website-stage] saved-targets-request-tenant:true\n' +
        '[registered-website-stage] saved-targets-target-digest:false:false\n' +
        '[registered-website-stage] saved-targets-response-secret:' +
        secret +
        '\n',
      { mode: 0o600 },
    );
    const progress = readRegisteredBrowserProgress(path);
    const result = registeredBrowserDiagnostics(payload, { ...lifecycle, progress });
    assert.deepEqual(result.targetSelection, {
      checkpoint: 'target-digest',
      matches: false,
      targetPresent: false,
    });
    assert(!JSON.stringify(result).includes(secret));
    assert(!JSON.stringify(result).includes('http'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('earlier target submission retains status and fixed equality flags without response data', () => {
  for (const [progress, expected] of [
    ['target-submit-http-status:201', { checkpoint: 'http-status', httpStatus: 201 }],
    ['target-submit-http-status:409', { checkpoint: 'http-status', httpStatus: 409 }],
    [
      'target-submit-foreign-http-status:403',
      { checkpoint: 'foreign-http-status', httpStatus: 403 },
    ],
    ['target-submit-response-schema', { checkpoint: 'response-schema' }],
    ['target-submit-snapshot-schema', { checkpoint: 'snapshot-schema' }],
    ['target-submit-foreign-body-check', { checkpoint: 'foreign-body-check' }],
    ...[
      'snapshot-kind',
      'response-tenant',
      'response-actor',
      'snapshot-url',
      'snapshot-estate',
      'snapshot-system',
    ].flatMap((checkpoint) => [
      [`target-submit-${checkpoint}:true`, { checkpoint, matches: true }] as const,
      [`target-submit-${checkpoint}:false`, { checkpoint, matches: false }] as const,
    ]),
  ] as const) {
    const result = registeredBrowserDiagnostics(payload, { ...lifecycle, progress });
    assert.deepEqual(result.targetSubmission, expected);
    assert.equal(result.progress, `target-submit-${expected.checkpoint}`);
    assert(!JSON.stringify(result).includes(secret));
  }
  for (const progress of [
    'target-submit-http-status:99',
    'target-submit-http-status:600',
    'target-submit-http-status:0201',
    'target-submit-http-status:201:' + secret,
    'target-submit-response-schema:' + secret,
    'target-submit-response-actor:1',
    'target-submit-response-actor:true:false',
    'target-submit-secret:true',
  ]) {
    const result = registeredBrowserDiagnostics(payload, { ...lifecycle, progress });
    assert.equal(result.targetSubmission, undefined);
    assert.equal(result.progress, 'unknown');
    assert(!JSON.stringify(result).includes(secret));
  }
});

test('owned log tail carries the failing submission checkpoint without private values', () => {
  const directory = mkdtempSync(join(tmpdir(), 'axiom-submit-progress-'));
  const path = join(directory, 'browser.private.log');
  try {
    writeFileSync(
      path,
      `${secret}\n[registered-website-stage] target-submit\n[registered-website-stage] target-submit-http-status:201\n[registered-website-stage] target-submit-response-actor:false\n[registered-website-stage] target-submit-secret:${secret}\n`,
      { mode: 0o600 },
    );
    const progress = readRegisteredBrowserProgress(path);
    const result = registeredBrowserDiagnostics(payload, { ...lifecycle, progress });
    assert.deepEqual(result.targetSubmission, { checkpoint: 'response-actor', matches: false });
    assert(!JSON.stringify(result).includes(secret));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('parse error codeframe cannot become a matcher; genuine header/metadata remains meaningful', () => {
  const input = structuredClone(payload);
  const error = input.suites[0]!.specs[0]!.tests[0]!.results[0]!.errors[0]!;
  error.message =
    'Error: [invalid_type]\n124 | expect(registration.status()).toBe(201);\n126 | schema.parse(body.data)';
  assert.equal(registeredBrowserDiagnostics(input, lifecycle).results[0]?.matcher, 'unknown');
  error.message = 'Error: expect(received).toBe(expected) // equality\n' + secret;
  error.message =
    '\u001b[31mError: expect(received).toBe(expected) // equality\u001b[39m\n' + secret;
  assert.equal(registeredBrowserDiagnostics(input, lifecycle).results[0]?.matcher, 'toBe');
});

test('failed parse is durably private before same error escapes and strict reader accepts only safe fields', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'axiom-response-probe-'));
  try {
    const error = new z.ZodError([{ code: 'custom', path: ['receipt', 'id'], message: secret }]);
    await assert.rejects(
      probeRegisteredResponse(
        {
          json: async () => ({ data: { receipt: { id: secret } } }),
          headers: () => ({ 'content-type': 'application/json' }),
        },
        'target-submit',
        {
          tenantMatches: true,
          actorMatches: true,
          bodyKindMatches: true,
          operationKeyMatches: true,
        },
        () => {
          throw error;
        },
        (probe) => writeRegisteredResponseProbe(directory, probe),
      ),
      (e) => e === error,
    );
    const path = registeredResponseProbePath(directory, 'target-submit');
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const read = readRegisteredResponseProbes(directory);
    assert.equal(read[0]?.state, 'available');
    assert.equal(read[1]?.state, 'missing');
    assert(!JSON.stringify(read).includes(secret));
    const probe = JSON.parse(readFileSync(path, 'utf8'));
    assert.throws(() => writeRegisteredResponseProbe(directory, probe));
    for (const changed of [
      { ...probe, rawBody: secret },
      { ...probe, issues: [{ code: 'custom', path: [secret] }] },
      { ...probe, issues: [{ code: secret, path: [] }] },
      { ...probe, phase: 'saved-targets' },
    ]) {
      writeFileSync(path, JSON.stringify(changed));
      const output = readRegisteredResponseProbes(directory);
      assert.equal(output[0]?.state, 'refused');
      assert(!JSON.stringify(output).includes(secret));
    }
    writeFileSync(path, JSON.stringify(probe));
    chmodSync(path, 0o644);
    assert.equal(readRegisteredResponseProbes(directory)[0]?.state, 'refused');
    chmodSync(path, 0o600);
    linkSync(path, join(directory, 'hardlink'));
    assert.equal(readRegisteredResponseProbes(directory)[0]?.state, 'refused');
    rmSync(join(directory, 'hardlink'));
    writeFileSync(path, 'x'.repeat(8193));
    assert.equal(readRegisteredResponseProbes(directory)[0]?.state, 'refused');
    rmSync(path);
    symlinkSync(join(directory, 'missing'), path);
    assert.equal(readRegisteredResponseProbes(directory)[0]?.state, 'refused');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('report checkpoints remain fixed labels and never relay arbitrary private output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'report-checkpoint-'));
  try {
    const log = join(dir, 'browser.log');
    for (const stage of [
      'report-board-content',
      'report-board-preview',
      'report-board-retained',
      'report-board-release',
      'report-board-dossier',
      'report-browser-cleanup',
    ]) {
      writeFileSync(log, `[registered-website-stage] ${stage}\n`, { mode: 0o600 });
      assert.equal(readRegisteredBrowserProgress(log), stage);
    }
    writeFileSync(log, `[registered-website-stage] ${secret}\n`, { mode: 0o600 });
    assert.equal(readRegisteredBrowserProgress(log), 'unknown');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
