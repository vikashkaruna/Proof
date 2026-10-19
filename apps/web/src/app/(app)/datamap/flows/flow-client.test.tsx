// @vitest-environment jsdom
import React from 'react';
import { webcrypto } from 'node:crypto';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DataFlowClient } from './flow-client';
import { requestDataFlow } from './flow-transport';
import { fixture, hash, id, binding } from './flow.test-fixture';
import { intentHash, journalKey, journalText, readJournal, writeJournal } from './flow-journal';
vi.mock('./flow-transport', () => ({ requestDataFlow: vi.fn() }));
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
  vi.mocked(requestDataFlow).mockImplementation(async (_t, _a, path, body) => {
    if (path === '/data-flows') return { data: context };
    if (path.endsWith('/recover'))
      return {
        data: recorded
          ? {
              ...binding(journal),
              recorded: true,
              requestSha256: commitment,
              revisionId: id(30),
              state: 'approved',
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
  const first = render(<DataFlowClient tenantId={id(3)} actorId={id(1)} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Prepare authenticator challenge' }));
  const code = await screen.findByLabelText('Authenticator code');
  fireEvent.change(code, { target: { value: '654321' } });
  fireEvent.click(screen.getByRole('button', { name: 'Verify authenticator code' }));
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Record original declare' }).hasAttribute('disabled'),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Record original declare' }));
  await screen.findByText('Original record reply lost');
  const retained = localStorage.getItem(journalKey(id(3), id(1)));
  expect(retained).not.toContain('654321');
  expect((code as HTMLInputElement).value).toBe('');
  first.unmount();
  render(<DataFlowClient tenantId={id(3)} actorId={id(1)} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Recover original request' }));
  await screen.findByText(/Recorded receipt 123/);
  expect(
    vi.mocked(requestDataFlow).mock.calls.filter(([, , p]) => p.endsWith('/record')),
  ).toHaveLength(1);
  expect(
    vi.mocked(requestDataFlow).mock.calls.filter(([, , p]) => p.endsWith('/challenge')),
  ).toHaveLength(1);
  expect(localStorage.getItem(journalKey(id(3), id(1)))).toBe(retained);
  fireEvent.click(
    screen.getByRole('button', { name: 'Archive confirmed receipt and prepare another decision' }),
  );
  await waitFor(() => expect(localStorage.getItem(journalKey(id(3), id(1)))).toBeNull());
  expect(localStorage.getItem(journalKey(id(3), id(1)) + ':archive:' + id(30))).toContain('123');
});
it('keeps unknown outcomes retained and blocks replacement until a matching recorded/fenced proof exists', async () => {
  const { context, journal } = fixture();
  writeJournal(localStorage, journal, null);
  const before = localStorage.getItem(journalKey(id(3), id(1)));
  vi.mocked(requestDataFlow).mockImplementation(async (_t, _a, path) => {
    if (path === '/data-flows') return { data: context };
    throw new Error('standing_operation_unconfirmed');
  });
  render(<DataFlowClient tenantId={id(3)} actorId={id(1)} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Recover original request' }));
  await screen.findByText('standing_operation_unconfirmed');
  expect(localStorage.getItem(journalKey(id(3), id(1)))).toBe(before);
  expect(screen.queryByRole('button', { name: /Archive confirmed|Retain owner/ })).toBeNull();
});
it('leaves all mutations unavailable when actual server context is disabled', async () => {
  vi.mocked(requestDataFlow).mockRejectedValue(
    new Error('Standing approval delegation is disabled or unavailable in this deployment.'),
  );
  render(<DataFlowClient tenantId={id(3)} actorId={id(1)} />);
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
  vi.mocked(requestDataFlow).mockImplementation(async (_t, _a, path) => {
    if (path === '/data-flows') return { data: context };
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
  render(<DataFlowClient tenantId={id(3)} actorId={id(1)} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Prepare authenticator challenge' }));
  await screen.findByText('Challenge reply lost');
  fireEvent.click(screen.getByRole('button', { name: 'Prepare authenticator challenge' }));
  await screen.findByText(/An earlier challenge may still be active/);
  expect(
    vi.mocked(requestDataFlow).mock.calls.filter(([, , p]) => p.endsWith('/challenge')),
  ).toHaveLength(1);
  fireEvent.click(
    screen.getByRole('button', { name: 'Fence original request against later recording' }),
  );
  await screen.findByText(/Original request fenced; receipt 444/);
  expect(localStorage.getItem(journalKey(id(3), id(1)))).toContain(id(30));
});
it('refuses foreign-context success responses before presenting candidate actions', async () => {
  const { context } = fixture();
  vi.mocked(requestDataFlow).mockResolvedValue({ data: { ...context, actorId: id(99) } });
  render(<DataFlowClient tenantId={id(3)} actorId={id(1)} />);
  await screen.findByText(/Current account or organization could not be confirmed/);
  expect(screen.queryByRole('button', { name: /Retain owner/ })).toBeNull();
});
it('recovers a lost successful verify reply by retrying only the original challenge recording', async () => {
  const { journal, context } = fixture();
  writeJournal(localStorage, journal, null);
  const commitment = await intentHash(journal);
  let satisfied = false;
  vi.mocked(requestDataFlow).mockImplementation(async (_t, _a, path, body) => {
    if (path === '/data-flows') return { data: context };
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
          state: 'proposed',
          receiptId: '777',
        },
      };
    }
    throw Error('Unexpected transport');
  });
  render(<DataFlowClient tenantId={id(3)} actorId={id(1)} />);
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
    vi.mocked(requestDataFlow).mock.calls.filter(([, , p]) => p.endsWith('/challenge')),
  ).toHaveLength(1);
});
it('retains exact typed source pins and Unknowns before any authenticated mutation', async () => {
  const { context } = fixture();
  vi.mocked(requestDataFlow).mockResolvedValue({ data: context });
  render(<DataFlowClient tenantId={id(3)} actorId={id(1)} />);
  fireEvent.change(await screen.findByLabelText('Origin system'), { target: { value: id(10) } });
  fireEvent.change(screen.getByLabelText('Source note / reason for unknown destination'), {
    target: { value: 'Synthetic interview; destination not established.' },
  });
  fireEvent.change(screen.getByLabelText('Reason for recording'), {
    target: { value: 'Reviewed explicit source and unresolved destination carefully.' },
  });
  fireEvent.click(screen.getByLabelText(/I reviewed the selected registered sources/));
  fireEvent.click(
    screen.getByRole('button', { name: 'Retain declaration for authenticator review' }),
  );
  await screen.findByText(/Recover or confirm your retained declare/);
  const retained = readJournal(localStorage, id(3), id(1));
  expect(retained?.intent.request).toMatchObject({
    origin: context.systems[0]?.pin,
    crossBorder: null,
    dataCategories: null,
    destinationCountries: null,
    destination: { kind: 'unknown' },
  });
  expect(vi.mocked(requestDataFlow).mock.calls.every(([, , p]) => p === '/data-flows')).toBe(true);
});
it('storage failure sends no mutation and leaves a readable error', async () => {
  const { context } = fixture();
  vi.mocked(requestDataFlow).mockResolvedValue({ data: context });
  render(<DataFlowClient tenantId={id(3)} actorId={id(1)} />);
  fireEvent.change(await screen.findByLabelText('Origin system'), { target: { value: id(10) } });
  fireEvent.change(screen.getByLabelText('Source note / reason for unknown destination'), {
    target: { value: 'Synthetic interview; destination not established.' },
  });
  fireEvent.change(screen.getByLabelText('Reason for recording'), {
    target: { value: 'Reviewed explicit source and unresolved destination carefully.' },
  });
  fireEvent.click(screen.getByLabelText(/I reviewed the selected registered sources/));
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => undefined);
  fireEvent.click(
    screen.getByRole('button', { name: 'Retain declaration for authenticator review' }),
  );
  await screen.findByText(/Nothing was sent/);
  expect(vi.mocked(requestDataFlow).mock.calls.every(([, , p]) => p === '/data-flows')).toBe(true);
});
it('read-only role retains historical recovery access without any mutation controls', async () => {
  const { context, journal } = fixture();
  writeJournal(localStorage, journal, null);
  vi.mocked(requestDataFlow).mockResolvedValue({
    data: { ...context, canPrepare: false, canReview: false },
  });
  render(<DataFlowClient tenantId={id(3)} actorId={id(1)} />);
  await screen.findByRole('button', { name: 'Recover original request' });
  expect(screen.queryByRole('button', { name: 'Prepare authenticator challenge' })).toBeNull();
  expect(
    screen.queryByRole('button', { name: 'Fence original request against later recording' }),
  ).toBeNull();
});
