// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { sha256 } from '@axiom/ledger';
import { ownedDeploymentOperationCanonicalJSON, ownedDeploymentFence } from '@axiom/types';
import { z } from 'zod';
import { OwnedDeploymentClient } from './owned-deployment-client';
import {
  deploymentJournal,
  deploymentJournalKey,
  retainDeploymentJournal,
  readDeploymentJournal,
} from './deployment-journal';
const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  actorId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  requestId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  operationKey = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  challengeId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const decision = {
  operationKey,
  expectedManifestSha256: 'a'.repeat(64),
  expectedPreflightSha256: 'b'.repeat(64),
  expectedRollbackSha256: 'c'.repeat(64),
  reason: 'Approve only this reviewed owned synthetic setup',
  acknowledgeOwnedSynthetic: true,
} as const;
const original = deploymentJournal.parse({
  version: 1,
  tenantId,
  actorId,
  requestId,
  intent: { phase: 'verify', request: decision, challengeId },
});
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('navigator', {
    locks: {
      request: async (_name: string, _options: unknown, work: () => Promise<unknown>) => work(),
    },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it.each(['challenge', 'request'] as const)(
  'retires an expired %s through an exact server fence, recovering its lost reply after reload without starting replacement work',
  async (phase) => {
    const source = deploymentJournal.parse({
      ...original,
      requestId: phase === 'request' ? operationKey : requestId,
      intent:
        phase === 'challenge'
          ? { phase, request: decision }
          : {
              phase,
              request: {
                operationKey,
                engagementId: requestId,
                connectorId: challengeId,
                manifestSha256: 'a'.repeat(64),
                reason: decision.reason,
                acknowledgeOwnedSynthetic: true,
              },
            },
    });
    retainDeploymentJournal(localStorage, source);
    let fence: z.infer<typeof ownedDeploymentFence> | null = null;
    let postCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, options: RequestInit) => {
        if (options.method === 'POST') {
          expect(url.endsWith('/fence-intent')).toBe(true);
          fence = ownedDeploymentFence.parse(JSON.parse(String(options.body)));
          postCount++;
          throw Error('Lost reply after atomic retirement');
        }
        if (!url.includes('/operations/')) return Response.json({ data: [] });
        const isFence = url.includes('/operations/fence/');
        const intent = isFence && fence ? { phase: 'fence', request: fence } : source.intent;
        const key = isFence ? url.split('/').at(-1)! : operationKey;
        const recorded = isFence ? fence !== null : phase === 'challenge';
        const retirement = fence
          ? {
              requestId: source.requestId,
              tenantId,
              actorId,
              operationKey: fence.operationKey,
              target: fence.target,
              disposition: 'fenced_no_mutation',
              previousState: phase === 'challenge' ? 'expired_decision' : 'not_recorded',
              requiresPreflight: true,
              fenceReceiptId: '901',
            }
          : null;
        return Response.json({
          data: {
            requestId: source.requestId,
            tenantId,
            actorId,
            operationKey: key,
            phase: isFence ? 'fence' : phase,
            outcome: recorded ? 'recorded' : 'not_recorded',
            canonicalRequestHash: recorded
              ? await sha256(
                  ownedDeploymentOperationCanonicalJSON({
                    tenantId,
                    actorId,
                    requestId: source.requestId,
                    operationKey: key,
                    intent,
                  }),
                )
              : null,
            intent: recorded ? intent : null,
            receiptId: recorded ? (isFence ? '901' : '900') : null,
            result: null,
            phaseResult: !recorded
              ? null
              : isFence
                ? { phase: 'fence', receipt: retirement }
                : {
                    phase: 'challenge',
                    challenge: { challengeId, expiresAt: '2020-01-01T00:00:00Z', maxAttempts: 3 },
                  },
          },
        });
      }),
    );
    const props = { tenantId, actorId, founder: true, engagements: [] };
    const first = render(<OwnedDeploymentClient {...props} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Check original step' }));
    if (phase === 'challenge') await screen.findByRole('alert');
    else await screen.findByRole('status');
    fireEvent.click(
      screen.getByLabelText(
        'I want to retire this exact step after the server confirms no mutating effect and blocks late retries.',
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Check and retire the original step' }));
    await waitFor(() => expect(postCount).toBe(1));
    await screen.findByRole('alert');
    expect(readDeploymentJournal(localStorage, tenantId, actorId)?.intent.phase).toBe('fence');
    first.unmount();
    render(<OwnedDeploymentClient {...props} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Check original step' }));
    await waitFor(() => expect(readDeploymentJournal(localStorage, tenantId, actorId)).toBeNull());
    expect(postCount).toBe(1);
    expect(screen.getByRole('status').textContent).toContain(
      'No replacement approval or target change was made',
    );
    expect(Object.keys(localStorage).some((key) => key.includes(':fence-source:'))).toBe(true);
  },
);
it('recovers a verification committed before a lost reply after reload, then approves once with the same frozen decision and no persisted code', async () => {
  retainDeploymentJournal(localStorage, original);
  const posts: { path: string; body: unknown }[] = [];
  let verified = false,
    approved = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: RequestInit) => {
      if (options.method === 'POST') {
        const body = JSON.parse(String(options.body)) as unknown;
        posts.push({ path: url, body });
        if (url.endsWith('/verify')) {
          verified = true;
          throw Error('Connection lost after verification');
        }
        if (url.endsWith('/approve')) approved = true;
        return Response.json({ data: null });
      }
      if (!url.includes('/operations/')) return Response.json({ data: [] });
      const phase = url.includes('/operations/approve/') ? 'approve' : 'verify';
      const intent = { ...original.intent, phase };
      const recorded = phase === 'verify' ? verified : approved;
      return Response.json({
        data: {
          tenantId,
          actorId,
          requestId,
          operationKey,
          phase,
          outcome: recorded ? 'recorded' : 'not_recorded',
          canonicalRequestHash: recorded
            ? await sha256(
                ownedDeploymentOperationCanonicalJSON({
                  tenantId,
                  actorId,
                  requestId,
                  operationKey,
                  intent,
                }),
              )
            : null,
          intent: recorded ? intent : null,
          receiptId: recorded ? (phase === 'verify' ? '123' : '124') : null,
          result: null,
          phaseResult: recorded && phase === 'verify' ? { phase: 'verify', verified: true } : null,
        },
      });
    }),
  );
  const props = { tenantId, actorId, founder: true, engagements: [] };
  const first = render(<OwnedDeploymentClient {...props} />);
  fireEvent.change(await screen.findByLabelText('Authenticator or recovery code'), {
    target: { value: '482901' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Verify code for this setup' }));
  await screen.findByRole('alert');
  expect(posts).toHaveLength(1);
  expect(JSON.stringify(readDeploymentJournal(localStorage, tenantId, actorId))).not.toContain(
    '482901',
  );
  first.unmount();
  render(<OwnedDeploymentClient {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Check original step' }));
  await screen.findByRole('button', { name: 'Approve this reviewed setup' });
  expect(posts).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Approve this reviewed setup' }));
  await waitFor(() =>
    expect(localStorage.getItem(deploymentJournalKey(tenantId, actorId))).toBeNull(),
  );
  expect(posts).toHaveLength(2);
  expect(posts[1]?.body).toEqual({ request: decision, challengeId });
  expect(screen.getByRole('status').textContent).toContain('Receipt 124');
});
it('preserves an unresolved operation and refuses to send when scoped readback is unavailable', async () => {
  retainDeploymentJournal(localStorage, original);
  const fetcher = vi.fn(async (_url: string, options: RequestInit) => {
    if (options.method === 'POST') throw Error('A write must not be attempted');
    return Response.json({ error: 'Unavailable' }, { status: 503 });
  });
  vi.stubGlobal('fetch', fetcher);
  render(<OwnedDeploymentClient tenantId={tenantId} actorId={actorId} founder engagements={[]} />);
  fireEvent.change(await screen.findByLabelText('Authenticator or recovery code'), {
    target: { value: '482901' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Verify code for this setup' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Keep the original'));
  expect(fetcher.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true);
  expect(readDeploymentJournal(localStorage, tenantId, actorId)).toEqual(original);
});

it.each(['revoke_verify', 'revoke'] as const)(
  'recovers a lost %s reply without replacing its exact stop request or repeating completed work',
  async (lostPhase) => {
    const request = {
      operationKey,
      expectedManifestSha256: 'a'.repeat(64),
      expectedApprovalId: requestId,
      reason: 'Stop this exact synthetic enrollment authority',
      acknowledgeOwnedSynthetic: true,
    } as const;
    const start = deploymentJournal.parse({
      ...original,
      intent: { phase: lostPhase, request, challengeId },
    });
    retainDeploymentJournal(localStorage, start);
    const recorded = new Set<string>();
    const posts: { path: string; body: unknown }[] = [];
    let dropReply = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, options: RequestInit) => {
        if (options.method === 'POST') {
          const phase = url.endsWith('/revoke-verify') ? 'revoke_verify' : 'revoke';
          expect(url.endsWith('/revoke-verify') || url.endsWith('/revoke')).toBe(true);
          const body: unknown = JSON.parse(String(options.body));
          posts.push({ path: url, body });
          expect(readDeploymentJournal(localStorage, tenantId, actorId)?.intent.request).toEqual(
            request,
          );
          recorded.add(phase);
          if (dropReply) {
            dropReply = false;
            throw Error('Lost committed stop reply');
          }
          return Response.json({ data: null });
        }
        if (!url.includes('/operations/')) return Response.json({ data: [] });
        const phase = url.includes('/operations/revoke_verify/') ? 'revoke_verify' : 'revoke';
        const intent = { phase, request, challengeId };
        const saved = recorded.has(phase);
        return Response.json({
          data: {
            tenantId,
            actorId,
            requestId,
            operationKey,
            phase,
            outcome: saved ? 'recorded' : 'not_recorded',
            canonicalRequestHash: saved
              ? await sha256(
                  ownedDeploymentOperationCanonicalJSON({
                    tenantId,
                    actorId,
                    requestId,
                    operationKey,
                    intent,
                  }),
                )
              : null,
            intent: saved ? intent : null,
            receiptId: saved ? (phase === 'revoke_verify' ? '501' : '502') : null,
            result: null,
            phaseResult: saved && phase === 'revoke_verify' ? { phase, verified: true } : null,
          },
        });
      }),
    );
    const props = { tenantId, actorId, founder: false, engagements: [] };
    const first = render(<OwnedDeploymentClient {...props} />);
    if (lostPhase === 'revoke_verify') {
      fireEvent.change(await screen.findByLabelText('Authenticator or recovery code'), {
        target: { value: '482901' },
      });
    }
    fireEvent.click(
      await screen.findByRole('button', {
        name:
          lostPhase === 'revoke_verify'
            ? 'Verify code for this stop request'
            : 'Revoke this setup authority',
      }),
    );
    await screen.findByRole('alert');
    expect(posts).toHaveLength(1);
    expect(JSON.stringify(readDeploymentJournal(localStorage, tenantId, actorId))).not.toContain(
      '482901',
    );
    first.unmount();
    render(<OwnedDeploymentClient {...props} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Check original step' }));
    if (lostPhase === 'revoke_verify') {
      await screen.findByRole('button', { name: 'Revoke this setup authority' });
      expect(posts).toHaveLength(1);
      fireEvent.click(screen.getByRole('button', { name: 'Revoke this setup authority' }));
    }
    await waitFor(() => expect(readDeploymentJournal(localStorage, tenantId, actorId)).toBeNull());
    expect(posts).toHaveLength(lostPhase === 'revoke_verify' ? 2 : 1);
    expect(posts.at(-1)?.body).toEqual({ request, challengeId });
    expect(screen.getByRole('status').textContent).toContain('Setup authority revoked');
  },
);

it('lets a current non-founder prepare a separate stop for an expired approval and recover a lost challenge', async () => {
  const row = {
    requestId,
    tenantId,
    actorId,
    engagementId: requestId,
    connectorId: requestId,
    state: 'expired',
    manifestSha256: 'a'.repeat(64),
    environment: 'local',
    label: 'Owned synthetic audit configuration',
    scope: 'owned_synthetic_config.audit_log_enable',
    fixtureId: requestId,
    resourceId: requestId,
    bindingId: requestId,
    custodyPolicyId: requestId,
    custodyEpoch: 1,
    requestedAt: '2020-01-01T00:00:00Z',
    expiresAt: '2020-01-02T00:00:00Z',
    reason: 'Original approved synthetic demonstration request',
    preflight: null,
    approval: {
      approvalId: requestId,
      approvedBy: actorId,
      approvedAt: '2020-01-01T00:00:00Z',
      expiresAt: '2020-01-02T00:00:00Z',
      receiptId: '601',
    },
    installation: null,
    limitations: ['Synthetic local configuration only'],
  };
  let saved = false;
  const posts: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: RequestInit) => {
      if (options.method === 'POST') {
        expect(url.endsWith('/revoke-challenge')).toBe(true);
        posts.push(JSON.parse(String(options.body)) as unknown);
        saved = true;
        throw Error('Lost challenge reply');
      }
      if (!url.includes('/operations/')) return Response.json({ data: [row] });
      const intent = readDeploymentJournal(localStorage, tenantId, actorId)!.intent;
      return Response.json({
        data: {
          tenantId,
          actorId,
          requestId,
          operationKey: intent.request.operationKey,
          phase: 'revoke_challenge',
          outcome: saved ? 'recorded' : 'not_recorded',
          canonicalRequestHash: saved
            ? await sha256(
                ownedDeploymentOperationCanonicalJSON({
                  tenantId,
                  actorId,
                  requestId,
                  operationKey: intent.request.operationKey,
                  intent,
                }),
              )
            : null,
          intent: saved ? intent : null,
          receiptId: saved ? '602' : null,
          result: null,
          phaseResult: saved
            ? {
                phase: 'revoke_challenge',
                challenge: { challengeId, expiresAt: '2099-01-01T00:00:00Z', maxAttempts: 3 },
              }
            : null,
        },
      });
    }),
  );
  const props = { tenantId, actorId, founder: false, engagements: [] };
  const first = render(<OwnedDeploymentClient {...props} />);
  await screen.findByRole('option', { name: /Setup authority expired/ });
  fireEvent.change(screen.getByLabelText('Setup request'), { target: { value: requestId } });
  expect(screen.queryByRole('button', { name: 'Install the approved setup' })).toBeNull();
  fireEvent.change(screen.getByLabelText('Reason for stopping this setup'), {
    target: { value: 'Revoke the exact expired synthetic setup authority' },
  });
  fireEvent.click(
    screen.getByLabelText(
      'I reviewed this exact enrollment and want to revoke its setup authority. This does not undo its target setting.',
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Prepare stop request' }));
  await screen.findByRole('alert');
  expect(posts).toHaveLength(1);
  const retained = readDeploymentJournal(localStorage, tenantId, actorId)!;
  expect(retained.intent.phase).toBe('revoke_challenge');
  expect(retained.intent.request).toMatchObject({
    expectedApprovalId: requestId,
    expectedManifestSha256: row.manifestSha256,
  });
  first.unmount();
  render(<OwnedDeploymentClient {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Check original step' }));
  await screen.findByRole('button', { name: 'Verify code for this stop request' });
  expect(posts).toHaveLength(1);
  expect(readDeploymentJournal(localStorage, tenantId, actorId)?.intent.request).toEqual(
    retained.intent.request,
  );
});
