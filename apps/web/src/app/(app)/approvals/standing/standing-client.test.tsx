// @vitest-environment jsdom
import React from 'react';
import { webcrypto } from 'node:crypto';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StandingApprovalClient } from './standing-client';
import { requestStanding } from './standing-transport';
import { fixture, hash, id, binding } from './standing.test-fixture';
import { intentHash, journalKey, journalText, readJournal, writeJournal } from './standing-journal';
vi.mock('./standing-transport', () => ({ requestStanding: vi.fn() }));
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: { request: vi.fn(async (_key, _opts, run) => run()) },
  });
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('retains the exact request before challenge; lost record reply reload recovers receipt without another operation or code persistence', async () => {
  const { journal, context } = fixture();
  writeJournal(localStorage, journal, null);
  const commitment = await intentHash(journal);
  let recorded = false;
  vi.mocked(requestStanding).mockImplementation(async (_t, _a, path, body) => {
    if (path === '/standing-approvals') return { data: context };
    if (path.endsWith('/recover'))
      return {
        data: recorded
          ? {
              ...binding(journal),
              recorded: true,
              requestSha256: commitment,
              revisionId: id(30),
              state: 'reviewed',
              receiptId: '123',
            }
          : {
              ...binding(journal),
              recorded: false,
              requestSha256: commitment,
              fenced: false,
              fenceReceiptId: null,
              challengeExpiresAt: null,
            },
      };
    expect(readJournal(localStorage, id(3), id(1))?.intent).toEqual(journal.intent);
    if (path.endsWith('/challenge'))
      return {
        data: { challengeId: id(50), expiresAt: new Date(Date.now() + 300000).toISOString() },
      };
    if (path.endsWith('/verify')) return { data: { verified: true, challengeId: id(50) } };
    if (path.endsWith('/record')) {
      recorded = true;
      throw new Error('Original record reply lost');
    }
    throw new Error('Unexpected transport');
  });
  const first = render(<StandingApprovalClient tenantId={id(3)} actorId={id(1)} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Prepare authenticator challenge' }));
  const code = await screen.findByLabelText('Authenticator code');
  fireEvent.change(code, { target: { value: '654321' } });
  fireEvent.click(screen.getByRole('button', { name: 'Verify authenticator code' }));
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Record original request' }).hasAttribute('disabled'),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Record original request' }));
  await screen.findByText('Original record reply lost');
  const retained = localStorage.getItem(journalKey(id(3), id(1)));
  expect(retained).not.toContain('654321');
  expect((code as HTMLInputElement).value).toBe('');
  first.unmount();
  render(<StandingApprovalClient tenantId={id(3)} actorId={id(1)} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Recover original request' }));
  await screen.findByText(/Recorded receipt 123/);
  expect(
    vi.mocked(requestStanding).mock.calls.filter(([, , p]) => p.endsWith('/record')),
  ).toHaveLength(1);
  expect(
    vi.mocked(requestStanding).mock.calls.filter(([, , p]) => p.endsWith('/challenge')),
  ).toHaveLength(1);
  expect(localStorage.getItem(journalKey(id(3), id(1)))).toBe(retained);
  fireEvent.click(
    screen.getByRole('button', { name: 'Archive confirmed receipt and prepare another decision' }),
  );
  await waitFor(() => expect(localStorage.getItem(journalKey(id(3), id(1)))).toBeNull());
  expect(localStorage.getItem(journalKey(id(3), id(1)) + ':archive:' + id(30))).toContain('123');
});
it('does not send a request when storage write-roundtrip fails', async () => {
  const { context } = fixture();
  vi.mocked(requestStanding).mockResolvedValue({ data: context });
  render(<StandingApprovalClient tenantId={id(3)} actorId={id(1)} />);
  fireEvent.change(await screen.findByLabelText('Eligible policy and source plan'), {
    target: { value: '0' },
  });
  fireEvent.click(screen.getByLabelText(/I reviewed this exact measured scope/));
  fireEvent.change(screen.getByLabelText(/Decision reason/), {
    target: { value: 'Reviewed synthetic local target scope carefully.' },
  });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => undefined);
  fireEvent.click(screen.getByRole('button', { name: 'Retain owner delegation request' }));
  await screen.findByText(/Nothing was sent/);
  expect(
    vi.mocked(requestStanding).mock.calls.every(([, , p]) => p === '/standing-approvals'),
  ).toBe(true);
});
it('rechecks current storage under the lock and refuses a competing tab intent', async () => {
  const { context, journal } = fixture();
  writeJournal(localStorage, journal, null);
  vi.mocked(requestStanding).mockResolvedValue({ data: context });
  render(<StandingApprovalClient tenantId={id(3)} actorId={id(1)} />);
  const recover = await screen.findByRole('button', { name: 'Recover original request' });
  localStorage.setItem(
    journalKey(id(3), id(1)),
    journalText({
      ...journal,
      challengeId: id(51),
      challengeExpiresAt: new Date(Date.now() + 300000).toISOString(),
    }),
  );
  fireEvent.click(recover);
  await screen.findByText(/Another tab changed/);
  expect(vi.mocked(requestStanding).mock.calls.some(([, , p]) => p.endsWith('/recover'))).toBe(
    false,
  );
});
it('shows only the named reviewer approval, after explicit scope review; issued means no execution', async () => {
  const { context, journal } = fixture();
  if (journal.intent.phase !== 'request') throw Error();
  const c = {
    ...context,
    actorId: id(2),
    candidates: [],
    revisions: [
      {
        revisionId: id(30),
        requestSha256: hash,
        request: journal.intent.request,
        state: 'requested',
        ownerReceiptId: '1',
        reviewerReceiptId: null,
      },
    ],
  };
  vi.mocked(requestStanding).mockResolvedValue({ data: c });
  render(<StandingApprovalClient tenantId={id(3)} actorId={id(2)} />);
  const approve = await screen.findByRole('button', { name: /Retain approval/ });
  fireEvent.change(screen.getByLabelText(/Decision reason/), {
    target: { value: 'Reviewed exact source and one approval limit.' },
  });
  expect(approve.hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByLabelText(/I reviewed this exact revision/));
  fireEvent.click(approve);
  await screen.findByText('Recover or confirm your retained approve');
  expect(readJournal(localStorage, id(3), id(2))?.intent.phase).toBe('approve');
  expect(screen.queryByRole('button', { name: /execute/i })).toBeNull();
});
it('does not offer approval controls to a different account', async () => {
  const { context, journal } = fixture();
  if (journal.intent.phase !== 'request') throw Error();
  vi.mocked(requestStanding).mockResolvedValue({
    data: {
      ...context,
      actorId: id(4),
      candidates: [],
      revisions: [
        {
          revisionId: id(30),
          requestSha256: hash,
          request: journal.intent.request,
          state: 'requested',
          ownerReceiptId: '1',
          reviewerReceiptId: null,
        },
      ],
    },
  });
  render(<StandingApprovalClient tenantId={id(3)} actorId={id(4)} />);
  await screen.findByText(/Revision 10000000/);
  expect(screen.queryByRole('button', { name: /Retain approval|Retain revocation/ })).toBeNull();
});
it('keeps unknown outcomes retained and blocks replacement until a matching recorded/fenced proof exists', async () => {
  const { context, journal } = fixture();
  writeJournal(localStorage, journal, null);
  const before = localStorage.getItem(journalKey(id(3), id(1)));
  vi.mocked(requestStanding).mockImplementation(async (_t, _a, path) => {
    if (path === '/standing-approvals') return { data: context };
    throw new Error('standing_operation_unconfirmed');
  });
  render(<StandingApprovalClient tenantId={id(3)} actorId={id(1)} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Recover original request' }));
  await screen.findByText('standing_operation_unconfirmed');
  expect(localStorage.getItem(journalKey(id(3), id(1)))).toBe(before);
  expect(screen.queryByRole('button', { name: /Archive confirmed|Retain owner/ })).toBeNull();
});
it('leaves all mutations unavailable when actual server context is disabled', async () => {
  vi.mocked(requestStanding).mockRejectedValue(
    new Error('Standing approval delegation is disabled or unavailable in this deployment.'),
  );
  render(<StandingApprovalClient tenantId={id(3)} actorId={id(1)} />);
  await screen.findByText(/disabled or unavailable/);
  expect(
    screen.queryByRole('button', { name: /Retain owner|Retain approval|Record original/ }),
  ).toBeNull();
});
it('recovers a lost challenge reply without issuing another challenge until authoritative expiry or fencing', async () => {
  const { context, journal } = fixture();
  writeJournal(localStorage, journal, null);
  const commitment = await intentHash(journal);
  let challengeIssued = false;
  vi.mocked(requestStanding).mockImplementation(async (_t, _a, path) => {
    if (path === '/standing-approvals') return { data: context };
    if (path.endsWith('/recover'))
      return {
        data: {
          ...binding(journal),
          recorded: false,
          requestSha256: commitment,
          fenced: false,
          fenceReceiptId: null,
          challengeExpiresAt: challengeIssued ? new Date(Date.now() + 300000).toISOString() : null,
        },
      };
    if (path.endsWith('/challenge')) {
      challengeIssued = true;
      throw new Error('Challenge reply lost');
    }
    if (path.endsWith('/fence'))
      return {
        data: {
          ...binding(journal),
          recorded: false,
          requestSha256: commitment,
          fenced: true,
          fenceReceiptId: '444',
          challengeExpiresAt: null,
        },
      };
    throw Error('Unexpected request');
  });
  render(<StandingApprovalClient tenantId={id(3)} actorId={id(1)} />);
  const prepare = await screen.findByRole('button', { name: 'Prepare authenticator challenge' });
  // The retained journal renders before the asynchronous authority read finishes.
  // Wait for that read to enable the action; a click on a disabled button is ignored.
  await waitFor(() => expect(prepare.hasAttribute('disabled')).toBe(false));
  fireEvent.click(prepare);
  await screen.findByText('Challenge reply lost');
  fireEvent.click(screen.getByRole('button', { name: 'Prepare authenticator challenge' }));
  await screen.findByText(/An earlier challenge may still be active/);
  expect(
    vi.mocked(requestStanding).mock.calls.filter(([, , p]) => p.endsWith('/challenge')),
  ).toHaveLength(1);
  fireEvent.click(
    screen.getByRole('button', { name: 'Fence original request against later recording' }),
  );
  await screen.findByText(/Original request fenced; receipt 444/);
  expect(localStorage.getItem(journalKey(id(3), id(1)))).toContain(id(30));
});
it('refuses foreign-context success responses before presenting candidate actions', async () => {
  const { context } = fixture();
  vi.mocked(requestStanding).mockResolvedValue({ data: { ...context, actorId: id(99) } });
  render(<StandingApprovalClient tenantId={id(3)} actorId={id(1)} />);
  await screen.findByText(/Current account or organization could not be confirmed/);
  expect(screen.queryByRole('button', { name: /Retain owner/ })).toBeNull();
});
it('recovers a lost successful verify reply by retrying only the original challenge recording', async () => {
  const { journal, context } = fixture();
  writeJournal(localStorage, journal, null);
  const commitment = await intentHash(journal);
  let satisfied = false;
  vi.mocked(requestStanding).mockImplementation(async (_t, _a, path, body) => {
    if (path === '/standing-approvals') return { data: context };
    if (path.endsWith('/recover'))
      return {
        data: {
          ...binding(journal),
          recorded: false,
          requestSha256: commitment,
          fenced: false,
          fenceReceiptId: null,
          challengeExpiresAt: null,
        },
      };
    if (path.endsWith('/challenge'))
      return {
        data: { challengeId: id(50), expiresAt: new Date(Date.now() + 300000).toISOString() },
      };
    if (path.endsWith('/verify')) {
      satisfied = true;
      throw new Error('Verify reply interrupted');
    }
    if (path.endsWith('/record')) {
      expect(satisfied).toBe(true);
      expect(body).toMatchObject({ challengeId: id(50), intent: journal.intent });
      return {
        data: {
          ...binding(journal),
          recorded: true,
          requestSha256: commitment,
          revisionId: id(30),
          state: 'requested',
          receiptId: '777',
        },
      };
    }
    throw Error('Unexpected transport');
  });
  render(<StandingApprovalClient tenantId={id(3)} actorId={id(1)} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Prepare authenticator challenge' }));
  fireEvent.change(await screen.findByLabelText('Authenticator code'), {
    target: { value: '111222' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Verify authenticator code' }));
  await screen.findByText('Verify reply interrupted');
  fireEvent.click(screen.getByRole('button', { name: 'Recover original request' }));
  fireEvent.click(
    await screen.findByRole('button', { name: 'Retry original recording with retained challenge' }),
  );
  await screen.findByText(/Recorded receipt 777/);
  expect(
    vi.mocked(requestStanding).mock.calls.filter(([, , p]) => p.endsWith('/challenge')),
  ).toHaveLength(1);
});
