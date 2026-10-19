'use client';
import { useEffect, useRef, useState } from 'react';
import {
  encodeOnboardingRequest,
  onboardingRequest as requestSchema,
  type OnboardingOperation,
  type OnboardingRequest,
} from '@axiom/types';
import {
  readOnboardingJournal,
  retainOnboardingJournal,
  archiveOnboardingJournal,
  withOnboardingLock,
  type OnboardingJournal,
} from './operation-journal';
import { onboardingRequest } from './operation-transport';
const digest = async (text: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))))
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
export function useOnboardingOperation(actorId: string) {
  const active = useRef(false);
  const [retained, setRetained] = useState<OnboardingJournal | null>(null),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    try {
      setRetained(readOnboardingJournal(localStorage, actorId));
    } catch {
      setError('The retained organization request cannot be verified. Nothing was sent.');
    }
  }, [actorId]);
  async function act(
    action: 'create' | 'read' | 'fence',
    input?: OnboardingRequest,
  ): Promise<OnboardingOperation | null> {
    if (active.current) return null;
    active.current = true;
    setBusy(true);
    setError(null);
    try {
      return await withOnboardingLock(actorId, async () => {
        let journal = readOnboardingJournal(localStorage, actorId);
        const request = input ? requestSchema.parse(input) : undefined;
        if (action === 'create') {
          if (!request) throw Error('Review the original organization fields.');
          const hash = await digest(encodeOnboardingRequest(request));
          if (journal && journal.requestSha256 !== hash)
            throw Error(
              'Re-enter the original fields, or check and close the original request before changing them.',
            );
          if (!journal)
            journal = {
              schemaVersion: 1,
              actorId,
              operationKey: crypto.randomUUID(),
              requestSha256: hash,
            };
          retainOnboardingJournal(localStorage, journal);
          setRetained(journal);
          // Reconcile before an original retry; an absent read is not permission to
          // replace its operation. Only this exact retained operation can be sent.
          const original = await onboardingRequest(journal, 'read');
          if (original.state !== 'unconfirmed') {
            const proof = archiveOnboardingJournal(localStorage, journal, original);
            setRetained(null);
            return proof;
          }
        }
        if (!journal) throw Error('No original request is retained for this account.');
        if (
          action === 'fence' &&
          request &&
          (await digest(encodeOnboardingRequest(request))) !== journal.requestSha256
        )
          throw Error(
            'Re-enter the original fields before closing the retained request. Nothing was sent.',
          );
        const result = await onboardingRequest(journal, action, request);
        if (result.state !== 'unconfirmed') {
          archiveOnboardingJournal(localStorage, journal, result);
          setRetained(null);
        } else setRetained(journal);
        return result;
      });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'The original outcome could not be confirmed.');
      return null;
    } finally {
      active.current = false;
      setBusy(false);
    }
  }
  return { retained, error, busy, act };
}
