// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { webcrypto } from 'node:crypto';
import { CoverageClient } from './coverage-client';
import { requestCoverage } from './coverage-transport';
import { fixture, id, binding } from './coverage.test-fixture';
import { writeJournal, readJournal, journalKey, intentHash } from './coverage-journal';
vi.mock('./coverage-transport', () => ({ requestCoverage: vi.fn() }));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: { request: async (_k: string, _o: unknown, run: () => Promise<unknown>) => run() },
  });
  localStorage.clear();
  vi.mocked(requestCoverage).mockReset();
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const mount = () => render(<CoverageClient tenantId={id(3)} actorId={id(1)} />);
it('retains exact derived source and explicit Unknown/findings scope before any network mutation', async () => {
  const { context } = fixture();
  vi.mocked(requestCoverage).mockResolvedValue({ data: context });
  mount();
  fireEvent.change(await screen.findByLabelText('Eligible schedule and baseline'), {
    target: { value: '0' },
  });
  fireEvent.change(screen.getByLabelText(/Decision reason/), {
    target: { value: 'Reviewed separate technical-only findings authority.' },
  });
  fireEvent.click(screen.getByLabelText(/I reviewed the exact source/));
  fireEvent.click(screen.getByRole('button', { name: 'Retain owner assessment authorization' }));
  await screen.findByRole('heading', { name: 'Recover or confirm your retained authorize' });
  const saved = readJournal(localStorage, id(3), id(1));
  expect(saved?.intent.phase).toBe('authorize');
  if (saved?.intent.phase !== 'authorize') throw Error();
  expect(saved.intent.request.source).toEqual(context.candidates[0]!.source);
  expect(saved.intent.request.taskScopes).toEqual(['control_library.read', 'findings.write']);
  expect(saved.intent.request.declarationPolicy).toBe('all_business_facts_unknown');
  expect(requestCoverage).toHaveBeenCalledTimes(1);
});
it('does not send an authorization when storage roundtrip fails', async () => {
  const { context } = fixture();
  vi.mocked(requestCoverage).mockResolvedValue({ data: context });
  mount();
  fireEvent.change(await screen.findByLabelText('Eligible schedule and baseline'), {
    target: { value: '0' },
  });
  fireEvent.change(screen.getByLabelText(/Decision reason/), {
    target: { value: 'Reviewed separate technical-only findings authority.' },
  });
  fireEvent.click(screen.getByLabelText(/I reviewed the exact source/));
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => undefined);
  fireEvent.click(screen.getByRole('button', { name: 'Retain owner assessment authorization' }));
  await screen.findByText(/Nothing was sent/);
  expect(requestCoverage).toHaveBeenCalledTimes(1);
});
it('recovers a lost record reply after reload with the same operation and archives only its exact receipt', async () => {
  const { context, journal } = fixture();
  journal.challengeId = id(40);
  journal.challengeExpiresAt = new Date(Date.now() + 300000).toISOString();
  writeJournal(localStorage, journal, null);
  const hash = await intentHash(journal);
  let recorded = false;
  vi.mocked(requestCoverage).mockImplementation(async (_t, _a, path) => {
    if (path === '/scheduled-coverage') return { data: context };
    if (path.endsWith('/record')) {
      recorded = true;
      throw Error('coverage_operation_unconfirmed');
    }
    return {
      data: recorded
        ? {
            ...binding(journal),
            recorded: true,
            requestSha256: hash,
            scopeId: id(30),
            receiptId: '123',
            revoked: false,
          }
        : {
            ...binding(journal),
            recorded: false,
            requestSha256: hash,
            fenced: false,
            fenceReceiptId: null,
            challengeExpiresAt: journal.challengeExpiresAt,
          },
    };
  });
  const view = mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Recover original request' }));
  await screen.findByText(/No recorded decision confirmed/);
  fireEvent.click(
    screen.getByRole('button', { name: 'Retry original recording with retained challenge' }),
  );
  await screen.findByText('coverage_operation_unconfirmed');
  view.unmount();
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Recover original request' }));
  await screen.findByText(/Recorded receipt 123/);
  fireEvent.click(
    screen.getByRole('button', { name: 'Archive confirmed receipt and prepare another decision' }),
  );
  await waitFor(() => expect(localStorage.getItem(journalKey(id(3), id(1)))).toBeNull());
  expect(
    vi.mocked(requestCoverage).mock.calls.filter((c) => c[2].endsWith('/record')),
  ).toHaveLength(1);
});
it('refuses a foreign operation proof without clearing the retained decision', async () => {
  const { context, journal } = fixture();
  writeJournal(localStorage, journal, null);
  vi.mocked(requestCoverage).mockImplementation(async (_t, _a, path) =>
    path === '/scheduled-coverage'
      ? { data: context }
      : {
          data: {
            ...binding(journal),
            actorId: id(99),
            recorded: true,
            requestSha256: await intentHash(journal),
            scopeId: id(30),
            receiptId: '123',
            revoked: false,
          },
        },
  );
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Recover original request' }));
  await screen.findByText(/no matching recorded/);
  expect(readJournal(localStorage, id(3), id(1))).toEqual(journal);
  expect(screen.queryByRole('button', { name: /Archive confirmed/ })).toBeNull();
});
it('shows recorded active history separately from current eligibility, without claiming scores or a fire-to-scope association', async () => {
  const { context, journal } = fixture();
  if (journal.intent.phase !== 'authorize') throw Error();
  context.candidates = [];
  context.scopes = [
    {
      scopeId: id(30),
      requestSha256: 'a'.repeat(64),
      request: journal.intent.request,
      receiptId: '1',
      active: true,
      revoked: false,
    },
  ];
  context.fires = [
    {
      tenantId: id(3),
      fireId: id(50),
      state: 'unconfirmed',
      engagementId: id(51),
      jobId: id(52),
      runId: null,
      receiptId: null,
      resultDigest: null,
    },
  ];
  vi.mocked(requestCoverage).mockResolvedValue({ data: context });
  mount();
  await screen.findByText(/No eligible assessment source/);
  expect(screen.getByText(/It does not prove current source permissions/)).toBeTruthy();
  expect(screen.getByText('Recorded state: unconfirmed')).toBeTruthy();
  expect(screen.getByText(/independent retained fire references/)).toBeTruthy();
  expect(
    screen.queryByRole('button', { name: 'Retain owner assessment authorization' }),
  ).toBeNull();
});
it('keeps recovery available when deployment context is unavailable, without enabling new authority', async () => {
  const { journal } = fixture();
  writeJournal(localStorage, journal, null);
  vi.mocked(requestCoverage).mockRejectedValue(
    Error('Scheduled assessment delegation is disabled or unavailable.'),
  );
  mount();
  await screen.findByRole('alert');
  expect(
    screen.getByRole('button', { name: 'Recover original request' }).hasAttribute('disabled'),
  ).toBe(false);
  expect(
    screen
      .getByRole('button', { name: 'Prepare authenticator challenge' })
      .hasAttribute('disabled'),
  ).toBe(true);
  expect(readJournal(localStorage, id(3), id(1))).toEqual(journal);
});
it('invalidates current candidate consent on refresh and blocks stale source preparation', async () => {
  const { context } = fixture();
  vi.mocked(requestCoverage).mockResolvedValue({ data: context });
  mount();
  fireEvent.change(await screen.findByLabelText('Eligible schedule and baseline'), {
    target: { value: '0' },
  });
  fireEvent.click(screen.getByLabelText(/I reviewed the exact source/));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh sources and recorded scopes' }));
  await waitFor(() =>
    expect(
      (screen.getByLabelText('Eligible schedule and baseline') as HTMLSelectElement).value,
    ).toBe(''),
  );
  expect(screen.queryByLabelText(/I reviewed the exact source/)).toBeNull();
});

