// @vitest-environment jsdom
import { beforeEach, it, expect, vi } from 'vitest';
import {
  readOnboardingJournal,
  retainOnboardingJournal,
  archiveOnboardingJournal,
  withOnboardingLock,
} from './operation-journal';
const intent = {
  schemaVersion: 1 as const,
  actorId: '11111111-1111-4111-8111-111111111111',
  operationKey: '22222222-2222-4222-8222-222222222222',
  requestSha256: 'a'.repeat(64),
};
beforeEach(() => localStorage.clear());
it('retains only opaque original identity and recovers it after reload', () => {
  retainOnboardingJournal(localStorage, intent);
  expect(readOnboardingJournal(localStorage, intent.actorId)).toEqual(intent);
  expect(localStorage.getItem(localStorage.key(0)!)).not.toContain('request":');
});
it('never replaces an original operation with another tab request', () => {
  retainOnboardingJournal(localStorage, intent);
  expect(() =>
    retainOnboardingJournal(localStorage, {
      ...intent,
      operationKey: '33333333-3333-4333-8333-333333333333',
    }),
  ).toThrow();
  expect(readOnboardingJournal(localStorage, intent.actorId)).toEqual(intent);
});
it.each(['actorId', 'operationKey', 'requestSha256'] as const)(
  'foreign %s proof cannot clear intent',
  (field) => {
    retainOnboardingJournal(localStorage, intent);
    expect(() =>
      archiveOnboardingJournal(localStorage, intent, {
        actorId: intent.actorId,
        operationKey: intent.operationKey,
        requestSha256: intent.requestSha256,
        state: 'fenced',
        [field]:
          field === 'requestSha256' ? 'b'.repeat(64) : '33333333-3333-4333-8333-333333333333',
      }),
    ).toThrow();
    expect(readOnboardingJournal(localStorage, intent.actorId)).toEqual(intent);
  },
);
it('unknown original remains retained; exact fence is archived before clearing', () => {
  retainOnboardingJournal(localStorage, intent);
  const { schemaVersion: _, ...basis } = intent;
  expect(() =>
    archiveOnboardingJournal(localStorage, intent, { ...basis, state: 'unconfirmed' }),
  ).toThrow();
  archiveOnboardingJournal(localStorage, intent, { ...basis, state: 'fenced' });
  expect(readOnboardingJournal(localStorage, intent.actorId)).toBe(null);
  expect(localStorage.length).toBe(1);
});
it('fails closed on storage roundtrip failure', () => {
  const storage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
    key: () => null,
    length: 0,
  };
  expect(() => retainOnboardingJournal(storage, intent)).toThrow();
});
it('fails closed without Web Locks', async () => {
  vi.stubGlobal('navigator', {});
  const work = vi.fn();
  await expect(withOnboardingLock(intent.actorId, work)).rejects.toThrow();
  expect(work).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

it('does not queue a second tab to create a replacement after the first completes', async () => {
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: async (
        _name: string,
        options: { ifAvailable: boolean },
        work: (lock: unknown) => Promise<unknown>,
      ) => {
        expect(options.ifAvailable).toBe(true);
        return work(null);
      },
    },
  });
  const work = vi.fn();
  await expect(withOnboardingLock(intent.actorId, work)).rejects.toThrow('another tab');
  expect(work).not.toHaveBeenCalled();
});
