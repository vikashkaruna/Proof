import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { loadAcceptanceTarget } from './lib/acceptance-target.js';
interface Suite {
  title: string;
  suites?: Suite[];
  specs?: { title: string; ok: boolean; tests: { status: string }[] }[];
}
async function main() {
  const target = loadAcceptanceTarget();
  assert(target, 'An acceptance target is required');
  const dir = resolve('.axiom-runtime/acceptance', target.deploymentId);
  const report = JSON.parse(await readFile(`${dir}/browser-private.json`, 'utf8')) as {
    suites: Suite[];
    stats: { expected: number; unexpected: number; flaky: number; skipped: number };
  };
  const outcomes: Record<string, boolean> = {};
  function visit(suite: Suite, parent: string[]) {
    const names = [...parent, suite.title];
    for (const spec of suite.specs ?? [])
      outcomes[[...names, spec.title].join(' / ')] =
        spec.ok && spec.tests.every((t) => t.status === 'expected');
    for (const child of suite.suites ?? []) visit(child, names);
  }
  for (const suite of report.suites) visit(suite, []);
  assert(Object.keys(outcomes).length > 0, 'No browser journeys ran');
  assert(
    report.stats.unexpected === 0 &&
      report.stats.flaky === 0 &&
      report.stats.skipped === 0 &&
      Object.values(outcomes).every(Boolean),
    'Browser acceptance has failed, flaky or skipped journeys; inspect the protected report',
  );
  await writeFile(
    `${dir}/browser-results.json`,
    JSON.stringify(
      {
        schemaVersion: 1,
        kind: 'deployed-browser',
        passed: true,
        completedAt: new Date().toISOString(),
        deploymentId: target.deploymentId,
        environment: target.environment,
        topology: target.topology,
        revision: target.expectedRevision,
        webUrl: target.webUrl,
        outcomes,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(
    `${target.deploymentId}: ${Object.keys(outcomes).length} browser journeys passed; sanitized results saved.`,
  );
}
main().catch(() => {
  console.error(
    'Browser acceptance report failed validation. Inspect protected local reports; do not upload raw credentials or traces.',
  );
  process.exitCode = 1;
});
