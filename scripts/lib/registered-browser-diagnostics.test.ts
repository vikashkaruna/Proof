import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  registeredBrowserDiagnostics,
  readRegisteredBrowserDiagnostics,
  assertRegisteredDiagnosticDestinationAbsent,
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
                      message: `${secret} expect(locator).toBeVisible() ${secret}`,
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
