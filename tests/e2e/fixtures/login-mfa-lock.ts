import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

async function privateDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700
  )
    throw new Error('MFA fixture directory must be owned, private and not a symlink');
}

/** Only an already-owned private fixture parent may hold these disposable locks. */
export async function withMfaFixtureLock<T>(
  directory: string,
  userId: string,
  operation: () => Promise<T>,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<T> {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(userId))
    throw new Error('Invalid MFA fixture lock identity');
  const root = resolve(directory);
  await privateDirectory(dirname(root));
  // Refuse ancestor symlinks before writing; never follow a different fixture path.
  for (let parent = dirname(root); parent !== dirname(parent); parent = dirname(parent)) {
    const stat = await lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('MFA fixture path contains a symlink');
  }
  try {
    await mkdir(root, { mode: 0o700 });
  } catch (cause) {
    if (!(cause instanceof Error) || !('code' in cause) || cause.code !== 'EEXIST') throw cause;
  }
  await privateDirectory(root);
  const lock = join(root, userId);
  const ownerPath = join(lock, 'owner');
  const token = randomUUID();
  const deadline = Date.now() + (options.timeoutMs ?? 90_000);
  for (;;) {
    await privateDirectory(root);
    try {
      await mkdir(lock, { mode: 0o700 });
      break;
    } catch (cause) {
      if (!(cause instanceof Error) || !('code' in cause) || cause.code !== 'EEXIST') throw cause;
      try {
        await privateDirectory(lock);
      } catch (inspection) {
        // The owner may release between mkdir(EEXIST) and lstat. Retry normal
        // exclusive acquisition; never remove or steal a lock in this race.
        if (
          !(inspection instanceof Error) ||
          !('code' in inspection) ||
          inspection.code !== 'ENOENT'
        )
          throw inspection;
      }
      if (Date.now() >= deadline)
        throw new Error(
          'Timed out acquiring seeded login-MFA fixture lock; no stale lock was stolen',
        );
      await delay(options.pollMs ?? 250);
    }
  }
  await privateDirectory(lock);
  const acquired = await lstat(lock);
  await writeFile(ownerPath, token, { flag: 'wx', mode: 0o600 });
  try {
    return await operation();
  } finally {
    await privateDirectory(lock);
    const current = await lstat(lock);
    const owner = await lstat(ownerPath);
    if (
      current.dev !== acquired.dev ||
      current.ino !== acquired.ino ||
      !owner.isFile() ||
      owner.isSymbolicLink() ||
      owner.uid !== process.getuid?.() ||
      (owner.mode & 0o777) !== 0o600 ||
      (await readFile(ownerPath, 'utf8')) !== token
    )
      throw new Error('MFA fixture lock ownership changed; foreign lock left untouched');
    await unlink(ownerPath);
    await rmdir(lock);
  }
}
