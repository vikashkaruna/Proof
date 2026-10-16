/** CLI entry point; shared authority lives in the CommonJS-safe core. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadParityFixture, guardedParitySql } from './parity-fixture-target-core.js';
export * from './parity-fixture-target-core.js';
// The Python issuer fixture uses this same guard, never a duplicate weaker
// project selector. Captured stdout carries only its private SQL return rows.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.slice(2).length !== 1) throw new Error('Fixture command refused');
    if (process.argv[2] === '--validate') loadParityFixture();
    else if (process.argv[2] === '--sql-admin')
      process.stdout.write(guardedParitySql(readFileSync(0, 'utf8')));
    else throw new Error('Fixture command refused');
  } catch {
    process.stderr.write('Owned parity fixture refused.\n');
    process.exitCode = 1;
  }
}
