import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { compareAcceptance, type Evidence } from './lib/compare-acceptance.js';
async function main() {
  const paths = process.argv.slice(2);
  assert(paths.length >= 2, 'Supply results from at least two distinct deployments');
  const results: Evidence[] = await Promise.all(
    paths.map(async (p) => JSON.parse(await readFile(p, 'utf8'))),
  );
  compareAcceptance(results);
  const baseline = results[0]!;
  console.log(
    `Behavioral parity passed across ${results.length} distinct ${baseline.kind} targets at one revision.`,
  );
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Deployed parity comparison failed');
  process.exitCode = 1;
});
