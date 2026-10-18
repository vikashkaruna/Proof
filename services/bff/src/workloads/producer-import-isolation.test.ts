import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('imports the dedicated producer with no BFF secrets or environment initialization', () => {
  const result = execFileSync(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      '--input-type=module',
      '--eval',
      "await import('./src/local-assessment-producer.ts'); process.stdout.write('isolated-import-ok');",
    ],
    {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      env: { PATH: process.env.PATH, NODE_ENV: 'production' },
      timeout: 10000,
      encoding: 'utf8',
    },
  );
  expect(result).toBe('isolated-import-ok');
});
