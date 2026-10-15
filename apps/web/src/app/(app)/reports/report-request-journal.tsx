'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { canonicalJson } from '@axiom/ledger';
import { prepareReportOperationKey, reportRequest } from './report-request';
import { failure } from './report-ui';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const bodySchema = z
  .object({
    engagementId: uuid,
    assessmentRunId: uuid,
    title: z.string().trim().min(1).max(300),
    operationKey: uuid,
  })
  .strict();
const operationSchema = z
  .object({
    version: z.literal(1),
    tenantId: uuid,
    actorId: uuid,
    kind: z.enum(['board', 'auditor']),
    body: bodySchema,
  })
  .strict();
export type ReportRequestOperation = z.infer<typeof operationSchema>;
type Body = ReportRequestOperation['body'];
const receiptSchema = z
  .object({
    requestId: uuid,
    status: z.enum(['requested', 'drafted', 'reviewed', 'released', 'rejected']),
    reportId: uuid.nullable(),
    replayed: z.boolean(),
  })
  .strict();
type Receipt = z.infer<typeof receiptSchema>;
const prefix = (tenantId: string, actorId: string) =>
  `axiom.report-request.operation.v1:${uuid.parse(tenantId)}:${uuid.parse(actorId)}:`;
const key = (value: ReportRequestOperation) =>
  prefix(value.tenantId, value.actorId) + value.kind + ':' + value.body.operationKey;
/** Immutable per-operation entries do not overwrite another tab's unresolved request.
 * Enumeration/readback is fail-closed, not an atomic mutex without Web Locks. */
