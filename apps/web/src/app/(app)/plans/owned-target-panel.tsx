'use client';
import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { z } from 'zod';
import {
  OWNED_REQUEST_CHANGED,
  archiveConfirmedOwnedRequest,
  ownedJournalSchema,
  ownedRequestJournalKey,
  readOwnedRequestJournal,
  recoverOwnedOriginalOutcome,
  retainOwnedCancellation,
  retainOwnedRequestJournal,
  submitOwnedCancellation,
  submitOwnedOriginal,
  withOwnedRequestLock,
  type OwnedRequestJournal,
  type ConfirmedOwnedOutcome,
} from './owned-target-request';
const options = z
  .object({
    tenantId: z.uuid(),
    actorId: z.uuid(),
    engagementId: z.uuid(),
    targets: z
      .array(
        z
          .object({
            bindingId: z.uuid(),
            engagementId: z.uuid(),
            label: z.literal('Owned synthetic audit configuration'),
            scope: z.literal('owned_synthetic_config.audit_log_enable'),
            auditLogEnabled: z.boolean(),
            currentVersion: z
              .number()
              .int()
              .nonnegative()
              .max(Number.MAX_SAFE_INTEGER - 2),
            snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();
export interface OwnedTargetPanelProps {
  tenantId: string;
  actorId: string;
  canCreate: boolean;
  engagements: { id: string; title: string }[];
}
export function OwnedTargetPanel(props: OwnedTargetPanelProps) {
  return <Panel key={`${props.tenantId}:${props.actorId}:${props.canCreate}`} {...props} />;
}
function Panel({ tenantId, actorId, canCreate, engagements }: OwnedTargetPanelProps) {
  const [engagement, setEngagement] = useState(''),
    [targets, setTargets] = useState<z.infer<typeof options>['targets']>([]),
    [loaded, setLoaded] = useState(false),
    [binding, setBinding] = useState(''),
    [reason, setReason] = useState(''),
    [ack, setAck] = useState(false),
    [stopReason, setStopReason] = useState(''),
    [stopAck, setStopAck] = useState(false),
    [retained, setRetained] = useState<OwnedRequestJournal | null>(null),
    [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [confirmed, setConfirmed] = useState<ConfirmedOwnedOutcome | null>(null);
  const mounted = useRef(true),
    active = useRef(false),
    confirmedJournal = useRef<OwnedRequestJournal | null>(null);
  const key = ownedRequestJournalKey(tenantId, actorId);
  useEffect(() => {
    mounted.current = true;
    const refresh = () => {
      try {
        const value = readOwnedRequestJournal(localStorage, tenantId, actorId);
        setRetained(value);
        setReady(true);
        if (
          confirmedJournal.current &&
          JSON.stringify(value) !== JSON.stringify(confirmedJournal.current)
        ) {
          confirmedJournal.current = null;
          setConfirmed(null);
        }
      } catch {
        setReady(false);
        setError('The original browser request is unreadable. Preserve it for review.');
      }
    };
    const storage = (event: StorageEvent) => {
      if (event.key === null || event.key === key) refresh();
    };
    refresh();
    window.addEventListener('storage', storage);
    window.addEventListener(OWNED_REQUEST_CHANGED, refresh);
    return () => {
      mounted.current = false;
      window.removeEventListener('storage', storage);
      window.removeEventListener(OWNED_REQUEST_CHANGED, refresh);
    };
  }, [actorId, tenantId, key]);
  async function request(path: string, body?: unknown, idempotencyKey?: string) {
    const response = await fetch(`/api/bff/v1/plans/owned-synthetic${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      cache: 'no-store',
      signal: AbortSignal.timeout(30000),
      headers: {
        'X-Tenant-Id': tenantId,
        'X-Expected-Actor-Id': actorId,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok)
      throw Error('The source outcome is unconfirmed. Keep the original browser request.');
    return response.json() as Promise<unknown>;
  }
  async function loadTargets() {
    if (!engagement || active.current || retained) return;
    active.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = options.parse(await request(`/targets/${engagement}`));
      if (
        result.tenantId !== tenantId ||
        result.actorId !== actorId ||
        result.engagementId !== engagement ||
        result.targets.some((t) => t.engagementId !== engagement)
      )
        throw Error('Source identity changed');
      if (mounted.current) {
        setTargets(result.targets);
        setLoaded(true);
        setBinding('');
      }
    } catch {
      if (mounted.current)
        setError('Registered owned targets are unavailable. No target can be selected.');
    } finally {
      active.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function act(kind: 'save' | 'stop' | 'recover') {
    if (active.current || !ready || !canCreate) return;
    active.current = true;
    setBusy(true);
    setError(null);
    try {
      await withOwnedRequestLock(tenantId, actorId, async () => {
        let original = readOwnedRequestJournal(localStorage, tenantId, actorId);
        if (!original) {
          if (kind !== 'save') throw Error('No original request is retained');
          const target = targets.find((t) => t.bindingId === binding);
          if (!target || target.auditLogEnabled || !ack)
            throw Error('Select and acknowledge the owned target first');
          original = retainOwnedRequestJournal(
            localStorage,
            ownedJournalSchema.parse({
              version: 1,
              tenantId,
              actorId,
              request: {
                operationKey: crypto.randomUUID(),
                bindingId: target.bindingId,
                engagementId: target.engagementId,
                expectedSnapshotHash: target.snapshotHash,
                reason,
                acknowledgeOwnedSynthetic: true,
                actionType: 'config.audit_log_enable',
                desiredEnabled: true,
              },
            }),
          );
        }
        let result: ConfirmedOwnedOutcome;
        if (kind === 'stop') {
          if (!original.cancellation) {
            if (!stopAck) throw Error('Confirm stopping the unrecorded request first');
            original = retainOwnedCancellation(localStorage, original, {
              cancellationKey: crypto.randomUUID(),
              reason: stopReason,
            });
          }
          result = await submitOwnedCancellation(localStorage, original, (body) =>
            request('/cancel', body, body.cancellationKey),
          );
        } else if (kind === 'recover')
          result = await recoverOwnedOriginalOutcome(localStorage, original, (body) =>
            request('/outcome', body, body.operationKey),
          );
        else
          result = await submitOwnedOriginal(localStorage, original, (body) =>
            request('', body, body.operationKey),
          );
        if (
          JSON.stringify(readOwnedRequestJournal(localStorage, tenantId, actorId)) !==
          JSON.stringify(original)
        )
          throw Error('The retained original changed during the response');
        if (mounted.current) {
          confirmedJournal.current = original;
          setConfirmed(result);
          setRetained(original);
        }
      });
    } catch {
      if (mounted.current)
        setError(
          'The outcome is unconfirmed. Keep this original request; recover its outcome or retry its exact operation.',
        );
    } finally {
      active.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function archive() {
    if (!confirmed || !confirmedJournal.current || active.current) return;
    active.current = true;
    setBusy(true);
    try {
      await withOwnedRequestLock(tenantId, actorId, async () => {
        archiveConfirmedOwnedRequest(localStorage, confirmedJournal.current!, confirmed);
      });
      if (mounted.current) {
        confirmedJournal.current = null;
        setConfirmed(null);
        setReason('');
        setAck(false);
        setStopReason('');
        setStopAck(false);
        setTargets([]);
        setLoaded(false);
        setBinding('');
      }
    } catch {
      if (mounted.current)
        setError('The confirmed source changed. The original request was preserved.');
    } finally {
      active.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  if (!canCreate) return null;
  return (
    <section
      className="rounded-xl border border-slate-200 bg-white p-4 space-y-4"
      aria-labelledby="owned-target-title"
      aria-busy={busy}
    >
      <div>
        <h2 id="owned-target-title" className="font-semibold text-[#1E2A4A]">
          Owned synthetic configuration plan
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          Measure audit-log enablement on a registered owned test target. Measurement makes no
          target writes. Creating the review plan requires separate human approval before any
          execution.
        </p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      {!ready && <p role="status">Checking the original browser request…</p>}
      {retained ? (
        <div className="space-y-3">
          <p className="text-sm">
            Original request: <code>{retained.request.operationKey}</code>
          </p>
          <p className="text-sm">{retained.request.reason}</p>
          <p className="text-xs text-slate-600">
            Binding {retained.request.bindingId} · Snapshot {retained.request.expectedSnapshotHash}
          </p>
          {confirmed ? (
            <div role="status" className="space-y-3">
              <p>
                {confirmed.kind === 'recorded'
                  ? 'Review plan recorded; execution remains awaiting approval.'
                  : 'Original unrecorded request stopped.'}{' '}
                Human receipt {confirmed.receipt.humanReceipt}.
              </p>
              {confirmed.kind === 'recorded' && (
                <Link href={`/plans/${confirmed.receipt.planId}`} className="underline">
                  Inspect the recorded plan
                </Link>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={() => void archive()}
                className="rounded-md border px-3 py-2 focus-visible:outline-2 focus-visible:outline-teal-500"
              >
                Archive confirmed browser reference
              </button>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy || !ready}
                  onClick={() => void act('recover')}
                  className="rounded-md border px-3 py-2 focus-visible:outline-2 focus-visible:outline-teal-500"
                >
                  Recover original outcome
                </button>
                {!retained.cancellation && (
                  <button
                    type="button"
                    disabled={busy || !ready}
                    onClick={() => void act('save')}
                    className="rounded-md border px-3 py-2 focus-visible:outline-2 focus-visible:outline-teal-500"
                  >
                    Retry original save
                  </button>
                )}
              </div>
              {retained.cancellation ? (
                <>
                  <p className="text-sm">Original stop: {retained.cancellation.reason}</p>
                  <button
                    type="button"
                    disabled={busy || !ready}
                    onClick={() => void act('stop')}
                    className="rounded-md border px-3 py-2 focus-visible:outline-2 focus-visible:outline-teal-500"
                  >
                    Retry original stop
                  </button>
                </>
              ) : (
                <div className="space-y-2">
                  <label className="block text-sm" htmlFor="owned-stop-reason">
                    Reason to stop this unrecorded request
                  </label>
                  <textarea
                    id="owned-stop-reason"
                    value={stopReason}
                    disabled={busy}
                    maxLength={2000}
                    onChange={(e) => setStopReason(e.target.value)}
                    className="w-full rounded-md border p-2 focus-visible:outline-2 focus-visible:outline-teal-500"
                  />
                  <label className="flex gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={stopAck}
                      disabled={busy}
                      onChange={(e) => setStopAck(e.target.checked)}
                    />
                    Stop only the unrecorded request; preserve any existing plan.
                  </label>
                  <button
                    type="button"
                    disabled={busy || !stopAck || stopReason.trim().length < 20}
                    onClick={() => void act('stop')}
                    className="rounded-md border px-3 py-2 focus-visible:outline-2 focus-visible:outline-teal-500"
                  >
                    Stop pending request
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <label className="block text-sm" htmlFor="owned-engagement">
            Engagement
          </label>
          <select
            id="owned-engagement"
            value={engagement}
            disabled={!ready || busy}
            onChange={(e) => {
              setEngagement(e.target.value);
              setTargets([]);
              setLoaded(false);
              setBinding('');
            }}
            className="w-full rounded-md border p-2 focus-visible:outline-2 focus-visible:outline-teal-500"
          >
            <option value="">Choose an engagement</option>
            {engagements.map((e) => (
              <option key={e.id} value={e.id}>
                {e.title}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!ready || busy || !engagement}
            onClick={() => void loadTargets()}
            className="rounded-md border px-3 py-2 focus-visible:outline-2 focus-visible:outline-teal-500"
          >
            Load registered targets
          </button>
          {targets.length > 0 && (
            <>
              <label className="block text-sm" htmlFor="owned-binding">
                Owned target
              </label>
              <select
                id="owned-binding"
                value={binding}
                disabled={busy}
                onChange={(e) => setBinding(e.target.value)}
                className="w-full rounded-md border p-2 focus-visible:outline-2 focus-visible:outline-teal-500"
              >
                <option value="">Choose a target</option>
                {targets.map((t) => (
                  <option key={t.bindingId} value={t.bindingId} disabled={t.auditLogEnabled}>
                    {t.label} · version {t.currentVersion}
                    {t.auditLogEnabled ? ' · already enabled' : ''}
                  </option>
                ))}
              </select>
              <label className="block text-sm" htmlFor="owned-plan-reason">
                Reason for this new human plan
              </label>
              <textarea
                id="owned-plan-reason"
                value={reason}
                disabled={busy}
                maxLength={2000}
                onChange={(e) => setReason(e.target.value)}
                className="w-full rounded-md border p-2 focus-visible:outline-2 focus-visible:outline-teal-500"
              />
              <label className="flex gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={ack}
                  disabled={busy}
                  onChange={(e) => setAck(e.target.checked)}
                />
                This is the registered owned synthetic target.
              </label>
              <button
                type="button"
                disabled={!ready || busy || !binding || !ack || reason.trim().length < 20}
                onClick={() => void act('save')}
                className="rounded-md bg-[#1E2A4A] text-white px-3 py-2 focus-visible:outline-2 focus-visible:outline-teal-500"
              >
                Measure and create review plan
              </button>
            </>
          )}
          {engagement && targets.length === 0 && (
            <p className="text-sm text-slate-600">
              {loaded
                ? 'No registered owned targets are available for this engagement.'
                : 'Load registered targets for this engagement.'}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
