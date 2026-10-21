// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CatalogueEngagementResponse } from '@axiom/types';
import { CatalogueEngagementClient } from './catalogue-client';

const tenant = '99161000-0000-4000-8000-000000000011';
const actor = '99161000-0000-4000-8000-000000000001';
const baselineRun = '99161000-0000-4000-8000-000000000021';
const baselineEngagement = '99161000-0000-4000-8000-000000000022';
const requestId = '99161000-0000-4000-8000-000000000023';
const newEngagement = '99161000-0000-4000-8000-000000000024';
const challengeId = '99161000-0000-4000-8000-000000000025';
const delta = {
  previousVersion: '0.1.1' as const,
  sha256: 'c'.repeat(64),
  added: [{ id: 'DPDP-NEW', title: 'Additional notice coverage' }],
  removed: [],
  changed: [{ id: 'DPDP-001', title: 'Privacy notice', fields: ['statuteSection'] }],
};
const fixture: CatalogueEngagementResponse = {
  currentVersion: '0.2.0',
  releasedVersions: [
    {
      libraryVersion: '0.2.0',
      changeLog: 'Corrected statutory references and notice coverage.',
      publishedAt: '2026-10-21T00:00:00Z',
      delta,
    },
  ],
  auditedBaselines: [
    {
      runId: baselineRun,
      engagementId: baselineEngagement,
      estateId: '99161000-0000-4000-8000-000000000026',
      libraryVersion: '0.1.1',
      finalizedAt: '2026-10-18T00:00:00Z',
    },
  ],
  upgradeOptions: [
    {
      baselineRunId: baselineRun,
      targetVersion: '0.2.0',
      delta: { ...delta, sha256: 'd'.repeat(64) },
    },
  ],
  requests: [],
  effectiveVersion: '0.1.1',
  hasFinalizedAudit: true,
  requiresOwnerRequest: true,
  historicalAuditNeedsReview: false,
};
const pending = {
  requestId,
  baselineRunId: baselineRun,
  targetVersion: '0.2.0' as const,
  deltaSha256: 'd'.repeat(64),
  ownerReason: 'Audit the newly released notice requirements.',
  requestedAt: '2026-10-21T01:00:00Z',
  status: 'pending' as const,
  decisionReason: null,
  engagementId: null,
  ownerReceiptId: '101',
  decisionReceiptId: null,
};
const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset().mockImplementation(async () => Response.json({ data: fixture }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount(canRequest = false, canDecide = false) {
  return render(
    <CatalogueEngagementClient
      tenantId={tenant}
      actorId={actor}
      canRequest={canRequest}
      canDecide={canDecide}
    />,
  );
}

it('shows the saved audited basis and readable release delta without granting a reader decisions', async () => {
  mount();
  await screen.findByText('Catalogue 0.1.1');
  expect(screen.getByText('Corrected statutory references and notice coverage.')).toBeTruthy();
  expect(screen.getByText('Changes from version 0.1.1 to 0.2.0')).toBeTruthy();
  expect(screen.getByText('Changed: statute Section')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Inspect saved assessment' }).getAttribute('href')).toBe(
    `/assessment?engagement=${baselineEngagement}`,
  );
  expect(screen.queryByRole('button', { name: 'Prepare request with MFA' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Review re-audit approval' })).toBeNull();
  expect(
    screen.getByText(/Catalogue release or re-audit approval alone never revises/),
  ).toBeTruthy();
});

it('explains the first-assessment default only when no finalized or unresolved historical audit exists', async () => {
  fetchMock.mockImplementation(async () =>
    Response.json({
      data: {
        ...fixture,
        auditedBaselines: [],
        upgradeOptions: [],
        hasFinalizedAudit: false,
        requiresOwnerRequest: false,
        effectiveVersion: '0.2.0',
      },
    }),
  );
  mount(true);
  await screen.findByText(/released current catalogue applies by default/);
  expect(screen.queryByRole('button', { name: 'Prepare request with MFA' })).toBeNull();
});

it('withholds a first-audit claim when a historical saved audit needs its basis reviewed', async () => {
  fetchMock.mockImplementation(async () =>
    Response.json({
      data: {
        ...fixture,
        auditedBaselines: [],
        upgradeOptions: [],
        hasFinalizedAudit: false,
        requiresOwnerRequest: false,
        historicalAuditNeedsReview: true,
      },
    }),
  );
  mount(true);
  await screen.findByText('Historical basis needs review');
  expect(screen.queryByText(/released current catalogue applies by default/)).toBeNull();
});

it('binds the owner request to the direct baseline-to-target delta through MFA and refreshes the receipt', async () => {
  let submitted = false;
  fetchMock.mockImplementation(async (url: string) => {
    if (url.endsWith('/challenge'))
      return Response.json({ data: { challengeId, expiresAt: '2026-10-21T02:00:00Z' } });
    if (url.endsWith('/verify')) return Response.json({ data: { verified: true } });
    if (url.endsWith('/submit')) {
      submitted = true;
      return Response.json({
        data: {
          requestId,
          status: 'pending',
          engagementId: null,
          receiptId: '101',
          replayed: false,
        },
      });
    }
    return Response.json({ data: { ...fixture, requests: submitted ? [pending] : [] } });
  });
  mount(true);
  fireEvent.change(await screen.findByLabelText('Re-audit request reason'), {
    target: { value: pending.ownerReason },
  });
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Prepare request with MFA' }));
  fireEvent.change(await screen.findByLabelText('Authenticator code'), {
    target: { value: '123456' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Submit re-audit request' }));
  await screen.findByText(/Re-audit requested. Founder approval is pending. Audit receipt 101/);
  await screen.findByText(/Owner request receipt: 101/);
  const writes = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(writes).toHaveLength(3);
  const payloads = writes.map(([, init]) => JSON.parse(init.body as string));
  expect(payloads[0].request).toMatchObject({
    baselineRunId: baselineRun,
    targetVersion: '0.2.0',
    deltaSha256: 'd'.repeat(64),
    reason: pending.ownerReason,
  });
  expect(payloads[1].request).toEqual(payloads[0].request);
  expect(payloads[2].request).toEqual(payloads[0].request);
  expect(payloads[2]).not.toHaveProperty('code');
  expect(writes[2]![1].headers).toMatchObject({
    'x-tenant-id': tenant,
    'x-expected-actor-id': actor,
    'idempotency-key': payloads[0].request.operationKey,
  });
  expect(screen.queryByRole('link', { name: 'Open approved re-audit assessment' })).toBeNull();
});

it('records the founder decision separately and offers only the newly approved engagement', async () => {
  let approved = false;
  fetchMock.mockImplementation(async (url: string) => {
    if (url.endsWith('/challenge'))
      return Response.json({ data: { challengeId, expiresAt: '2026-10-21T02:00:00Z' } });
    if (url.endsWith('/verify')) return Response.json({ data: { verified: true } });
    if (url.endsWith('/submit')) {
      approved = true;
      return Response.json({
        data: {
          requestId,
          status: 'approved',
          engagementId: newEngagement,
          receiptId: '102',
          replayed: false,
        },
      });
    }
    return Response.json({
      data: {
        ...fixture,
        requests: [
          approved
            ? {
                ...pending,
                status: 'approved',
                decisionReason: 'Continued engagement approved.',
                decisionReceiptId: '102',
                engagementId: newEngagement,
              }
            : pending,
        ],
      },
    });
  });
  mount(false, true);
  fireEvent.click(await screen.findByRole('button', { name: 'Review re-audit approval' }));
  fireEvent.change(screen.getByLabelText('Founder decision reason'), {
    target: { value: 'Continued engagement approved.' },
  });
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Prepare decision with MFA' }));
  fireEvent.change(await screen.findByLabelText('Authenticator code'), {
    target: { value: '123456' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Approve re-audit' }));
  const link = await screen.findByRole('link', { name: 'Open approved re-audit assessment' });
  expect(link.getAttribute('href')).toBe(`/assessment?engagement=${newEngagement}`);
  expect(screen.getByRole('link', { name: 'Inspect saved assessment' }).getAttribute('href')).toBe(
    `/assessment?engagement=${baselineEngagement}`,
  );
  expect(
    screen.getByText(/Owner request receipt: 101 · Founder decision receipt: 102/),
  ).toBeTruthy();
  const writes = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(writes.every(([url]) => String(url).includes('/decision/'))).toBe(true);
  expect(JSON.parse(writes[0]![1].body).request).toMatchObject({ requestId, decision: 'approve' });
  expect(screen.queryByRole('button', { name: 'Review re-audit approval' })).toBeNull();
});

it('does not submit a decision after refused MFA and preserves the failure while rereading requests', async () => {
  fetchMock.mockImplementation(async (url: string) =>
    url.endsWith('/challenge')
      ? Response.json({ data: { challengeId, expiresAt: '2026-10-21T02:00:00Z' } })
      : url.endsWith('/verify')
        ? Response.json({ error: { code: 'mfa_refused' } }, { status: 403 })
        : Response.json({ data: { ...fixture, requests: [pending] } }),
  );
  mount(false, true);
  fireEvent.click(await screen.findByRole('button', { name: 'Review rejection' }));
  fireEvent.change(screen.getByLabelText('Founder decision reason'), {
    target: { value: 'Further scope clarification is required.' },
  });
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Prepare decision with MFA' }));
  fireEvent.change(await screen.findByLabelText('Authenticator code'), {
    target: { value: '123456' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Reject re-audit' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('not confirmed'));
  expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/submit'))).toBe(false);
});

it('selects a released upgrade even when the global first-assessment default is still the old catalogue', async () => {
  fetchMock.mockImplementation(async (url: string) =>
    url.endsWith('/challenge')
      ? Response.json({ data: { challengeId, expiresAt: '2026-10-21T02:00:00Z' } })
      : Response.json({ data: { ...fixture, currentVersion: '0.1.1' } }),
  );
  mount(true);
  expect(
    ((await screen.findByLabelText('Released target catalogue')) as HTMLSelectElement).value,
  ).toBe('0.2.0');
  fireEvent.change(screen.getByLabelText('Re-audit request reason'), {
    target: {
      value: 'Request the released corrected catalogue before changing first-audit defaults.',
    },
  });
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Prepare request with MFA' }));
  await screen.findByLabelText('Authenticator code');
  const sent = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/challenge'));
  expect(JSON.parse(sent![1].body).request).toMatchObject({
    targetVersion: '0.2.0',
    deltaSha256: 'd'.repeat(64),
  });
});

it('keeps an existing pending owner request visible without offering a duplicate request or founder controls', async () => {
  fetchMock.mockImplementation(async () =>
    Response.json({ data: { ...fixture, requests: [pending] } }),
  );
  mount(true);
  await screen.findByText(/already have a request awaiting founder approval/);
  expect(screen.queryByRole('button', { name: 'Prepare request with MFA' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Review re-audit approval' })).toBeNull();
  expect(screen.getByText(/Owner request receipt: 101/)).toBeTruthy();
});
