import { createHash } from 'node:crypto';
import {
  constants,
  closeSync,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLibrarySeed } from '../packages/control-library/src/seed.ts';
import {
  validateLibrary,
  CONTROL_LIBRARY_COUNT,
} from '../packages/control-library/src/controls.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const release = process.env.AXIOM_RELEASE_SHA;
if (!release || !/^[a-f0-9]{40}$/.test(release)) throw new Error('Exact release SHA required');
const validation = validateLibrary();
if (!validation.ok) throw new Error('Published control library validation refused');
const seed = buildLibrarySeed();
if (seed.controls.length !== CONTROL_LIBRARY_COUNT)
  throw new Error('Published library count mismatch');
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const sourceHashes: Record<string, string> = {};
function inventory(directory: string): void {
  for (const item of readdirSync(resolve(root, directory), { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const path = `${directory}/${item.name}`;
    if (item.isDirectory()) inventory(path);
    else if (item.isFile() && item.name.endsWith('.ts') && !item.name.endsWith('.test.ts'))
      sourceHashes[path] = sha(readFileSync(resolve(root, path)));
    else if (item.isSymbolicLink()) throw new Error('Library source symlink refused');
  }
}
inventory('packages/control-library/src');
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--output')
  throw new Error('Use --output infra/supabase/marketing-library.json');
const output = resolve(root, args[1]);
if (output !== resolve(root, 'infra/supabase/marketing-library.json'))
  throw new Error('Fixed library build artifact path required');
const artifact = {
  schemaVersion: 1,
  releaseSha: release,
  sourceHashes,
  controlCount: seed.controls.length,
  seedSha256: sha(JSON.stringify(seed)),
  seed,
};
const fd = openSync(output, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
try {
  if (!fstatSync(fd).isFile()) throw new Error('Regular build artifact required');
  fchmodSync(fd, 0o600);
  ftruncateSync(fd, 0);
  writeFileSync(fd, `${JSON.stringify(artifact, null, 2)}\n`);
} finally {
  closeSync(fd);
}
console.log(
  `Validated marketing library ${seed.version}: ${seed.controls.length} controls; exact nonsecret artifact ${output}`,
);
