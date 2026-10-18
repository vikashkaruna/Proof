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
