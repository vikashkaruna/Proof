'use client';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { generateUUID } from '@axiom/ui';
import { z } from 'zod';
import {
  encodeLocalCustodyEvent,
  localCustodyCancellationReceiptSchema,
  localCustodyEventRequestSchema,
  localCustodyEventReceiptSchema,
  parseLocalCustodyPolicyText,
  type LocalCustodyContext,
  type LocalCustodyEventRequest,
  type LocalCustodyContextRow,
} from '@axiom/types';
import {
  loadCustodyContext,
  custodyStep,
  custodyResolutionStep,
  custodyScope,
} from './custody-client';
import {
  readCustodyIntents,
  readCustodyResolution,
  retainCustodyResolution,
  assertCustodyResolution,
  clearCustodyResolution,
  type CustodyResolutionIntent,
  retainCustodyIntent,
  clearCustodyIntent,
  assertCustodyIntent,
  intentFor,
  type CustodyIntent,
} from './custody-journal';
type Receipt =
  | z.infer<typeof localCustodyEventReceiptSchema>
  | z.infer<typeof localCustodyCancellationReceiptSchema>;
const manifestSchema = z
  .object({ policyText: z.string().max(16384), policySha256: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
export function LocalCustodyClient({ tenantId, actorId }: { tenantId: string; actorId: string }) {
  const scope = useMemo(() => custodyScope(tenantId, actorId), [tenantId, actorId]),
    scopeKey = scope.tenantId + ':' + scope.actorId;
  const draftVersion = useRef(0),
    readVersion = useRef(0);
  const lease = useRef<{ scope: string } | null>(null),
    inFlight = useRef(new Map<string, { scope: string }>());
  const [context, setContext] = useState<LocalCustodyContext | null>(null),
    [pending, setPending] = useState<CustodyIntent[]>([]),
    [loaded, setLoaded] = useState(false),
    [journalScope, setJournalScope] = useState<string | null>(null),
    [busyOwner, setBusyOwner] = useState<{ scope: string; token: object } | null>(null),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const busy = busyOwner?.scope === scopeKey;
  const [confirmedReceipt, setConfirmedReceipt] = useState<Receipt | null>(null);
  const [resolutions, setResolutions] = useState<Record<string, CustodyResolutionIntent>>({}),
    [cancelReason, setCancelReason] = useState(''),
    [cancelConfirmed, setCancelConfirmed] = useState(false),
    [cancelConfirmationScope, setCancelConfirmationScope] = useState('');
  const [manifest, setManifest] = useState(''),
    [reason, setReason] = useState(''),
    [confirmed, setConfirmed] = useState(false),
    [reviewDate, setReviewDate] = useState('');
  const [chosen, setChosen] = useState<string | null>(null),
    [recoveredFor, setRecoveredFor] = useState<string | null>(null),
    [retryConfirmed, setRetryConfirmed] = useState(false),
    [challenge, setChallenge] = useState<string | null>(null),
    [code, setCode] = useState(''),
    [verified, setVerified] = useState(false);
  useLayoutEffect(() => {
    const token = { scope: scopeKey };
    lease.current = token;
    return () => {
      if (lease.current === token) lease.current = null;
    };
  }, [scopeKey]);
  const resetStep = () => {
    setRecoveredFor(null);
    setRetryConfirmed(false);
    setChallenge(null);
    setCode('');
    setVerified(false);
  };
  const readJournal = useCallback(() => {
    const token = lease.current;
    if (token?.scope !== scopeKey) return;
    const intents = readCustodyIntents(localStorage, scope.tenantId, scope.actorId);
    const linked: Record<string, CustodyResolutionIntent> = {};
    for (const intent of intents) {
      const resolution = readCustodyResolution(localStorage, intent);
      if (resolution) linked[intent.request.operationKey] = resolution;
    }
    setResolutions(linked);
    setPending(intents);
    setLoaded(true);
    setJournalScope(scopeKey);
    setChosen((current) =>
      intents.some((x) => x.request.operationKey === current)
        ? current
        : (intents[0]?.request.operationKey ?? null),
    );
  }, [scope, scopeKey]);
  const refresh = useCallback(
    async (query: { policyId?: string; after?: string; beforeReceiptId?: string } = {}) => {
      const token = lease.current;
      if (!token || token.scope !== scopeKey) return;
      const generation = ++readVersion.current;
      const value = await loadCustodyContext(scope, query);
      if (
        lease.current !== token ||
        token?.scope !== scopeKey ||
        readVersion.current !== generation
      )
        return;
      readJournal();
      setContext(value);
    },
    [scope, scopeKey, readJournal],
  );
  useEffect(() => {
    const token = lease.current;
    void Promise.resolve().then(async () => {
      if (lease.current !== token) return;
      try {
        readJournal();
        await refresh();
      } catch {
        if (lease.current === token)
          setError(
            'Current policy context or retained storage could not be loaded. Refresh before continuing.',
          );
      }
    });
    const storage = (event: StorageEvent) => {
      if (event.storageArea === localStorage) {
        try {
          readJournal();
        } catch {
          setError('Retained custody storage changed and cannot be verified.');
          setLoaded(false);
          return;
        }
        void refresh().catch(() => {
          if (lease.current === token)
            setError('Retained storage changed and could not be verified.');
        });
      }
    };
    window.addEventListener('storage', storage);
    return () => window.removeEventListener('storage', storage);
    // Scope is immutable for this effect; requests use explicit tenant and actor.
  }, [refresh, scopeKey, readJournal]);
  const visibleContext =
    context?.tenantId === scope.tenantId && context.actorId === scope.actorId ? context : null;
  const visiblePending = pending.filter(
    (p) => p.tenantId === scope.tenantId && p.actorId === scope.actorId,
  );
  const storageReady = loaded && journalScope === scopeKey;
  const ready = storageReady && visibleContext !== null;
  const selected = visiblePending.find((p) => p.request.operationKey === chosen) ?? null;
  const selectedResolution = selected ? (resolutions[selected.request.operationKey] ?? null) : null;
  const resolutionScope =
    scopeKey +
    ':' +
    (selected?.request.operationKey ?? '') +
    ':' +
    (selectedResolution?.resolution.operationKey ?? 'original');
  const cancellationConfirmed =
    cancelConfirmed && cancelConfirmationScope === scopeKey + ':' + selected?.request.operationKey;
  const recovered = selected !== null && recoveredFor === resolutionScope;
  async function run(action: () => Promise<void>) {
    const token = lease.current;
    if (!token || inFlight.current.has(scopeKey)) return;
    inFlight.current.set(scopeKey, token);
    setBusyOwner({ scope: scopeKey, token });
    setError('');
    try {
      await action();
    } catch (e) {
      if (lease.current === token)
        setError(
          e instanceof Error
            ? e.message
            : 'Custody outcome unavailable. Keep the retained request.',
        );
    } finally {
      if (inFlight.current.get(scopeKey) === token) inFlight.current.delete(scopeKey);
      if (lease.current !== null)
        setBusyOwner((current) => (current?.token === token ? null : current));
    }
  }
  async function prepare(
    row: LocalCustodyContextRow | null,
    transition: LocalCustodyEventRequest['transition'],
  ) {
    const prepareLease = lease.current,
      prepareVersion = draftVersion.current;
    setError('');
    try {
      if (!ready || busy || !visibleContext || visiblePending.length)
        throw new Error('Resolve every retained request before preparing another intent.');
      if (!confirmed)
        throw new Error('Review the exact policy, action and reason, then confirm preparation.');
      const supplied = row
        ? { policyText: row.policyText, policySha256: row.policySha256 }
        : manifestSchema.parse(JSON.parse(manifest));
      const policy = parseLocalCustodyPolicyText(supplied.policyText);
      if (policy.tenantId !== scope.tenantId)
        throw new Error('The operator manifest belongs to another organisation.');
      if (transition === 'request' && !visibleContext.requestModes.includes(policy.mode))
        throw new Error(
          'This policy profile cannot be requested by this account in the current organisation.',
        );
      const request = Object.freeze(
        localCustodyEventRequestSchema.parse({
          version: 1,
          operationKey: generateUUID(),
          transition,
          ...supplied,
          previousEventId: row?.head.eventId ?? null,
          nextReviewDueAt: transition === 'review' ? Date.parse(reviewDate) : null,
          reason,
          confirmed: true,
        }),
      );
      // Explicit preparation performs read-only validation before creating a durable
      // mutation intent. No MFA/record endpoint has been contacted at this point.
      const token = lease.current;
      const existing = await custodyStep(scope, 'recover', request);
      if (
        lease.current !== token ||
        lease.current !== prepareLease ||
        draftVersion.current !== prepareVersion
      )
        return;
      if (!('state' in existing) || existing.state !== 'not_found') {
        if (!('state' in existing) || existing.state !== 'recorded')
          throw new Error('Custody response could not be verified.');
        setConfirmedReceipt(existing);
        setMessage(
          'This exact operation already has a recorded receipt. Refresh its current context.',
        );
        await refresh();
        return;
      }
      const intent = intentFor(scope.tenantId, scope.actorId, request);
      retainCustodyIntent(localStorage, intent);
      setConfirmedReceipt(null);
      setPending(readCustodyIntents(localStorage, scope.tenantId, scope.actorId));
      setChosen(request.operationKey);
      resetStep();
      setConfirmed(false);
      setMessage(
        'Exact request retained. Check its recorded state before requesting a fresh authenticator challenge.',
      );
    } catch (e) {
      if (lease.current !== prepareLease || draftVersion.current !== prepareVersion) return;
      setError(
        e instanceof z.ZodError
          ? 'Enter a valid non-secret manifest, reason and required review date. Nothing was sent.'
          : e instanceof Error
            ? e.message
            : 'Preparation failed. Nothing was sent.',
      );
      try {
        setPending(readCustodyIntents(localStorage, scope.tenantId, scope.actorId));
      } catch {
        setLoaded(false);
      }
    }
  }
  async function reconcile() {
    if (!selected) return;
    const token = lease.current;
    assertCustodyIntent(localStorage, selected, false);
    const result = selectedResolution
      ? await custodyResolutionStep(scope, 'recover', selectedResolution.resolution)
      : await custodyStep(scope, 'recover', selected.request);
    if (lease.current !== token) return;
    resetStep();
    if ('state' in result && result.state === 'not_found') {
      setRecoveredFor(resolutionScope);
      setMessage(
        'No positive receipt was found. This does not prove the request never committed. Its exact intent remains retained; confirm an exact retry to proceed.',
      );
      return;
    }
    if (!('state' in result) || !['recorded', 'cancelled'].includes(result.state))
      throw new Error('Custody response could not be verified.');
    if (result.state === 'recorded' || result.state === 'cancelled') complete(selected, result);
  }
  function complete(intent: CustodyIntent, receipt: Receipt) {
    setConfirmedReceipt(receipt);
    readVersion.current++;
    setContext(null);
    setMessage(
      receipt.state === 'cancelled'
        ? 'Cancellation receipt confirmed. The original intent is fenced; no policy or head was changed.'
        : 'Recorded custody receipt confirmed. This policy receipt alone does not provision keys, start services or certify statutory compliance.',
    );
    resetStep();
    try {
      const linked = readCustodyResolution(localStorage, intent);
      if (linked) clearCustodyResolution(localStorage, intent, linked);
      clearCustodyIntent(localStorage, intent);
      setPending(readCustodyIntents(localStorage, scope.tenantId, scope.actorId));
      setChosen(null);
    } catch {
      setError(
        'Receipt is confirmed, but changed retained storage was preserved. Refresh to reconcile it.',
      );
    }
    const token = lease.current;
    void refresh().catch(() => {
      if (lease.current === token)
        setError(
          'Receipt confirmed. Current context refresh failed; refresh before another action.',
        );
    });
  }
  async function step(which: 'challenge' | 'verify' | 'record') {
    if (!selected) return;
    const token = lease.current;
    assertCustodyIntent(localStorage, selected, true);
    if (
      JSON.stringify(readCustodyResolution(localStorage, selected)) !==
      JSON.stringify(selectedResolution)
    )
      throw Error('Retained resolution changed. Check it before any action.');
    if (!recovered || !retryConfirmed)
      throw new Error('Check the retained request and explicitly confirm this exact retry first.');
    try {
      if (selectedResolution) assertCustodyResolution(localStorage, selected, selectedResolution);
      const result = selectedResolution
        ? await custodyResolutionStep(
            scope,
            which,
            selectedResolution.resolution,
            which === 'challenge' ? undefined : (challenge ?? undefined),
            which === 'verify' ? code : undefined,
          )
        : await custodyStep(
            scope,
            which,
            selected.request,
            which === 'challenge' ? undefined : (challenge ?? undefined),
            which === 'verify' ? code : undefined,
          );
      if (lease.current !== token) return;
      if (which === 'challenge' && 'challengeId' in result) {
        setChallenge(result.challengeId);
        setVerified(false);
        setCode('');
      } else if (which === 'verify') {
        setVerified(true);
        setCode('');
      } else if (which === 'record') {
        if (!('state' in result) || (result.state !== 'recorded' && result.state !== 'cancelled'))
          throw new Error('Custody response could not be verified.');
        complete(selected, result);
      }
    } catch (e) {
      if (lease.current === token) {
        resetStep();
        setMessage('The exact intent remains retained. Check its recorded state before any retry.');
      }
      throw e;
    }
  }
  function prepareCancellation() {
    if (
      !selected ||
      selectedResolution ||
      !recovered ||
      !cancellationConfirmed ||
      !cancelReason.trim()
    )
      throw Error('Check the original request and confirm a reasoned cancellation first.');
    const linked = retainCustodyResolution(localStorage, selected, {
      tenantId: scope.tenantId,
      actorId: scope.actorId,
      resolution: {
        version: 1,
        operationKey: generateUUID(),
        originalRequestText: encodeLocalCustodyEvent(selected.request),
        reason: cancelReason,
        confirmed: true,
      },
    });
    setResolutions((current) => ({ ...current, [selected.request.operationKey]: linked }));
    resetStep();
    setCancelReason('');
    setCancelConfirmed(false);
    setMessage(
      'Separate cancellation intent retained. Check it before fresh MFA; the original intent remains preserved.',
    );
  }
  const rows = visibleContext?.rows ?? [];
  return (
    <div className="space-y-5">
      <p>
        Dispatch-key custody only. Customer owner requests, internal founder approves, and the
        specifically nominated internal operator activates. No action here grants storage access,
        report release, or agent write credentials.
      </p>
      <p>
        Explicit demo organisations may use the current internal founder's demo request. Ordinary
        customer policies require the customer owner's request.
      </p>
      <p>
        Valid until revoked. Periodic review overdue is a reminder, not an automatic service stop.
        Existing accepted jobs retain their original bounded authority.
      </p>
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      {confirmedReceipt?.tenantId === scope.tenantId &&
        confirmedReceipt.actorId === scope.actorId && (
          <section aria-label="Confirmed custody receipt">
            <p>
              {confirmedReceipt.state === 'recorded'
                ? `Recorded ${confirmedReceipt.transition}; event ${confirmedReceipt.eventId}`
                : `Cancelled original operation ${confirmedReceipt.originalOperationKey}; cancellation ${confirmedReceipt.cancellationId}`}
              ; ledger receipt {confirmedReceipt.receipt.id}; entry hash{' '}
              {confirmedReceipt.receipt.entryHash};{' '}
              {confirmedReceipt.state === 'recorded'
                ? `policy SHA-256 ${confirmedReceipt.policySha256}`
                : `original request SHA-256 ${confirmedReceipt.originalRequestSha256}`}
              .
            </p>
          </section>
        )}
      <button disabled={busy} onClick={() => void run(() => refresh())}>
        Refresh current policies
      </button>
      {!ready && <p>Loading current policy context and retained requests…</p>}
      {storageReady && (
        <section aria-label="Retained custody requests">
          <h2>Retained requests</h2>
          {visiblePending.length === 0 ? (
            <p>No unresolved request in this organisation and account.</p>
          ) : (
            <>
              <label>
                Retained request
                <select
                  value={chosen ?? ''}
                  onChange={(e) => {
                    setChosen(e.target.value);
                    setCancelReason('');
                    setCancelConfirmed(false);
                    resetStep();
                  }}
                >
                  {visiblePending.map((p) => (
                    <option key={p.request.operationKey} value={p.request.operationKey}>
                      {p.request.transition} · {p.request.operationKey}
                    </option>
                  ))}
                </select>
              </label>
              {selected && (
                <>
                  <pre className="whitespace-pre-wrap break-all">
                    {JSON.stringify(selected.request, null, 2)}
                  </pre>
                  {selectedResolution ? (
                    <p>
                      Retained cancellation {selectedResolution.resolution.operationKey}:{' '}
                      {selectedResolution.resolution.reason}. Only this exact cancellation may be
                      retried; the original action will not be sent.
                    </p>
                  ) : (
                    <>
                      <label>
                        Cancellation reason
                        <input
                          value={cancelReason}
                          onChange={(e) => {
                            setCancelReason(e.target.value);
                            setCancelConfirmed(false);
                          }}
                          maxLength={2000}
                        />
                      </label>
                      <label>
                        <input
                          type="checkbox"
                          checked={cancellationConfirmed}
                          onChange={(e) => {
                            setCancelConfirmed(e.target.checked);
                            setCancelConfirmationScope(
                              scopeKey + ':' + selected.request.operationKey,
                            );
                          }}
                        />
                        I request recorded cancellation of this exact unresolved intent, with fresh
                        MFA.
                      </label>
                      <button
                        disabled={
                          busy || !recovered || !cancellationConfirmed || !cancelReason.trim()
                        }
                        onClick={() => void run(async () => prepareCancellation())}
                      >
                        Prepare recorded cancellation
                      </button>
                    </>
                  )}
                  <button disabled={busy} onClick={() => void run(reconcile)}>
                    {selectedResolution ? 'Check retained cancellation' : 'Check retained request'}
                  </button>
                  <label>
                    <input
                      type="checkbox"
                      checked={retryConfirmed}
                      onChange={(e) => setRetryConfirmed(e.target.checked)}
                      disabled={!recovered || busy}
                    />
                    I reviewed this exact retained request and authorize its retry with fresh MFA.
                  </label>
                  <button
                    disabled={busy || !recovered || !retryConfirmed}
                    onClick={() => void run(() => step('challenge'))}
                  >
                    Request authenticator challenge
                  </button>
                  {challenge && recovered && (
                    <>
                      <label>
                        Authenticator code
                        <input
                          autoComplete="one-time-code"
                          value={code}
                          onChange={(e) => {
                            setCode(e.target.value);
                            setVerified(false);
                          }}
                        />
                      </label>
                      <button
                        disabled={busy || !code}
                        onClick={() => void run(() => step('verify'))}
                      >
                        Verify authenticator
                      </button>
                    </>
                  )}
                  <button
                    disabled={busy || !verified || !retryConfirmed}
                    onClick={() => void run(() => step('record'))}
                  >
                    {selectedResolution
                      ? 'Record exact cancellation'
                      : 'Record exact custody action'}
                  </button>
                </>
              )}
            </>
          )}
        </section>
      )}
      <section aria-label="Current custody policies">
        <h2>Current policies</h2>
        {ready && rows.length === 0 && <p>No readable policy on this page.</p>}
        {rows.map((row) => (
          <article key={row.policyId}>
            <h3>Policy {row.policyId}</h3>
            <p>
              State: {row.head.state}.{' '}
              {row.head.state === 'active' && row.reviewOverdue
                ? 'Periodic review overdue; authority remains valid until revoked.'
                : ''}
            </p>
            <p>Policy SHA-256: {row.policySha256}</p>
            <details>
              <summary>Review exact non-secret policy</summary>
              <pre className="whitespace-pre-wrap break-all">{row.policyText}</pre>
            </details>
            <button
              disabled={busy}
              onClick={() => void run(() => refresh({ policyId: row.policyId }))}
            >
              View policy history
            </button>
            {row.actions.map((action) => (
              <button
                key={action}
                disabled={busy || !ready || visiblePending.length > 0}
                onClick={() => void run(() => prepare(row, action))}
              >
                Prepare {action}
              </button>
            ))}
          </article>
        ))}
        {visibleContext?.nextCursor && (
          <button
            disabled={busy}
            onClick={() => void run(() => refresh({ after: visibleContext.nextCursor! }))}
          >
            Next policy page
          </button>
        )}
        {visibleContext?.selectedPolicyId && (
          <>
            <h3>Recorded history</h3>
            {visibleContext.history.map((e) => (
              <p key={e.eventId}>
                {e.transition} by {e.actorId}; event {e.eventId}; ledger receipt {e.receipt.id};
                hash {e.receipt.entryHash}
              </p>
            ))}
            {visibleContext.nextHistoryCursor && (
              <button
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    refresh({
                      policyId: visibleContext.selectedPolicyId!,
                      beforeReceiptId: visibleContext.nextHistoryCursor!,
                    }),
                  )
                }
              >
                Older history
              </button>
            )}
          </>
        )}
      </section>
      <section aria-label="Prepare custody request">
        <h2>Review an action</h2>
        <label>
          Reason
          <textarea
            value={reason}
            onChange={(e) => {
              draftVersion.current++;
              setReason(e.target.value);
              setConfirmed(false);
            }}
            maxLength={2000}
          />
        </label>
        <label>
          Next periodic review (review action only)
          <input
            type="datetime-local"
            value={reviewDate}
            onChange={(e) => {
              draftVersion.current++;
              setReviewDate(e.target.value);
              setConfirmed(false);
            }}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => {
              draftVersion.current++;
              setConfirmed(e.target.checked);
            }}
          />
          I reviewed the exact non-secret policy, selected action and reason.
        </label>
        {visibleContext?.canRequest && (
          <>
            <label>
              Operator-reviewed non-secret manifest JSON
              <textarea
                value={manifest}
                onChange={(e) => {
                  draftVersion.current++;
                  setManifest(e.target.value);
                  setConfirmed(false);
                }}
                maxLength={65536}
              />
            </label>
            <p>
              Provide policyText and policySha256 from the operator-reviewed manifest. Do not paste
              private keys, passwords, JWTs, MFA codes or private endpoint credentials. No key or
              workload defaults are invented.
            </p>
            <button
              disabled={busy || !ready || visiblePending.length > 0}
              onClick={() => void run(() => prepare(null, 'request'))}
            >
              Prepare owner request
            </button>
          </>
        )}
      </section>
      <a href="/settings/security">Manage authenticator and recovery codes</a>
    </div>
  );
}
