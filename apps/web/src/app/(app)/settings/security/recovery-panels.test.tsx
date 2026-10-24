// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RecoveryBeneficiary, RecoveryConsole, sessionFingerprint } from './recovery-panels';

const SESSION = 'abcd1234-5678-4abc-8def-0123456789ab';
const fetchMock = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

it('derives the same short fingerprint both people compare', () => {
  expect(sessionFingerprint(SESSION)).toBe('ABCD-1234');
});

it('binds this sign-in, then shows the fingerprint to read to the founder', async () => {
  fetchMock.mockResolvedValueOnce(json({ case_id: 'case-1' }));
  render(
    <RecoveryBeneficiary
      tenantId="tenant-1"
      initial={{ caseId: 'case-1', state: 'opened', boundHere: false, sessionId: SESSION }}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Bind this sign-in' }));
  await waitFor(() =>
    expect(screen.getByTestId('session-fingerprint').textContent).toBe('ABCD-1234'),
  );
  const [url, init] = fetchMock.mock.calls[0]!;
  expect(url).toBe('/api/bff/v1/mfa/recovery/beneficiary/bind');
  expect(JSON.parse(init.body)).toEqual({ caseId: 'case-1' });
  expect(init.headers['X-Tenant-Id']).toBe('tenant-1');
});

it('after confirmation enrols the new authenticator and shows recovery codes once', async () => {
  fetchMock
    .mockResolvedValueOnce(
      json(
        { factorId: 'f-new', secret: 'JBSWY3DPEHPK3PXP', provisioningUri: 'otpauth://totp/x' },
        201,
      ),
    )
    .mockResolvedValueOnce(
      json({ factorId: 'f-new', recoveryCodes: ['aaaa-bbbb', 'cccc-dddd'] }, 201),
    );
  render(
    <RecoveryBeneficiary
      tenantId="tenant-1"
      initial={{ caseId: 'case-1', state: 'authorized', boundHere: true, sessionId: SESSION }}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Set up new authenticator' }));
  await screen.findByText('JBSW Y3DP EHPK 3PXP');
  fireEvent.change(screen.getByLabelText('Code from the new authenticator'), {
    target: { value: '123456' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Complete recovery' }));
  await waitFor(() =>
    expect(screen.getByTestId('recovery-code-list').textContent).toContain('aaaa-bbbb'),
  );
  expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toEqual({
    caseId: 'case-1',
    code: '123456',
  });
});

it('does not offer enrolment to a session the founder has not confirmed', () => {
  render(
    <RecoveryBeneficiary
      tenantId="tenant-1"
      initial={{ caseId: 'case-1', state: 'authorized', boundHere: false, sessionId: SESSION }}
    />,
  );
  expect(screen.queryByRole('button', { name: 'Set up new authenticator' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Bind this sign-in' })).toBeTruthy();
});

it('founder opens a recovery only with a subject, a stated verification and a code', async () => {
  fetchMock
    .mockResolvedValueOnce(
      json({
        founders: [{ user_id: 'f2', email: 'founder-test@example.invalid', full_name: null }],
        cases: [],
      }),
    )
    .mockResolvedValueOnce(json({ case_id: 'case-1' }, 201))
    .mockResolvedValueOnce(json({ founders: [], cases: [] }));
  render(<RecoveryConsole tenantId="tenant-1" />);
  fireEvent.click(screen.getByRole('button', { name: 'Open recovery console' }));
  const open = await screen.findByRole('button', { name: 'Open recovery' });
  expect((open as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Account to recover'), { target: { value: 'f2' } });
  fireEvent.change(screen.getByLabelText('How you verified their identity'), {
    target: { value: 'too short' },
  });
  fireEvent.change(screen.getByLabelText('Your authenticator code'), {
    target: { value: '123456' },
  });
  expect((open as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(open);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const note = screen.getByLabelText('How you verified their identity') as HTMLInputElement;
  expect(note.required).toBe(true);
  expect(note.minLength).toBe(10);
  expect(note.maxLength).toBe(1000);
  // The disabled button explains itself: only the short note is still missing.
  expect(open.getAttribute('aria-describedby')).toBe('recoveryOpenMissing');
  expect(document.getElementById('recoveryOpenMissing')?.textContent).toBe(
    'Still needed: a verification note of at least 10 characters.',
  );
  expect(document.getElementById('recoveryReasonHint')?.textContent).toBe(
    'Required: at least 10 characters (9 so far).',
  );
  fireEvent.change(screen.getByLabelText('How you verified their identity'), {
    target: { value: 'Video call on the known number at 14:05' },
  });
  expect(document.getElementById('recoveryOpenMissing')).toBeNull();
  fireEvent.click(open);
  await screen.findByRole('status');
  expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toEqual({
    subjectUserId: 'f2',
    reason: 'Video call on the known number at 14:05',
    code: '123456',
  });
});

it('founder confirms the exact bound session shown by fingerprint', async () => {
  fetchMock
    .mockResolvedValueOnce(
      json({
        founders: [{ user_id: 'f2', email: 'founder-test@example.invalid', full_name: null }],
        cases: [
          {
            case_id: 'case-1',
            subject_user_id: 'f2',
            state: 'bound',
            reason: 'Video call on the known number',
            expires_at: '2026-10-18T00:00:00Z',
            beneficiary_session: { session_id: SESSION, created_at: null, user_agent: null },
          },
        ],
      }),
    )
    .mockResolvedValueOnce(json({ case_id: 'case-1' }))
    .mockResolvedValueOnce(json({ founders: [], cases: [] }));
  render(<RecoveryConsole tenantId="tenant-1" />);
  fireEvent.click(screen.getByRole('button', { name: 'Open recovery console' }));
  expect((await screen.findByTestId('mfa-recovery-case')).textContent).toContain('ABCD-1234');
  fireEvent.change(screen.getByLabelText('Your authenticator code', { selector: '#auth-case-1' }), {
    target: { value: '654321' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Codes match — confirm' }));
  await screen.findByRole('status');
  expect(fetchMock.mock.calls[1]![0]).toBe('/api/bff/v1/mfa/recovery/cases/case-1/authorize');
  expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toEqual({
    beneficiarySessionId: SESSION,
    code: '654321',
  });
});

it('lists tenant owners and admins as recoverable accounts alongside founders', async () => {
  fetchMock.mockResolvedValueOnce(
    json({
      founders: [{ user_id: 'f2', email: 'founder-two@example.invalid', full_name: null }],
      owners: [{ user_id: 'o1', email: 'owner-one@example.invalid', full_name: 'Owner One' }],
      cases: [],
    }),
  );
  render(<RecoveryConsole tenantId="tenant-1" />);
  fireEvent.click(screen.getByRole('button', { name: 'Open recovery console' }));
  await screen.findByRole('button', { name: 'Open recovery' });
  const select = screen.getByLabelText('Account to recover') as HTMLSelectElement;
  const values = Array.from(select.options).map((o) => o.value);
  expect(values).toEqual(['', 'f2', 'o1']);
  expect(
    screen.getByRole('option', { name: 'Owner One — owner-one@example.invalid' }),
  ).toBeTruthy();
});

it('still renders for an overview without owners (pre-0156 server)', async () => {
  fetchMock.mockResolvedValueOnce(
    json({
      founders: [{ user_id: 'f2', email: 'founder-two@example.invalid', full_name: null }],
      cases: [],
    }),
  );
  render(<RecoveryConsole tenantId="tenant-1" />);
  fireEvent.click(screen.getByRole('button', { name: 'Open recovery console' }));
  await screen.findByRole('button', { name: 'Open recovery' });
  const select = screen.getByLabelText('Account to recover') as HTMLSelectElement;
  expect(Array.from(select.options).map((o) => o.value)).toEqual(['', 'f2']);
});

it('shows an unconfirmed result after a lost helper response instead of an unhandled rejection', async () => {
  fetchMock.mockRejectedValueOnce(new Error('network disconnected'));
  render(<RecoveryConsole tenantId="tenant-1" />);
  fireEvent.click(screen.getByRole('button', { name: 'Open recovery console' }));
  expect((await screen.findByRole('alert')).textContent).toContain('could not be confirmed');
  expect(screen.queryByRole('status')).toBeNull();
});

it('does not claim beneficiary recovery when the binding response is lost', async () => {
  fetchMock.mockRejectedValueOnce(new Error('network disconnected'));
  render(
    <RecoveryBeneficiary
      tenantId="tenant-1"
      initial={{ caseId: 'case-1', state: 'opened', boundHere: false, sessionId: SESSION }}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Bind this sign-in' }));
  expect((await screen.findByRole('alert')).textContent).toContain('could not be confirmed');
  expect(screen.queryByTestId('session-fingerprint')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Set up new authenticator' })).toBeNull();
});
