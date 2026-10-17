'use client';
import { displayLocalToInstant, displayTimeZone } from '@/lib/display-time';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button, Input, Label, StatusBadge, Textarea, generateUUID } from '@axiom/ui';
import {
  FactList,
  FieldHint,
  Notice,
  SectionCard,
  Step,
  StepList,
  checkLabelClass,
  checkboxClass,
  selectClass,
} from '@/components/workflow-blocks';
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
export function LocalCustodyClient({
  tenantId,
  actorId,
  tenantSlug,
}: {
  tenantId: string;
  actorId: string;
  /** Only names the operator's manifest file in the guidance text. */
  tenantSlug?: string;
}) {
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
          // Wall-clock time in the display zone (IST by default), never the
          // browser's own zone; NaN keeps the schema's refusal of bad input.
          nextReviewDueAt:
            transition === 'review' ? (displayLocalToInstant(reviewDate)?.getTime() ?? NaN) : null,
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
  const blocked = visiblePending.length > 0;
  const manifestFile = `docs/private-docs/custody-manifests/${tenantSlug || '<organisation>'}.json`;
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <SectionCard
        aria-label="How local custody works"
        title="How local custody works"
        description={
          <>
            Dispatch-key custody only. Customer owner requests, internal founder approves, and the
            specifically nominated internal operator activates. No action here grants storage
            access, report release, or agent write credentials.
          </>
        }
      >
        <ol className="grid min-w-0 gap-3 md:grid-cols-3">
          {[
            ['1', 'Owner requests', 'The customer owner pastes the operator-reviewed manifest.'],
            ['2', 'Founder approves', 'An internal founder approves the recorded request.'],
            ['3', 'Operator activates', 'The nominated internal operator activates the policy.'],
          ].map(([n, title, body]) => (
            <li
              key={n}
              className="flex min-w-0 gap-3 rounded-lg border border-slate-200 bg-mist-50 p-3"
            >
              <span
                aria-hidden
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-indigo-500 text-xs font-semibold text-white"
              >
                {n}
              </span>
              <span className="min-w-0 text-sm">
                <span className="block font-semibold text-indigo-500">{title}</span>
                <span className="text-slate-600">{body}</span>
              </span>
            </li>
          ))}
        </ol>
        <Notice tone="info">
          <strong>Approve and activate appear only after an owner request.</strong> A policy shows
          those buttons once the customer owner&apos;s request is recorded and your role is the next
          step. Until then the policy list is empty or shows no action for you.
        </Notice>
        <ul className="list-disc space-y-1 pl-5 text-sm text-slate-600">
          <li>
            Explicit demo organisations may use the current internal founder&apos;s demo request.
            Ordinary customer policies require the customer owner&apos;s request.
          </li>
          <li>
            Valid until revoked. Periodic review overdue is a reminder, not an automatic service
            stop. Existing accepted jobs retain their original bounded authority.
          </li>
        </ul>
      </SectionCard>
      {error && (
        <Notice tone="error" role="alert">
          {error}
        </Notice>
      )}
      {message && (
        <Notice tone="info" role="status">
          {message}
        </Notice>
      )}
      {confirmedReceipt?.tenantId === scope.tenantId &&
        confirmedReceipt.actorId === scope.actorId && (
          <section
            aria-label="Confirmed custody receipt"
            className="min-w-0 rounded-xl border border-teal-300 bg-teal-50/60 p-4 sm:p-5"
          >
            <h2 className="mb-2 font-heading text-base font-semibold text-indigo-500">
              Confirmed receipt
            </h2>
            <p className="break-all font-mono text-xs leading-relaxed text-slate-800">
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
      {!ready && (
        <Notice tone="neutral">Loading current policy context and retained requests…</Notice>
      )}
      <SectionCard
        aria-label="Current custody policies"
        title="Current policies"
        description="Each policy shows its recorded state and only the actions your role may take next."
        actions={
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void run(() => refresh())}
          >
            Refresh current policies
          </Button>
        }
      >
        {ready && rows.length === 0 && (
          <div className="rounded-lg border border-dashed border-slate-300 bg-mist-50 p-4 text-sm text-slate-600">
            <p className="font-medium text-slate-700">No readable policy on this page.</p>
            <p className="mt-1">
              A policy appears here once a customer owner&apos;s request is recorded.
            </p>
          </div>
        )}
        {rows.map((row) => (
          <article
            key={row.policyId}
            className="flex min-w-0 flex-col gap-3 rounded-lg border border-slate-200 p-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="min-w-0 break-all font-heading text-sm font-semibold text-indigo-500">
                Policy {row.policyId}
              </h3>
              <StatusBadge
                status={row.head.state === 'requested' ? 'awaiting_approval' : row.head.state}
              />
            </div>
            <p className="text-sm text-slate-700">
              State: {row.head.state}.{' '}
              {row.head.state === 'active' && row.reviewOverdue ? (
                <span className="font-medium text-ember-700">
                  Periodic review overdue; authority remains valid until revoked.
                </span>
              ) : (
                ''
              )}
            </p>
            <FactList items={[{ label: 'Policy SHA-256', value: row.policySha256, mono: true }]} />
            <details className="rounded-md border border-slate-200 bg-mist-50 px-3 py-2 text-sm">
              <summary className="cursor-pointer font-medium text-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500">
                Review exact non-secret policy
              </summary>
              <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs text-slate-700">
                {row.policyText}
              </pre>
            </details>
            <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-3">
              {row.actions.map((action) => (
                <Button
                  key={action}
                  variant={action === 'revoke' ? 'danger' : 'accent'}
                  size="sm"
                  disabled={busy || !ready || blocked}
                  onClick={() => void run(() => prepare(row, action))}
                >
                  Prepare {action}
                </Button>
              ))}
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void run(() => refresh({ policyId: row.policyId }))}
              >
                View policy history
              </Button>
            </div>
            {row.actions.length === 0 ? (
              <FieldHint>
                No action is available to your role at this policy&apos;s current state.
              </FieldHint>
            ) : (
              <FieldHint>
                Fill in the reason and confirmation under Prepare a request below, then use a
                Prepare button here.{blocked ? ' Resolve the pending request first.' : ''}
              </FieldHint>
            )}
          </article>
        ))}
        {visibleContext?.nextCursor && (
          <div>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void run(() => refresh({ after: visibleContext.nextCursor! }))}
            >
              Next policy page
            </Button>
          </div>
        )}
        {visibleContext?.selectedPolicyId && (
          <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-slate-200 bg-mist-50 p-4">
            <h3 className="font-heading text-sm font-semibold text-indigo-500">Recorded history</h3>
            <ol className="flex min-w-0 flex-col gap-2">
              {visibleContext.history.map((e) => (
                <li
                  key={e.eventId}
                  className="min-w-0 break-all rounded-md border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700"
                >
                  <span className="font-semibold capitalize text-indigo-500">{e.transition}</span>{' '}
                  by {e.actorId}; event {e.eventId}; ledger receipt {e.receipt.id}; hash{' '}
                  <span className="font-mono">{e.receipt.entryHash}</span>
                </li>
              ))}
            </ol>
            {visibleContext.nextHistoryCursor && (
              <div>
                <Button
                  variant="outline"
                  size="sm"
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
                </Button>
              </div>
            )}
          </div>
        )}
      </SectionCard>
      {storageReady && (
        <SectionCard
          aria-label="Retained custody requests"
          title="Pending requests"
          description="A prepared request is saved on this device until it is recorded or cancelled. Work through the steps in order; each recording needs a fresh authenticator code."
        >
          {visiblePending.length === 0 ? (
            <p className="text-sm text-slate-600">
              No unresolved request in this organisation and account.
            </p>
          ) : (
            <>
              <div className="flex min-w-0 flex-col gap-1.5">
                <Label htmlFor="custody-retained-request">Retained request</Label>
                <select
                  id="custody-retained-request"
                  className={selectClass}
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
              </div>
              {selected && (
                <>
                  <details className="rounded-md border border-slate-200 bg-mist-50 px-3 py-2 text-sm">
                    <summary className="cursor-pointer font-medium text-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500">
                      Exact retained request ({selected.request.transition})
                    </summary>
                    <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs text-slate-700">
                      {JSON.stringify(selected.request, null, 2)}
                    </pre>
                  </details>
                  {selectedResolution && (
                    <Notice tone="warning">
                      Retained cancellation {selectedResolution.resolution.operationKey}:{' '}
                      {selectedResolution.resolution.reason}. Only this exact cancellation may be
                      retried; the original action will not be sent.
                    </Notice>
                  )}
                  <StepList>
                    <Step
                      n={1}
                      title="Check its recorded state"
                      state={recovered ? 'done' : 'current'}
                    >
                      <FieldHint>
                        Looks up whether this exact request was already recorded. Nothing is sent
                        for recording.
                      </FieldHint>
                      <div>
                        <Button
                          variant="primary"
                          disabled={busy}
                          onClick={() => void run(reconcile)}
                        >
                          {selectedResolution
                            ? 'Check retained cancellation'
                            : 'Check retained request'}
                        </Button>
                      </div>
                    </Step>
                    <Step
                      n={2}
                      title="Confirm the exact retry"
                      state={retryConfirmed && recovered ? 'done' : recovered ? 'current' : 'todo'}
                    >
                      <label className={checkLabelClass}>
                        <input
                          type="checkbox"
                          className={checkboxClass}
                          checked={retryConfirmed}
                          onChange={(e) => setRetryConfirmed(e.target.checked)}
                          disabled={!recovered || busy}
                        />
                        I reviewed this exact retained request and authorize its retry with fresh
                        MFA.
                      </label>
                    </Step>
                    <Step
                      n={3}
                      title="Authenticate"
                      state={verified ? 'done' : retryConfirmed && recovered ? 'current' : 'todo'}
                    >
                      <div>
                        <Button
                          variant="outline"
                          disabled={busy || !recovered || !retryConfirmed}
                          onClick={() => void run(() => step('challenge'))}
                        >
                          Request authenticator challenge
                        </Button>
                      </div>
                      {challenge && recovered && (
                        <div className="flex flex-wrap items-end gap-3">
                          <div className="flex flex-col gap-1.5">
                            <Label htmlFor="custody-authenticator-code">Authenticator code</Label>
                            <Input
                              id="custody-authenticator-code"
                              className="w-40"
                              inputMode="numeric"
                              autoComplete="one-time-code"
                              value={code}
                              onChange={(e) => {
                                setCode(e.target.value);
                                setVerified(false);
                              }}
                            />
                          </div>
                          <Button
                            variant="outline"
                            disabled={busy || !code}
                            onClick={() => void run(() => step('verify'))}
                          >
                            Verify authenticator
                          </Button>
                        </div>
                      )}
                    </Step>
                    <Step n={4} title="Record it" state={verified ? 'current' : 'todo'}>
                      <FieldHint>
                        Records the exact action in the audit ledger. A policy receipt alone does
                        not provision keys or start services.
                      </FieldHint>
                      <div>
                        <Button
                          variant="accent"
                          disabled={busy || !verified || !retryConfirmed}
                          onClick={() => void run(() => step('record'))}
                        >
                          {selectedResolution
                            ? 'Record exact cancellation'
                            : 'Record exact custody action'}
                        </Button>
                      </div>
                    </Step>
                  </StepList>
                  {!selectedResolution && (
                    <div className="flex min-w-0 flex-col gap-3 rounded-lg border border-ember-500/30 bg-ember-50/40 p-4">
                      <div>
                        <h3 className="font-heading text-sm font-semibold text-ember-700">
                          Cancel this request instead
                        </h3>
                        <FieldHint>
                          Available after step 1. Cancellation is recorded separately with fresh
                          MFA; the original request is preserved, never deleted.
                        </FieldHint>
                      </div>
                      <div className="flex min-w-0 flex-col gap-1.5">
                        <Label htmlFor="custody-cancel-reason">Cancellation reason</Label>
                        <Input
                          id="custody-cancel-reason"
                          value={cancelReason}
                          onChange={(e) => {
                            setCancelReason(e.target.value);
                            setCancelConfirmed(false);
                          }}
                          maxLength={2000}
                        />
                      </div>
                      <label className={checkLabelClass}>
                        <input
                          type="checkbox"
                          className={checkboxClass}
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
                      <div>
                        <Button
                          variant="danger"
                          disabled={
                            busy || !recovered || !cancellationConfirmed || !cancelReason.trim()
                          }
                          onClick={() => void run(async () => prepareCancellation())}
                        >
                          Prepare recorded cancellation
                        </Button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </SectionCard>
      )}
      <SectionCard
        aria-label="Prepare custody request"
        title="Prepare a request"
        description="Preparing saves the exact request on this device only; nothing is recorded yet. You then check, authenticate and record it under Pending requests."
      >
        {blocked && (
          <Notice tone="warning">
            Resolve the pending request above before preparing another one.
          </Notice>
        )}
        <StepList>
          <Step n={1} title="Give a reason">
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor="custody-reason">Reason</Label>
              <Textarea
                id="custody-reason"
                rows={3}
                value={reason}
                onChange={(e) => {
                  draftVersion.current++;
                  setReason(e.target.value);
                  setConfirmed(false);
                }}
                maxLength={2000}
              />
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor="custody-review-date">
                Next periodic review (review action only, {displayTimeZone()})
              </Label>
              <Input
                id="custody-review-date"
                className="sm:w-72"
                type="datetime-local"
                value={reviewDate}
                onChange={(e) => {
                  draftVersion.current++;
                  setReviewDate(e.target.value);
                  setConfirmed(false);
                }}
              />
              <FieldHint>Needed only when you prepare a review. Leave empty otherwise.</FieldHint>
            </div>
          </Step>
          {visibleContext?.canRequest && (
            <Step n={2} title="Paste the operator manifest (owner request only)">
              <div className="flex min-w-0 flex-col gap-1.5">
                <Label htmlFor="custody-manifest">Operator-reviewed non-secret manifest JSON</Label>
                <Textarea
                  id="custody-manifest"
                  aria-describedby="custody-manifest-hint"
                  rows={10}
                  spellCheck={false}
                  className="min-h-[14rem] font-mono text-xs"
                  placeholder={'{"policyText":"…","policySha256":"…"}'}
                  value={manifest}
                  onChange={(e) => {
                    draftVersion.current++;
                    setManifest(e.target.value);
                    setConfirmed(false);
                  }}
                  maxLength={65536}
                />
              </div>
              <div
                id="custody-manifest-hint"
                className="flex min-w-0 flex-col gap-1.5 text-xs leading-relaxed text-slate-600"
              >
                <p>
                  Your Axiom operator provides this file. Locally it is{' '}
                  <code className="break-all rounded bg-mist-200 px-1.5 py-0.5 text-[11px] text-indigo-500">
                    {manifestFile}
                  </code>
                  . Open it, copy the whole contents and paste them here unchanged.
                </p>
                <p>
                  Provide policyText and policySha256 from the operator-reviewed manifest. Do not
                  paste private keys, passwords, JWTs, MFA codes or private endpoint credentials. No
                  key or workload defaults are invented.
                </p>
              </div>
            </Step>
          )}
          <Step n={visibleContext?.canRequest ? 3 : 2} title="Confirm and prepare">
            <label className={checkLabelClass}>
              <input
                type="checkbox"
                className={checkboxClass}
                checked={confirmed}
                onChange={(e) => {
                  draftVersion.current++;
                  setConfirmed(e.target.checked);
                }}
              />
              I reviewed the exact non-secret policy, selected action and reason.
            </label>
            {visibleContext?.canRequest ? (
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  variant="accent"
                  disabled={busy || !ready || blocked}
                  onClick={() => void run(() => prepare(null, 'request'))}
                >
                  Prepare owner request
                </Button>
                <FieldHint>
                  For an existing policy, use its Prepare button under Current policies instead.
                </FieldHint>
              </div>
            ) : (
              <FieldHint>
                Then use the Prepare button on the policy under Current policies.
              </FieldHint>
            )}
          </Step>
        </StepList>
      </SectionCard>
    </div>
  );
}
