/** Deterministic synthetic fixtures from production codecs/builders, never SQL/Auth proof. */
import { lstatSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { publicReportFixture } from '../../packages/report-kit/src/public-control-provenance.test-helper.js';
import { assetReportFixture } from '../../packages/report-kit/src/public-control-report-v4.test-helper.js';
import { encodeCoverageFirstSource } from '../../packages/report-kit/src/coverage-first-source.js';
import { buildCoverageFirstReport } from '../../packages/report-kit/src/coverage-first-report.js';

const directory = process.argv[2];
if (
  !directory ||
  process.argv.length !== 3 ||
  resolve(directory) !== directory ||
  realpathSync(directory) !== directory
)
  throw Error('Synthetic fixture output directory refused');
const stat = lstatSync(directory);
if (
  !stat.isDirectory() ||
  (stat.mode & 0o777) !== 0o700 ||
  (process.getuid && stat.uid !== process.getuid())
)
  throw Error('Protected owned fixture directory required');
const fixtures = [];
for (const kind of ['board', 'auditor'] as const)
  for (const registered of [false, true]) {
    const original = registered ? assetReportFixture(kind) : publicReportFixture(kind);
    const envelope = encodeCoverageFirstSource(
      kind,
      original.input.sourceText,
      original.input.sourceSha256,
    );
    const input = { ...original.input, sourceText: envelope.text, sourceSha256: envelope.sha256 };
    fixtures.push({
      kind,
      registered,
      originalText: original.input.sourceText,
      originalSha256: original.input.sourceSha256,
      sourceText: envelope.text,
      sourceSha256: envelope.sha256,
      document: buildCoverageFirstReport(input),
      input,
    });
  }
const json = JSON.stringify(fixtures);
if (json.includes('$coverage144fixture$')) throw Error('Synthetic fixture delimiter refused');
writeFileSync(
  join(directory, 'parity-fixtures.sql'),
  'create temporary table coverage144_parity_fixture(value jsonb);\ninsert into coverage144_parity_fixture select value from jsonb_array_elements($coverage144fixture$' +
    json +
    '$coverage144fixture$::jsonb);\n',
  { mode: 0o600, flag: 'wx' },
);
console.log('Prepared four synthetic production-codec parity fixtures; no SQL executed.');