export function readReportRequests(
  storage: Storage,
  tenantId: string,
  actorId: string,
): ReportRequestOperation[] {
  const start = prefix(tenantId, actorId),
    entries: ReportRequestOperation[] = [];
  if (storage.length > 10000)
    throw Error('Browser report request storage cannot be inspected safely.');
  for (let i = 0; i < storage.length; i++) {
    const name = storage.key(i);
    if (!name?.startsWith(start)) continue;
    const raw = storage.getItem(name);
    if (raw === null) continue;
    if (new TextEncoder().encode(raw).byteLength > 8192)
      throw Error('Retained report request exceeds supported bounds.');
    const value = operationSchema.parse(JSON.parse(raw));
    if (key(value) !== name || canonicalJson(value) !== raw)
      throw Error('Retained report request does not match its actor, tenant or exact content.');
    entries.push(value);
    if (entries.length > 128) throw Error('Reconcile retained report requests before continuing.');
  }
  return entries;
}
export function retainReportRequest(storage: Storage, raw: ReportRequestOperation) {
  const value = operationSchema.parse(raw);
  if (readReportRequests(storage, value.tenantId, value.actorId).length)
    throw Error('Resolve the retained report request before starting another.');
  const name = key(value),
    text = canonicalJson(value);
  if (storage.getItem(name) !== null)
    throw Error('Another report request owns this operation key.');
  storage.setItem(name, text);
  if (storage.getItem(name) !== text)
    throw Error('Report request could not be retained. Nothing was sent.');
  const entries = readReportRequests(storage, value.tenantId, value.actorId);
  if (entries.length !== 1 || canonicalJson(entries[0]) !== text)
    throw Error('Concurrent report requests are retained. Reconcile them before sending.');
  return value;
}
export function assertReportRequest(storage: Storage, value: ReportRequestOperation) {
  readReportRequests(storage, value.tenantId, value.actorId);
  if (storage.getItem(key(value)) !== canonicalJson(value))
    throw Error('Retained report request changed. Reload before continuing.');
}
export function clearConfirmedReportRequest(storage: Storage, value: ReportRequestOperation) {
  assertReportRequest(storage, value);
  storage.removeItem(key(value));
  if (storage.getItem(key(value)) !== null)
    throw Error('The confirmed report request could not be cleared from this browser.');
}
export function useReportRequestRecovery(options: {
  tenantId: string;
  actorId?: string;
  kind: ReportRequestOperation['kind'];
  canRequest: boolean;
  onConfirmed: () => void;
}) {
  const { tenantId, actorId, kind, canRequest } = options;
  const [entries, setEntries] = useState<ReportRequestOperation[]>([]),
    [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [confirmed, setConfirmed] = useState<{
    operation: ReportRequestOperation;
    receipt: Receipt;
  } | null>(null);
  const scope = `${tenantId}/${actorId ?? ''}/${kind}`;
  const active = useRef<string | null>(null),
    inFlight = useRef(false),
    callback = useRef(options.onConfirmed);
  useLayoutEffect(() => {
    active.current = scope;
    callback.current = options.onConfirmed;
    return () => {
      active.current = null;
    };
  }, [scope, options.onConfirmed]);
  const current = () => active.current === scope;
  const observed = useRef(new Map<string, string>());
  const remember = useCallback((values: ReportRequestOperation[]) => {
    for (const value of values) {
      const previous = observed.current.get(key(value));
      if (previous !== undefined && previous !== canonicalJson(value))
        throw Error(
          'Retained report request changed. Preserve its original intent and reload before continuing.',
        );
      observed.current.set(key(value), canonicalJson(value));
    }
    return values;
  }, []);
  const read = () => remember(actorId ? readReportRequests(localStorage, tenantId, actorId) : []);
  useEffect(() => {
    let mounted = true;
    const load = () => {
      if (!mounted) return;
      try {
        if (!actorId)
          throw Error(
            'Current account identity is unavailable. Reload Reports before requesting a draft.',
          );
        setEntries(remember(readReportRequests(localStorage, tenantId, actorId)));
        setReady(true);
      } catch {
        setReady(false);
        setError(
          'Report request storage or current account identity is unavailable. Preserve retained requests and reload Reports before continuing.',
        );
      }
    };
    void Promise.resolve().then(load);
    window.addEventListener('storage', load);
    return () => {
      mounted = false;
      window.removeEventListener('storage', load);
    };
  }, [tenantId, actorId, remember]);
  async function dispatch(operation: ReportRequestOperation) {
    if (
      inFlight.current ||
      !canRequest ||
      !ready ||
      !current() ||
      operation.tenantId !== tenantId.toLowerCase() ||
      operation.actorId !== actorId?.toLowerCase() ||
      operation.kind !== kind
    )
      return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    let receipt: Receipt;
    try {
      assertReportRequest(localStorage, operation);
      const response = await reportRequest(
        operation.tenantId,
        operation.kind === 'board'
          ? '/reports/board/request'
          : '/reports/statutory/auditor/requests',
        { body: operation.body, expectedActorId: operation.actorId },
      );
      receipt = receiptSchema.parse(await response.json());
    } catch (cause) {
      if (current()) {
        setError(failure(cause));
        try {
          setEntries(read());
        } catch {
          setReady(false);
        }
      }
      inFlight.current = false;
      if (current()) setBusy(false);
      return;
    }
    // A valid positive response is known; cleanup/refresh failures must not turn it into an unknown request.
    if (current()) {
      setConfirmed({ operation, receipt });
      setNotice(
        `Report request ${receipt.requestId} is recorded. No report was generated or released.`,
      );
      try {
        clearConfirmedReportRequest(localStorage, operation);
        setEntries(read());
        setConfirmed(null);
      } catch {
        setError(
          'The report request is recorded, but its browser reference remains. Clear only this confirmed reference below.',
        );
      }
      try {
        callback.current();
      } catch {
        setError('The report request is recorded. Refresh the report list to see its saved state.');
      }
      setBusy(false);
    }
    inFlight.current = false;
  }
  async function send(body: Omit<Body, 'operationKey'>) {
    if (inFlight.current || !ready || !canRequest || !actorId || !current()) return;
    try {
      const operation = retainReportRequest(localStorage, {
        version: 1,
        tenantId,
        actorId,
        kind,
        body: { ...body, operationKey: prepareReportOperationKey() },
      });
      setEntries(read());
      await dispatch(operation);
    } catch (cause) {
      if (current()) {
        setError(failure(cause));
        try {
          setEntries(read());
        } catch {
          setReady(false);
        }
      }
    }
  }
  function clearConfirmed() {
    if (!confirmed || !current()) return;
    try {
      clearConfirmedReportRequest(localStorage, confirmed.operation);
      setEntries(read());
      setConfirmed(null);
      setError('');
    } catch (cause) {
      setError(failure(cause));
    }
  }
  return {
    entries: entries.filter((e) => e.kind === kind),
    otherPending: entries.some((e) => e.kind !== kind),
    blocked: !ready || busy || entries.length > 0 || !actorId,
    ready,
    canRetry: canRequest && ready,
    busy,
    error,
    notice,
    confirmed,
    send,
    retry: dispatch,
    clearConfirmed,
  };
}
export function ReportRequestRecovery({
  recovery,
}: {
  recovery: ReturnType<typeof useReportRequestRecovery>;
}) {
  const [confirmation, setConfirmation] = useState<string | null>(null);
  return (
    <div className="space-y-2 text-sm">
      {recovery.error && <p role="alert">{recovery.error}</p>}
      {recovery.notice && <p role="status">{recovery.notice}</p>}
      {!recovery.ready && (
        <p>
          Report request storage and current account identity must be available before requesting a
          draft.
        </p>
      )}
      {recovery.otherPending && (
        <p>Resolve the retained request in the other report workflow before starting another.</p>
      )}
      {recovery.entries.map((operation) => (
        <section
          key={operation.body.operationKey}
          aria-label="Retained report request"
          className="space-y-2 rounded border p-3"
        >
          <p>
            {operation.kind}: {operation.body.title}
          </p>
          <p>
            Assessment run {operation.body.assessmentRunId} · Engagement{' '}
            {operation.body.engagementId} · Operation key {operation.body.operationKey}
          </p>
          <p>
            The exact request remains retained. A missing, failed or refused response does not prove
            it was unrecorded. Checking or retrying below may record this original request if it is
            not already saved; it never starts report generation or release.
          </p>
          {!recovery.canRetry && (
            <p>
              Current access or browser storage does not permit retrying. The original request
              remains retained.
            </p>
          )}
          {recovery.confirmed &&
          canonicalJson(recovery.confirmed.operation) === canonicalJson(operation) ? (
            <button type="button" onClick={recovery.clearConfirmed}>
              Clear confirmed browser reference
            </button>
          ) : (
            <>
              <label>
                <input
                  type="checkbox"
                  checked={confirmation === canonicalJson(operation)}
                  disabled={recovery.busy || !recovery.canRetry}
                  onChange={(event) =>
                    setConfirmation(event.target.checked ? canonicalJson(operation) : null)
                  }
                />
                I authorize checking or retrying this exact retained request.
              </label>
              <button
                type="button"
                disabled={
                  recovery.busy || !recovery.canRetry || confirmation !== canonicalJson(operation)
                }
                onClick={() => {
                  setConfirmation(null);
                  void recovery.retry(operation);
                }}
              >
                Check or retry exact retained request
              </button>
            </>
          )}
        </section>
      ))}
    </div>
  );
}