it('recovers lost successful verification and retries only the original retained revoke challenge', async () => {
  const { context, journal } = fixture();
  journal.intent = {
    phase: 'revoke',
    request: {
      schemaVersion: 1,
      operationKey: id(31),
      scopeId: id(30),
      requestSha256: 'a'.repeat(64),
      reason: 'Revoke the exact original technical assessment scope.',
    },
  };
  journal.challengeId = id(40);
  journal.challengeExpiresAt = new Date(Date.now() + 300000).toISOString();
  writeJournal(localStorage, journal, null);
  let satisfied = false;
  const proof = {
    ...binding(journal),
    recorded: false,
    fenced: false,
    fenceReceiptId: null,
    challengeExpiresAt: journal.challengeExpiresAt,
    requestSha256: await intentHash(journal),
  };
  vi.mocked(requestCoverage).mockImplementation(async (_t, _a, path, body) => {
    if (path === '/scheduled-coverage') return { data: context };
    if (path.endsWith('/verify')) {
      satisfied = true;
      throw Error('Verification reply interrupted');
    }
    if (path.endsWith('/record')) {
      expect(satisfied).toBe(true);
      expect(body).toEqual({ intent: journal.intent, challengeId: id(40) });
      return {
        data: {
          ...binding(journal),
          recorded: true,
          scopeId: id(30),
          receiptId: '2',
          requestSha256: await intentHash(journal),
          revoked: true,
        },
      };
    }
    return { data: proof };
  });
  mount();
  await screen.findByLabelText('Authenticator code');
  fireEvent.change(screen.getByLabelText('Authenticator code'), { target: { value: '000000' } });
  fireEvent.click(screen.getByRole('button', { name: 'Verify authenticator code' }));
  await screen.findByText('Verification reply interrupted');
  expect((screen.getByLabelText('Authenticator code') as HTMLInputElement).value).toBe('');
  expect(localStorage.getItem(journalKey(id(3), id(1)))).not.toContain('000000"');
  fireEvent.click(screen.getByRole('button', { name: 'Recover original request' }));
  await screen.findByRole('button', { name: 'Retry original recording with retained challenge' });
  fireEvent.click(
    screen.getByRole('button', { name: 'Retry original recording with retained challenge' }),
  );
  await screen.findByText(/Recorded receipt 2/);
  expect(
    vi.mocked(requestCoverage).mock.calls.filter((c) => c[2].endsWith('/challenge')),
  ).toHaveLength(0);
});
it('rejects a changed storage snapshot inside the exclusive lock before a POST', async () => {
  const { context, journal } = fixture();
  writeJournal(localStorage, journal, null);
  vi.mocked(requestCoverage).mockResolvedValue({ data: context });
  mount();
  await screen.findByRole('button', { name: 'Recover original request' });
  localStorage.setItem(
    journalKey(id(3), id(1)),
    JSON.stringify({
      ...journal,
      intent: {
        ...journal.intent,
        request: {
          ...journal.intent.request,
          reason: 'Changed by a different tab after the screen loaded.',
        },
      },
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Recover original request' }));
  await screen.findByText(/Another tab changed/);
  expect(vi.mocked(requestCoverage).mock.calls.filter((c) => c[3] !== undefined)).toHaveLength(0);
});
it('refuses a replacement challenge after an interrupted challenge reply and authoritative existing challenge proof', async () => {
  const { context, journal } = fixture();
  writeJournal(localStorage, journal, null);
  vi.mocked(requestCoverage).mockImplementation(async (_t, _a, path) =>
    path === '/scheduled-coverage'
      ? { data: context }
      : {
          data: {
            ...binding(journal),
            recorded: false,
            requestSha256: await intentHash(journal),
            fenced: false,
            fenceReceiptId: null,
            challengeExpiresAt: new Date(Date.now() + 300000).toISOString(),
          },
        },
  );
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Prepare authenticator challenge' }));
  await screen.findByText(/earlier challenge may still be active/);
  expect(
    vi.mocked(requestCoverage).mock.calls.filter((c) => c[2].endsWith('/challenge')),
  ).toHaveLength(0);
  expect(readJournal(localStorage, id(3), id(1))).toEqual(journal);
});
it('refuses stale foreign tenant history rather than exposing its source or preparing another intent', async () => {
  const { context, journal } = fixture();
  if (journal.intent.phase !== 'authorize') throw Error();
  context.scopes = [
    {
      scopeId: id(30),
      requestSha256: 'a'.repeat(64),
      request: { ...journal.intent.request, tenantId: id(99) },
      receiptId: '1',
      active: true,
      revoked: false,
    },
  ];
  vi.mocked(requestCoverage).mockResolvedValue({ data: context });
  mount();
  await screen.findByText(/different organization or source binding/);
  expect(screen.queryByRole('heading', { name: '2. Recorded scope history' })).toBeNull();
  expect(
    screen.queryByRole('button', { name: 'Retain owner assessment authorization' }),
  ).toBeNull();
});

it('archives an exact recorded receipt even when eligibility refresh is unavailable, without enabling another authorization', async () => {
  const { context, journal } = fixture();
  writeJournal(localStorage, journal, null);
  let outage = false;
  vi.mocked(requestCoverage).mockImplementation(async (_t, _a, path) => {
    if (path === '/scheduled-coverage') {
      if (outage) throw Error('Eligibility projection unavailable');
      return { data: context };
    }
    return {
      data: {
        ...binding(journal),
        recorded: true,
        requestSha256: await intentHash(journal),
        scopeId: id(30),
        receiptId: '1',
        revoked: false,
      },
    };
  });
  mount();
  await screen.findByRole('button', { name: 'Recover original request' });
  outage = true;
  fireEvent.click(screen.getByRole('button', { name: 'Recover original request' }));
  await screen.findByText(/Recorded receipt 1/);
  await screen.findByRole('alert');
  fireEvent.click(
    screen.getByRole('button', { name: 'Archive confirmed receipt and prepare another decision' }),
  );
  await waitFor(() => expect(readJournal(localStorage, id(3), id(1))).toBeNull());
  expect(localStorage.getItem(journalKey(id(3), id(1)) + ':archive:' + id(30))).toContain(
    '"receiptId":"1"',
  );
  expect(
    screen.queryByRole('button', { name: 'Retain owner assessment authorization' }),
  ).toBeNull();
});
it('refuses fresh requests without Web Locks before fetching or preparing authority', async () => {
  Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
  mount();
  await screen.findByText(/Web Locks/);
  expect(requestCoverage).not.toHaveBeenCalled();
  expect(
    screen.queryByRole('button', { name: 'Retain owner assessment authorization' }),
  ).toBeNull();
});
