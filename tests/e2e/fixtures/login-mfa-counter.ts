import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withMfaFixtureLock } from './login-mfa-lock';

/** Disposable timing hint, never authentication evidence. Real BFF verification
 * remains mandatory. The private cross-worker lock protects counter bookkeeping.
 */
export async function withFreshMfaFixtureCounter<T>(
  directory: string,
  userId: string,
  operation: () => Promise<T>,
  clock: { now: () => number; wait: (ms: number) => Promise<void> } = {
    now: Date.now,
    wait: delay,
  },
): Promise<T> {
  return withMfaFixtureLock(directory, userId, async () => {
    const path = join(directory, `${userId}.counter`);
    const file = await open(
      path,
      constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o777) !== 0o600 ||
        stat.size > 32
      )
        throw new Error('MFA fixture counter must be an owned private regular file');
      const text = await file.readFile('utf8');
      const now = clock.now();
      if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid MFA fixture clock');
      const current = Math.floor(now / 30_000);
      // Unknown initial consumption needs a fresh window. A previous successful
      // verification only needs a wait if its conservatively recorded window remains current.
      const used = text === '' ? current : Number(text);
      if (
        (text !== '' && !/^(0|[1-9][0-9]*)$/.test(text)) ||
        !Number.isSafeInteger(used) ||
        used < 0 ||
        used > current
      )
        throw new Error('Invalid MFA fixture counter hint');
      const ready = (used + 1) * 30_000 + 100;
      while (clock.now() < ready) await clock.wait(ready - clock.now());
      const result = await operation();
      const finished = clock.now();
      if (!Number.isSafeInteger(finished) || finished < now)
        throw new Error('Invalid MFA fixture clock');
      // Record after actual successful verification, conservatively including a
      // rollover during its response. No secret, code or session is persisted.
      await file.truncate(0);
      await file.write(String(Math.floor(finished / 30_000)), 0, 'utf8');
      return result;
    } finally {
      await file.close();
    }
  });
}
