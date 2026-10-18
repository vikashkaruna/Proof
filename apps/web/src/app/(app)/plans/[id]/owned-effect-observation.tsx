'use client';

import { useState, useSyncExternalStore } from 'react';
import { z } from 'zod';
import {
  OwnedEffectObservationRequestSchema,
  OwnedEffectObservationReceiptSchema,
  type OwnedEffectObservationReceipt,
} from '@axiom/types';
import { formatDateTime } from '@axiom/ui';

const journalSchema = z
  .object({
    tenantId: z.uuid(),
    actorId: z.uuid(),
    request: OwnedEffectObservationRequestSchema,
    receipt: OwnedEffectObservationReceiptSchema.nullable(),
  })
  .strict();
type Journal = z.infer<typeof journalSchema>;
const changed = 'axiom:owned-effect:changed';
function subscribe(onChange: () => void) {
  window.addEventListener('storage', onChange);
  window.addEventListener(changed, onChange);
  return () => {
    window.removeEventListener('storage', onChange);
    window.removeEventListener(changed, onChange);
  };
}
function storageSnapshot(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return '__unavailable__';
  }
}
interface Props {
  tenantId: string;
  actorId: string;
  planId: string;
  actionId: string;
  batchId: string;
}
export function OwnedEffectObservation(props: Props) {
  // Actor/tenant/accepted batch define identity; source releases never discard an intent.
  return (
    <Observation
      key={[props.tenantId, props.actorId, props.planId, props.actionId, props.batchId].join(':')}
      {...props}
    />
  );
}
function Observation({ tenantId, actorId, planId, actionId, batchId }: Props) {
  const key = `axiom:owned-effect:${tenantId}:${actorId}:${planId}:${actionId}:${batchId}`;
  const stored = useSyncExternalStore(
    subscribe,
    () => storageSnapshot(key),
    () => '__server__',
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  function parse(raw: string | null): Journal | null {
    if (!raw) return null;
    if (raw.length > 65536) throw Error('Observation journal exceeds the limit.');
    const j = journalSchema.parse(JSON.parse(raw));
    const r = j.receipt;
    if (
      j.tenantId !== tenantId ||
      j.actorId !== actorId ||
      j.request.planId !== planId ||
      j.request.actionId !== actionId ||
      j.request.batchId !== batchId ||
      (r &&
        (r.tenantId !== tenantId ||
          r.actorId !== actorId ||
          r.planId !== planId ||
          r.actionId !== actionId ||
          r.batchId !== batchId ||
          r.operationKey !== j.request.operationKey))
    )
      throw Error('Observation journal does not match this execution.');
    return j;
  }
  function read() {
    return parse(localStorage.getItem(key));
  }
  let journal: Journal | null = null;
  let ready = false;
  let storageError = '';
  if (stored !== '__server__') {
    try {
      journal = parse(stored);
      ready = true;
    } catch {
      storageError =
        'The original observation could not be read. Preserve browser storage and contact your administrator.';
    }
  }
  function save(j: Journal) {
    const raw = JSON.stringify(journalSchema.parse(j));
    localStorage.setItem(key, raw);
    if (localStorage.getItem(key) !== raw)
      throw Error('Observation journal could not be retained.');
    window.dispatchEvent(new Event(changed));
  }
  async function observe(fresh: boolean) {
    if (busy || !ready) return;
    setBusy(true);
    setMessage('');
    try {
      if (!navigator.locks?.request) throw Error('Cross-tab coordination is unavailable.');
      await navigator.locks.request(key, async () => {
        let j = read();
        if (j?.receipt && !fresh) {
          window.dispatchEvent(new Event(changed));
          return;
        }
        if (!j || (fresh && j.receipt)) {
          j = {
            tenantId,
            actorId,
            request: { operationKey: crypto.randomUUID(), planId, actionId, batchId },
            receipt: null,
          };
          save(j); // A transport call never precedes durable intent storage.
        }
        const response = await fetch('/api/bff/v1/plans/owned-synthetic/observe-effect', {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          signal: AbortSignal.timeout(30000),
          headers: {
            'Content-Type': 'application/json',
            'X-Tenant-Id': tenantId,
            'X-Expected-Actor-Id': actorId,
            'Idempotency-Key': j.request.operationKey,
          },
          body: JSON.stringify(j.request),
        });
        if (!response.ok || !response.body) throw Error('Observation source is unavailable.');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let raw = '';
        let bytes = 0;
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > 32768) throw Error('Observation response is too large.');
            raw += decoder.decode(part.value, { stream: true });
          }
          raw += decoder.decode();
        } finally {
          await reader.cancel().catch(() => {});
        }
        const receipt = OwnedEffectObservationReceiptSchema.parse(JSON.parse(raw));
        if (
          receipt.tenantId !== tenantId ||
          receipt.actorId !== actorId ||
          receipt.planId !== planId ||
          receipt.actionId !== actionId ||
          receipt.batchId !== batchId ||
          receipt.operationKey !== j.request.operationKey
        )
          throw Error('Observation source changed.');
        save({ ...j, receipt });
      });
    } catch {
      setMessage(
        'Outcome unconfirmed. The original observation key is retained. Recover that observation after checking your session and MFA; no target change or automatic retry is requested.',
      );
    } finally {
      setBusy(false);
    }
  }
  const receipt = journal?.receipt;
  return (
    <section
      className="rounded-lg border border-slate-200 bg-mist-50 p-4"
      aria-label="Owned synthetic execution readback"
    >
      <h3 className="font-medium text-indigo-700">Check what the synthetic target recorded</h3>
      <p className="mt-1 text-sm text-slate-600">
        Use this when an execution reply was lost. This records a readback receipt without changing
        the target, retrying execution or changing its original status.
      </p>
      {receipt && <ObservationResult receipt={receipt} />}
      {(storageError || message) && (
        <p role="alert" className="mt-2 text-sm text-ember-700">
          {storageError || message}
        </p>
      )}
      <button
        type="button"
        disabled={!ready || busy}
        onClick={() => void observe(Boolean(receipt))}
        className="mt-3 rounded-md border border-teal-600 px-3 py-2 text-sm font-medium text-teal-800 disabled:opacity-50"
      >
        {busy
          ? 'Checking original operation…'
          : receipt
            ? 'Record a fresh observation'
            : journal
              ? 'Recover original observation'
              : 'Record target readback'}
      </button>
    </section>
  );
}
function ObservationResult({ receipt }: { receipt: OwnedEffectObservationReceipt }) {
  const o = receipt.observation;
  const label =
    o.outcome === 'unknown'
      ? 'Still unknown: no matching operation was recorded at this observation.'
      : o.outcome === 'rollback_committed'
        ? 'The target recorded the rollback.'
        : 'The target recorded the forward change.';
  return (
    <div className="mt-3 text-sm">
      <p className="font-medium text-indigo-700">{label}</p>
      {o.outcome === 'unknown' && (
        <p className="mt-1 text-slate-600">
          Absence is not proof that nothing happened. Do not retry this execution. Review its
          current approval and worker state before deciding what to do next.
        </p>
      )}
      {o.currentMatchesLastCommit === false && (
        <p className="mt-1 text-ember-700">
          The current version differs from the last committed operation. Review the intervening
          change before taking action.
        </p>
      )}
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt>Current synthetic setting</dt>
        <dd>
          {o.current.audit_log_enabled ? 'Enabled' : 'Disabled'} · version {o.current.version}
        </dd>
        <dt>Original action / batch</dt>
        <dd>
          {o.recordedActionStatus} / {o.recordedBatchStatus}
        </dd>
        <dt>Observed</dt>
        <dd>{formatDateTime(o.observedAt)}</dd>
        <dt>Audit receipt</dt>
        <dd>{receipt.ledgerReceipt}</dd>
        <dt>Original approval</dt>
        <dd>
          {o.approvalRevoked
            ? 'Revoked'
            : o.approvalExpired
              ? 'Expired'
              : 'Recorded; new changes still need approval'}
        </dd>
      </dl>
      <p className="mt-2 text-xs text-slate-600">
        This observation grants no retry or rollback authority and does not close a finding.
      </p>
    </div>
  );
}
