import {
  onboardingIntent,
  verifyOnboardingOperation,
  type OnboardingOperation,
} from '@axiom/types';
import { z } from 'zod';
export const onboardingJournal = onboardingIntent.omit({ request: true }).strict();
export type OnboardingJournal = z.infer<typeof onboardingJournal>;
const equal = (a: OnboardingJournal, b: OnboardingJournal) =>
  a.actorId === b.actorId &&
  a.operationKey === b.operationKey &&
  a.requestSha256 === b.requestSha256 &&
  a.schemaVersion === b.schemaVersion;
const key = (actorId: string) => `axiom:onboarding:v1:${z.uuid().parse(actorId)}`;
export function readOnboardingJournal(storage: Storage, actorId: string): OnboardingJournal | null {
  const raw = storage.getItem(key(actorId));
  if (raw === null) return null;
  if (raw.length > 1024) throw Error('The original request cannot be verified. Nothing was sent.');
  const journal = onboardingJournal.parse(JSON.parse(raw));
  if (journal.actorId !== actorId) throw Error('The original request belongs to another account.');
  return journal;
}
export function retainOnboardingJournal(storage: Storage, journal: OnboardingJournal): void {
  const parsed = onboardingJournal.parse(journal),
    existing = readOnboardingJournal(storage, parsed.actorId);
  const encoded = JSON.stringify(parsed);
  if (existing && !equal(existing, parsed))
    throw Error('Resolve the original request before preparing another organization.');
  storage.setItem(key(parsed.actorId), encoded);
  if (storage.getItem(key(parsed.actorId)) !== encoded)
    throw Error('The original request could not be safely retained. Nothing was sent.');
}
export function archiveOnboardingJournal(
  storage: Storage,
  journal: OnboardingJournal,
  value: unknown,
): OnboardingOperation {
  const proof = verifyOnboardingOperation(value, journal);
  if (proof.state === 'unconfirmed') throw Error('The original outcome is still unconfirmed.');
  const current = readOnboardingJournal(storage, journal.actorId);
  if (!current || !equal(current, journal))
    throw Error('The retained request changed in another tab.');
  const archiveKey = `${key(journal.actorId)}:resolved:${journal.operationKey}`;
  const text = JSON.stringify(proof),
    old = storage.getItem(archiveKey);
  if (old !== null && old !== text) throw Error('The saved original proof changed.');
  storage.setItem(archiveKey, text);
  if (storage.getItem(archiveKey) !== text)
    throw Error('The original proof could not be safely retained.');
  // Reread under the browser lock before clearing; never erase another intent.
  if (!equal(onboardingJournal.parse(readOnboardingJournal(storage, journal.actorId)), journal))
    throw Error('The retained request changed.');
  storage.removeItem(key(journal.actorId));
  if (storage.getItem(key(journal.actorId)) !== null)
    throw Error('The original request could not be archived.');
  return proof;
}
export async function withOnboardingLock<T>(actorId: string, action: () => Promise<T>): Promise<T> {
  if (!navigator.locks)
    throw Error('Safe request coordination is unavailable in this browser. Nothing was sent.');
  return navigator.locks.request(key(actorId), { mode: 'exclusive', ifAvailable: true }, (lock) => {
    if (!lock)
      throw Error(
        'This account has an organization request open in another tab. Nothing was sent.',
      );
    return action();
  });
}
