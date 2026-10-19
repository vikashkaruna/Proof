import { lstat } from 'node:fs/promises';
import { dirname } from 'node:path';
export async function assertOwnedDeploymentAncestors(filename: string) {
  for (let directory = dirname(filename); ; directory = dirname(directory)) {
    const stat = await lstat(directory);
    // Root's sticky temporary directories cannot be renamed by another user;
    // every other ancestor must be protected against group/other replacement.
    const stickyRoot = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      ![0, process.getuid?.()].includes(stat.uid) ||
      ((stat.mode & 0o022) !== 0 && !stickyRoot)
    )
      throw Error();
    if (directory === '/') return;
  }
}
