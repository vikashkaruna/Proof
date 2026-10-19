'use client';
import Link from 'next/link';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { z } from 'zod';
import {
  dataFlowContext,
  dataFlowIntent,
  dataFlowOperation,
  type DataFlowContext,
} from '@axiom/types';
import { projectDeclaredFlows } from '@/lib/declared-flow-graph';
import { formatDateTime } from '@/lib/display-time';
import {
  archiveConfirmed,
  validateOperation,
  assertJournal,
  journalText,
  locked,
  readJournal,
  writeJournal,
  type DataFlowJournal,
} from './flow-journal';
import { requestDataFlow } from './flow-transport';
const panel = 'space-y-3 rounded-xl border border-slate-200 bg-white p-5';
const button = 'rounded-md bg-[#1E2A4A] px-3 py-2 text-sm text-white disabled:opacity-40';
const field = 'block w-full rounded-md border border-slate-300 p-2';
type Operation = z.infer<typeof dataFlowOperation>;
export function DataFlowClient({
  tenantId,
  actorId,
  initialRevisionId,
}: {
  tenantId: string;
  actorId: string;
  initialRevisionId?: string;
}) {
  const scope = `${tenantId}:${actorId}`,
    active = useRef<string | null>(scope),
    inFlight = useRef(false),
    observed = useRef<string | null>(null);
  const [context, setContext] = useState<DataFlowContext | null>(null),
    [journal, setJournal] = useState<DataFlowJournal | null>(null),
    [operation, setOperation] = useState<Operation | null>(null);
  const [busy, setBusy] = useState(false),
    [ready, setReady] = useState(false),
    [error, setError] = useState(''),
    [reason, setReason] = useState(''),
    [selected, setSelected] = useState(''),
    [destination, setDestination] = useState('unknown'),
    [partyLabel, setPartyLabel] = useState(''),
    [purpose, setPurpose] = useState(''),
    [sourceNote, setSourceNote] = useState(''),
    [validDays, setValidDays] = useState('30'),
    [historyRevision, setHistoryRevision] = useState(''),
    [sourceReviewed, setSourceReviewed] = useState(false),
    [amending, setAmending] = useState<DataFlowContext['revisions'][number] | null>(null),
    [partyRole, setPartyRole] = useState<'processor' | 'recipient'>('processor'),
    [supersedesParty, setSupersedesParty] = useState(''),
    [partySystem, setPartySystem] = useState(''),
    [categoryState, setCategoryState] = useState('unknown'),
    [categories, setCategories] = useState(''),
    [countryState, setCountryState] = useState('unknown'),
    [countries, setCountries] = useState(''),
    [originCountry, setOriginCountry] = useState(''),
    [crossBorder, setCrossBorder] = useState('unknown'),
    [safeguards, setSafeguards] = useState(''),
    [ropaRef, setRopaRef] = useState(''),
    [code, setCode] = useState(''),
    [verified, setVerified] = useState(false);
  useLayoutEffect(() => {
    active.current = scope;
    return () => {
      active.current = null;
    };
  }, [scope]);
  const current = () => {
    if (active.current !== scope)
      throw new Error('Account or organization changed. Preserve the original request.');
  };
  const read = () => {
    const v = readJournal(localStorage, tenantId, actorId);
    const text = v ? journalText(v) : null;
    if (observed.current !== null && text !== observed.current)
      throw new Error('Another tab changed the original request. Reload before continuing.');
    return v;
  };
  const refresh = async () => {
    try {
      const raw = await requestDataFlow(
        tenantId,
        actorId,
        '/data-flows' + (initialRevisionId ? '/' + z.uuid().parse(initialRevisionId) : ''),
      );
      current();
      const v = dataFlowContext.parse(z.object({ data: z.unknown() }).parse(raw).data);
      if (v.tenantId !== tenantId || v.actorId !== actorId)
        throw new Error('Current account or organization could not be confirmed.');
      setContext(v);
    } catch (error) {
      if (active.current === scope) {
        setContext(null);
        setCode('');
        setVerified(false);
      }
      throw error;
    }
  };
  useEffect(() => {
    let live = true;
    void locked(tenantId, actorId, async () => {
      const v = readJournal(localStorage, tenantId, actorId);
      if (live) {
        observed.current = v ? journalText(v) : null;
        setJournal(v);
      }
      if (live) setReady(true);
      await refresh();
    }).catch((e) => {
      if (live) setError(e instanceof Error ? e.message : 'Data flow declaration unavailable.');
    });
    const change = () => {
      if (live) {
        setReady(false);
        setError('Browser storage changed in another tab. Reload to recover the original request.');
      }
    };
    window.addEventListener('storage', change);
    return () => {
      live = false;
      window.removeEventListener('storage', change);
    };
    // Server keys this component by current actor+tenant; no state crosses scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, actorId]);
  const action = async (run: (v: DataFlowJournal | null) => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      await locked(tenantId, actorId, async () => {
        current();
        const v = read();
        if (journal) assertJournal(localStorage, journal);
        await run(v);
      });
    } catch (e) {
      if (active.current === scope)
        setError(
          e instanceof z.ZodError
            ? 'The server reply could not be validated. Preserve the original request and refresh its recorded state.'
            : e instanceof Error
              ? e.message
              : 'Outcome uncertain. Preserve and recover the original request.',
        );
    } finally {
      inFlight.current = false;
      if (active.current === scope) setBusy(false);
    }
  };
  const save = (v: DataFlowJournal, old: DataFlowJournal | null) => {
    const saved = writeJournal(localStorage, v, old);
    observed.current = journalText(saved);
    setJournal(saved);
    return saved;
  };
  const post = async (step: string, v: DataFlowJournal, extra: Record<string, string> = {}) => {
    current();
    assertJournal(localStorage, v);
    const raw = await requestDataFlow(tenantId, actorId, `/data-flows/${step}`, {
      intent: v.intent,
      ...extra,
    });
    current();
    assertJournal(localStorage, v);
    return z.object({ data: z.unknown() }).parse(raw).data;
  };
  const acceptOperation = async (raw: unknown, v: DataFlowJournal) => {
    const value = await validateOperation(v, raw);
    setOperation(value);
    return value;
  };
  const recover = async (v: DataFlowJournal) => {
    const result = await acceptOperation(await post('recover', v), v);
    await refresh();
    return result;
  };
  const prepare = (intent: unknown) => {
    const parsed = dataFlowIntent.safeParse(intent);
    if (!parsed.success) {
      const key = parsed.error.issues[0]?.path[1];
      throw new Error(
        key === 'reason'
          ? 'Enter a review reason of at least 20 characters.'
          : key === 'sourceNote'
            ? 'Enter a source note explaining the declared or unknown metadata.'
            : 'Check the exact references, optional metadata and review validity before retaining this intent.',
      );
    }
    const v = save(
      {
        version: 1,
        tenantId,
        actorId,
        intent: parsed.data,
        challengeId: null,
        challengeExpiresAt: null,
      },
      null,
    );
    setVerified(false);
    setOperation(null);
    setSourceReviewed(false);
    setReason('');
    setAmending(null);
    return v;
  };
  const candidate = context?.systems.find((v) => v.pin.systemId === selected),
    blocked = busy || !ready,
    settled = Boolean(operation && (operation.recorded || operation.fenced));
  const prepareDecision = (
    phase: 'approve' | 'reject' | 'withdraw',
    revision: DataFlowContext['revisions'][number],
  ) =>
    void action(async (v) => {
      if (v) throw new Error('Recover the original request before another decision.');
      prepare({
        phase,
        request: {
          schemaVersion: 1,
          operationKey: crypto.randomUUID(),
          revisionId: revision.revisionId,
          expectedContentSha256: revision.contentSha256,
          reason: reason.trim(),
        },
      });
    });
  return (
    <main className="space-y-5">
      <Link href="/dashboard">Back to dashboard</Link>
      <h1 className="text-2xl font-semibold">Reviewed data flow declarations</h1>
      <p>
        Inspect human-declared processing relationships between registered systems and explicitly
        named parties. An estate manager prepares a declaration; a different owner, admin or live
        founder reviews the exact revision with an authenticator.
      </p>
      <p className="text-sm text-slate-600">
        These declarations are metadata, not observed transfers, connector permissions, execution
        approvals or compliance certification. Expiry, withdrawal or stale sources describe review
        validity; they do not prove that processing stopped. Unknown facts remain unknown.
      </p>
      <button
        className={button}
        disabled={blocked}
        onClick={() =>
          void action(async () => {
            await refresh();
          })
        }
      >
        Refresh recorded revisions
      </button>
      {error && (
        <p role="alert" className="rounded border border-red-200 bg-red-50 p-3">
          {error}
        </p>
      )}
      {!context && !error && (
        <p role="status">Loading current registered sources and declaration history…</p>
      )}
      {journal ? (
        <section className={panel}>
          <h2 className="font-semibold">Recover or confirm your retained {journal.intent.phase}</h2>
          <p className="break-all">Original operation: {journal.intent.request.operationKey}</p>
          <p>Reason: {journal.intent.request.reason}</p>
          {journal.intent.phase === 'declare' ? (
            <DeclarationDetails request={journal.intent.request} />
          ) : (
            <p className="break-all">
              Exact revision: {journal.intent.request.revisionId}; content commitment:{' '}
              {journal.intent.request.expectedContentSha256}
            </p>
          )}
          <button
            className={button}
            disabled={blocked}
            onClick={() =>
              void action(async (v) => {
                if (v) await recover(v);
              })
            }
          >
            Recover original request
          </button>
          {operation && (
            <p role="status">
              {operation.recorded
                ? `Recorded receipt ${operation.receiptId}; current revision state: ${operation.state}`
                : operation.fenced
                  ? `Original request fenced; receipt ${operation.fenceReceiptId}`
                  : 'No recorded decision confirmed. The original request remains retained.'}
            </p>
          )}
          {context?.canPrepare && (
            <>
              <button
                className={button}
                disabled={blocked || settled}
                onClick={() =>
                  void action(async (v) => {
                    if (!v) return;
                    const old = await recover(v);
                    if (old.recorded || old.fenced) return;
                    if (old.challengeExpiresAt && Date.parse(old.challengeExpiresAt) > Date.now())
                      throw new Error(
                        `An earlier challenge may still be active until ${formatDateTime(old.challengeExpiresAt)}. Recover or fence this same request; do not replace it.`,
                      );
                    if (old.challengeExpiresAt)
                      throw new Error(
                        'The original challenge expired. Fence and archive this exact request before preparing another decision; its original operation cannot receive a replacement challenge.',
                      );
                    const raw = await post('challenge', v);
                    if (dataFlowOperation.safeParse(raw).success) {
                      await acceptOperation(raw, v);
                      return;
                    }
                    const c = z
                      .object({
                        challengeId: z.uuid(),
                        expiresAt: z.iso.datetime({ offset: true }),
                      })
                      .strict()
                      .parse(raw);
                    save({ ...v, challengeId: c.challengeId, challengeExpiresAt: c.expiresAt }, v);
                    setOperation(null);
                    setVerified(false);
                  })
                }
              >
                Prepare authenticator challenge
              </button>
              {journal.challengeId && (
                <>
                  <p>Challenge expires: {formatDateTime(journal.challengeExpiresAt)}</p>
                  <label>
                    Authenticator code
                    <input
                      className={field}
                      autoComplete="one-time-code"
                      inputMode="numeric"
                      type="password"
                      maxLength={256}
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                    />
                  </label>
                  <button
                    className={button}
                    disabled={blocked || settled || !code || verified}
                    onClick={() =>
                      void action(async (v) => {
                        if (!v?.challengeId) return;
                        try {
                          const raw = await post('verify', v, { challengeId: v.challengeId, code });
                          if (dataFlowOperation.safeParse(raw).success) {
                            await acceptOperation(raw, v);
                            return;
                          }
                          const result = z
                            .object({
                              verified: z.literal(true),
                              challengeId: z.literal(v.challengeId),
                            })
                            .strict()
                            .parse(raw);
                          setVerified(result.verified);
                        } finally {
                          setCode('');
                        }
                      })
                    }
                  >
                    Verify authenticator code
                  </button>
                  <button
                    className={button}
                    disabled={blocked || settled || !verified}
                    onClick={() =>
                      void action(async (v) => {
                        if (!v?.challengeId) return;
                        try {
                          await acceptOperation(
                            await post('record', v, { challengeId: v.challengeId }),
                            v,
                          );
                          await refresh();
                        } finally {
                          setVerified(false);
                        }
                      })
                    }
                  >
                    Record original {journal.intent.phase}
                  </button>
                </>
              )}
              {journal.challengeId &&
                operation &&
                !operation.recorded &&
                !operation.fenced &&
                !verified && (
                  <div className="space-y-2">
                    <p>
                      The original decision is not recorded. If a verification or recording reply
                      was interrupted, retry the same retained challenge; the server independently
                      requires its exact satisfied MFA proof.
                    </p>
                    <button
                      className={button}
                      disabled={blocked}
                      onClick={() =>
                        void action(async (v) => {
                          if (!v?.challengeId) return;
                          await acceptOperation(
                            await post('record', v, { challengeId: v.challengeId }),
                            v,
                          );
                          await refresh();
                        })
                      }
                    >
                      Retry original recording with retained challenge
                    </button>
                  </div>
                )}
              <button
                className={button}
                disabled={blocked || settled}
                onClick={() =>
                  void action(async (v) => {
                    if (v) {
                      await acceptOperation(await post('fence', v), v);
                      await refresh();
                    }
                  })
                }
              >
                Fence original request against later recording
              </button>
            </>
          )}
          {operation && (operation.recorded || operation.fenced) && (
            <button
              className={button}
              disabled={blocked}
              onClick={() =>
                void action(async (v) => {
                  if (!v) return;
                  const proof = await recover(v);
                  await archiveConfirmed(localStorage, v, proof);
                  observed.current = null;
                  setJournal(null);
                  setOperation(null);
                  setVerified(false);
                  setCode('');
                })
              }
            >
              Archive confirmed receipt and prepare another decision
            </button>
          )}
        </section>
      ) : context ? (
        <section className={panel}>
          <h2 className="font-semibold">
            {!context.canPrepare
              ? 'Read-only declaration access'
              : amending
                ? 'Prepare a new immutable version'
                : 'Prepare an explicit declaration'}
          </h2>
          {amending && (
            <p className="break-all">
              Current head revision: {amending.revisionId}. A new version requires another
              independent review; history remains retained.
            </p>
          )}
          {!context.canPrepare ? (
            <p>
              Your current role can inspect declaration history. Preparation and independent review
              are available to existing estate managers only.
            </p>
          ) : (
            <>
              <label>
                Origin system
                <select
                  aria-label="Origin system"
                  className={field}
                  value={selected}
                  onChange={(e) => setSelected(e.target.value)}
                >
                  <option value="">Choose a registered system</option>
                  {context.systems.map((v) => (
                    <option key={v.pin.systemId} value={v.pin.systemId}>
                      {v.name} · version {v.pin.version}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Declared destination
                <select
                  aria-label="Declared destination"
                  className={field}
                  value={destination}
                  onChange={(e) => setDestination(e.target.value)}
                >
                  <option value="unknown">Explicitly unknown</option>
                  <option value="new-party">New declared party</option>
                  {context.parties.map((v) => (
                    <option key={v.declaration.partyRef} value={'party:' + v.declaration.partyRef}>
                      {v.declaration.label} · {v.declaration.role}
                    </option>
                  ))}
                  {context.systems
                    .filter((v) => v.pin.systemId !== selected)
                    .map((v) => (
                      <option key={v.pin.systemId} value={'system:' + v.pin.systemId}>
                        {v.name} · registered system
                      </option>
                    ))}
                </select>
              </label>
              {destination === 'new-party' && (
                <label>
                  Declared party label (organization only; no contacts or personal data)
                  <input
                    className={field}
                    maxLength={200}
                    value={partyLabel}
                    onChange={(e) => setPartyLabel(e.target.value)}
                  />
                </label>
              )}
              {destination === 'new-party' && (
                <>
                  <label>
                    Declared party role
                    <select
                      aria-label="Declared party role"
                      className={field}
                      value={partyRole}
                      onChange={(e) =>
                        setPartyRole(e.target.value === 'recipient' ? 'recipient' : 'processor')
                      }
                    >
                      <option value="processor">Processor</option>
                      <option value="recipient">Recipient</option>
                    </select>
                  </label>
                  <label>
                    Explicit party reference being superseded, if any
                    <select
                      aria-label="Explicit party reference being superseded, if any"
                      className={field}
                      value={supersedesParty}
                      onChange={(e) => setSupersedesParty(e.target.value)}
                    >
                      <option value="">No superseded reference</option>
                      {context.parties.map((p) => (
                        <option key={p.declaration.partyRef} value={p.declaration.partyRef}>
                          {p.declaration.label} · {p.declaration.partyRef}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              )}
              {(destination === 'new-party' || destination.startsWith('party:')) && (
                <label>
                  Actual registered destination system, if explicitly known
                  <select
                    aria-label="Actual registered destination system, if explicitly known"
                    className={field}
                    value={partySystem}
                    onChange={(e) => setPartySystem(e.target.value)}
                  >
                    <option value="">Unknown / not linked</option>
                    {context.systems
                      .filter((x) => x.pin.systemId !== selected)
                      .map((x) => (
                        <option key={x.pin.systemId} value={x.pin.systemId}>
                          {x.name} · version {x.pin.version}
                        </option>
                      ))}
                  </select>
                </label>
              )}
              <label>
                Purpose, if known
                <input
                  className={field}
                  maxLength={2000}
                  value={purpose}
                  onChange={(e) => setPurpose(e.target.value)}
                />
              </label>
              <label>
                Source note / reason for unknown destination
                <textarea
                  className={field}
                  maxLength={2000}
                  value={sourceNote}
                  onChange={(e) => setSourceNote(e.target.value)}
                />
              </label>
              <p>
                Declare facts only when established by your source. Empty optional text means
                unknown. Enter metadata categories and organization references only, never personal
                values, contacts, credentials or endpoints.
              </p>
              <label>
                Data category knowledge
                <select
                  aria-label="Data category knowledge"
                  className={field}
                  value={categoryState}
                  onChange={(e) => setCategoryState(e.target.value)}
                >
                  <option value="unknown">Unknown</option>
                  <option value="none">Explicitly none</option>
                  <option value="known">Declared categories</option>
                </select>
              </label>
              {categoryState === 'known' && (
                <label>
                  Declared categories (comma-separated)
                  <input
                    className={field}
                    maxLength={4000}
                    value={categories}
                    onChange={(e) => setCategories(e.target.value)}
                  />
                </label>
              )}
              <label>
                Origin country (two-letter uppercase code, if known)
                <input
                  className={field}
                  maxLength={2}
                  value={originCountry}
                  onChange={(e) => setOriginCountry(e.target.value)}
                />
              </label>
              <label>
                Destination country knowledge
                <select
                  aria-label="Destination country knowledge"
                  className={field}
                  value={countryState}
                  onChange={(e) => setCountryState(e.target.value)}
                >
                  <option value="unknown">Unknown</option>
                  <option value="none">Explicitly none</option>
                  <option value="known">Declared countries</option>
                </select>
              </label>
              {countryState === 'known' && (
                <label>
                  Destination countries (comma-separated uppercase two-letter codes)
                  <input
                    className={field}
                    maxLength={200}
                    value={countries}
                    onChange={(e) => setCountries(e.target.value)}
                  />
                </label>
              )}
              <label>
                Declared cross-border processing
                <select
                  aria-label="Declared cross-border processing"
                  className={field}
                  value={crossBorder}
                  onChange={(e) => setCrossBorder(e.target.value)}
                >
                  <option value="unknown">Unknown</option>
                  <option value="yes">Declared yes</option>
                  <option value="no">Declared no</option>
                </select>
              </label>
              <label>
                Transfer safeguards, if known
                <textarea
                  className={field}
                  maxLength={2000}
                  value={safeguards}
                  onChange={(e) => setSafeguards(e.target.value)}
                />
              </label>
              <label>
                Exact retained RoPA record reference, if used
                <input
                  className={field}
                  maxLength={36}
                  value={ropaRef}
                  onChange={(e) => setRopaRef(e.target.value)}
                />
              </label>
              <p>
                The server checks an optional RoPA reference in this organization; no free-text
                system or processor matching is performed.
              </p>
              <label>
                Review validity in days (1–365)
                <input
                  className={field}
                  type="number"
                  min={1}
                  max={365}
                  value={validDays}
                  onChange={(e) => setValidDays(e.target.value)}
                />
              </label>
              <label>
                Reason for recording
                <textarea
                  className={field}
                  maxLength={2000}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={sourceReviewed}
                  onChange={(e) => setSourceReviewed(e.target.checked)}
                />{' '}
                I reviewed the selected registered sources and will record only non-personal
                metadata.
              </label>
              <button
                className={button}
                disabled={blocked || !candidate || !sourceReviewed}
                onClick={() =>
                  void action(async (v) => {
                    if (v) throw Error('Recover the original request first.');
                    if (!candidate) throw Error('Choose a current registered origin.');
                    const days = Number(validDays);
                    if (!Number.isInteger(days) || days < 1 || days > 365)
                      throw Error('Choose a review validity of 1–365 days.');
                    const target = destination.startsWith('system:')
                      ? context.systems.find((x) => x.pin.systemId === destination.slice(7))
                      : null;
                    const party = destination.startsWith('party:')
                      ? context.parties.find((x) => x.declaration.partyRef === destination.slice(6))
                      : null;
                    const dest =
                      destination === 'unknown'
                        ? { kind: 'unknown', reason: sourceNote.trim() }
                        : destination === 'new-party'
                          ? {
                              kind: 'party',
                              party: {
                                kind: 'new',
                                declaration: {
                                  partyRef: crypto.randomUUID(),
                                  label: partyLabel.trim(),
                                  role: partyRole,
                                  supersedesPartyRef: supersedesParty || null,
                                },
                              },
                              system:
                                context.systems.find((x) => x.pin.systemId === partySystem)?.pin ??
                                null,
                            }
                          : target
                            ? { kind: 'system', system: target.pin }
                            : party
                              ? {
                                  kind: 'party',
                                  party: {
                                    kind: 'existing',
                                    partyRef: party.declaration.partyRef,
                                    contentSha256: party.contentSha256,
                                  },
                                  system:
                                    context.systems.find((x) => x.pin.systemId === partySystem)
                                      ?.pin ?? null,
                                }
                              : null;
                    if (!dest) throw Error('Selected destination is unavailable. Refresh first.');
                    prepare({
                      phase: 'declare',
                      request: {
                        schemaVersion: 1,
                        operationKey: crypto.randomUUID(),
                        flowId: amending?.flowId ?? crypto.randomUUID(),
                        previousRevisionId: amending?.revisionId ?? null,
                        origin: candidate.pin,
                        destination: dest,
                        purpose: purpose.trim() || null,
                        dataCategories:
                          categoryState === 'unknown'
                            ? null
                            : categoryState === 'none'
                              ? []
                              : categories.split(',').map((v) => v.trim()),
                        originCountry: originCountry.trim() || null,
                        destinationCountries:
                          countryState === 'unknown'
                            ? null
                            : countryState === 'none'
                              ? []
                              : countries.split(',').map((v) => v.trim()),
                        crossBorder: crossBorder === 'unknown' ? null : crossBorder === 'yes',
                        transferSafeguards: safeguards.trim() || null,
                        sourceRopaId: ropaRef.trim() || null,
                        sourceNote: sourceNote.trim(),
                        validUntil: new Date(Date.now() + days * 86400000).toISOString(),
                        reason: reason.trim(),
                      },
                    });
                  })
                }
              >
                Retain declaration for authenticator review
              </button>
            </>
          )}
        </section>
      ) : null}
      {context && (
        <section className={panel}>
          <h2 className="font-semibold">Declared relationship graph</h2>
          <p>
            Only reviewed-current declarations appear here. These arrows show human statements, not
            observed processing or access grants. Other revisions remain in history below.
          </p>
          <DeclaredGraph context={context} tenantId={tenantId} actorId={actorId} />
          <label>
            Inspect an older exact revision reference
            <input
              className={field}
              value={historyRevision}
              onChange={(e) => setHistoryRevision(e.target.value)}
            />
          </label>
          {z.uuid().safeParse(historyRevision).success && (
            <Link href={'/datamap/flows/' + historyRevision}>Inspect immutable revision</Link>
          )}
        </section>
      )}
      {context && (
        <section className={panel}>
          <h2 className="font-semibold">Recorded declaration history</h2>
          {context.historyHasMore && (
            <p>
              Showing the latest 100 revisions. Older immutable revisions remain available by their
              exact revision reference.
            </p>
          )}
          {!context.revisions.length && (
            <p>No retained declarations are visible for this organization.</p>
          )}
          {context.revisions.map((r) => (
            <article key={r.revisionId} id={r.revisionId} className="space-y-2 border-t py-3">
              <h3 className="font-semibold">
                Version {r.version} · {r.state}
              </h3>
              <p className="break-all">
                Revision {r.revisionId}; declaration receipt {r.declarationReceiptId}
                {r.reviewReceiptId ? '; review receipt ' + r.reviewReceiptId : ''}
                {r.withdrawalReceiptId ? '; withdrawal receipt ' + r.withdrawalReceiptId : ''}
              </p>
              <p>
                Created {formatDateTime(r.createdAt)}; review validity until{' '}
                {formatDateTime(r.request.validUntil)}.
              </p>
              {r.state === 'superseded' && (
                <p>
                  A newer retained revision supersedes this prior review. The prior approval and
                  source remain in immutable history. The current declared relationship is
                  unresolved until its latest version is independently approved; this does not prove
                  that processing stopped.
                </p>
              )}
              <DeclarationDetails request={r.request} />
              {context.canPrepare && r.isHead && !journal && (
                <button
                  className={button}
                  disabled={blocked}
                  onClick={() => {
                    setAmending(r);
                    setSelected(r.request.origin.systemId);
                    setPurpose(r.request.purpose ?? '');
                    setSourceNote(r.request.sourceNote);
                    setOriginCountry(r.request.originCountry ?? '');
                    setCrossBorder(
                      r.request.crossBorder === null
                        ? 'unknown'
                        : r.request.crossBorder
                          ? 'yes'
                          : 'no',
                    );
                    setSafeguards(r.request.transferSafeguards ?? '');
                    setRopaRef(r.request.sourceRopaId ?? '');
                    setCategoryState(
                      r.request.dataCategories === null
                        ? 'unknown'
                        : r.request.dataCategories.length
                          ? 'known'
                          : 'none',
                    );
                    setCategories(r.request.dataCategories?.join(', ') ?? '');
                    setCountryState(
                      r.request.destinationCountries === null
                        ? 'unknown'
                        : r.request.destinationCountries.length
                          ? 'known'
                          : 'none',
                    );
                    setCountries(r.request.destinationCountries?.join(', ') ?? '');
                    setSourceReviewed(false);
                    setReason('');
                    const d = r.request.destination;
                    if (d.kind === 'unknown') {
                      setDestination('unknown');
                      setPartySystem('');
                    } else if (d.kind === 'system') {
                      setDestination('system:' + d.system.systemId);
                      setPartySystem('');
                    } else {
                      setPartySystem(d.system?.systemId ?? '');
                      const ref =
                        d.party.kind === 'new' ? d.party.declaration.partyRef : d.party.partyRef;
                      const current = context.parties.find((p) => p.declaration.partyRef === ref);
                      if (current) setDestination('party:' + ref);
                      else if (d.party.kind === 'new') {
                        setDestination('new-party');
                        setPartyLabel(d.party.declaration.label);
                        setPartyRole(d.party.declaration.role);
                        setSupersedesParty(d.party.declaration.supersedesPartyRef ?? '');
                      } else setDestination('unknown');
                    }
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                  }}
                >
                  Prepare a new version of this declaration
                </button>
              )}

              {context.canReview && !journal && (
                <>
                  {r.state === 'proposed' && r.preparerId !== actorId && (
                    <>
                      <label>
                        Review reason
                        <textarea
                          className={field}
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                        />
                      </label>
                      <button
                        className={button}
                        disabled={blocked}
                        onClick={() => prepareDecision('approve', r)}
                      >
                        Prepare independent approval
                      </button>
                      <button
                        className={button}
                        disabled={blocked}
                        onClick={() => prepareDecision('reject', r)}
                      >
                        Prepare rejection
                      </button>
                    </>
                  )}
                  {!['withdrawn'].includes(r.state) && (
                    <>
                      <label>
                        Withdrawal reason
                        <textarea
                          className={field}
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                        />
                      </label>
                      <button
                        className={button}
                        disabled={blocked}
                        onClick={() => prepareDecision('withdraw', r)}
                      >
                        Prepare metadata withdrawal
                      </button>
                    </>
                  )}
                </>
              )}
            </article>
          ))}
        </section>
      )}
    </main>
  );
}
function DeclarationDetails({
  request: q,
}: {
  request: DataFlowContext['revisions'][number]['request'];
}) {
  const destination =
    q.destination.kind === 'unknown'
      ? 'Unknown: ' + q.destination.reason
      : q.destination.kind === 'system'
        ? 'Registered system ' + q.destination.system.systemId
        : q.destination.party.kind === 'new'
          ? 'Declared ' +
            q.destination.party.declaration.role +
            ': ' +
            q.destination.party.declaration.label
          : 'Declared party reference ' + q.destination.party.partyRef;
  return (
    <dl className="grid gap-2 text-sm sm:grid-cols-2">
      {Object.entries({
        'Origin system': q.origin.systemId,
        'Origin version': q.origin.version,
        Destination: destination,
        Purpose: q.purpose ?? 'Unknown',
        'Data categories':
          q.dataCategories === null ? 'Unknown' : q.dataCategories.join(', ') || 'Explicitly none',
        'Origin country': q.originCountry ?? 'Unknown',
        'Destination countries':
          q.destinationCountries === null
            ? 'Unknown'
            : q.destinationCountries.join(', ') || 'Explicitly none',
        'Cross-border':
          q.crossBorder === null ? 'Unknown' : q.crossBorder ? 'Declared yes' : 'Declared no',
        Safeguards: q.transferSafeguards ?? 'Unknown',
        'Source note': q.sourceNote,
      }).map(([k, v]) => (
        <div key={k}>
          <dt className="font-medium">{k}</dt>
          <dd className="break-all">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function DeclaredGraph({
  context,
  tenantId,
  actorId,
}: {
  context: DataFlowContext;
  tenantId: string;
  actorId: string;
}) {
  const [clock, setClock] = useState(() => new Date());
  useEffect(() => {
    const future = context.revisions
      .map((r) => Date.parse(r.request.validUntil))
      .filter((x) => x > clock.getTime());
    if (!future.length) return;
    const timer = window.setTimeout(
      () => setClock(new Date()),
      Math.max(1, Math.min(Math.min(...future) - Date.now() + 1, 2147483647)),
    );
    return () => window.clearTimeout(timer);
  }, [context, clock]);
  const graph = projectDeclaredFlows(context, tenantId, actorId, clock);
  return (
    <>
      {graph.excluded > 0 && (
        <p>
          {graph.excluded} historical, unresolved or no-longer-current revisions are excluded from
          current arrows. Inspect their retained reasons below; absence of an arrow does not prove
          that a transfer stopped.
        </p>
      )}
      {!graph.edges.length && (
        <p>No reviewed-current declared relationships are available in this bounded view.</p>
      )}
      {graph.edges.map((e) => (
        <div key={e.id} className="rounded border p-3">
          <p>
            {graph.nodes.find((n) => n.id === e.from)?.label}{' '}
            <span aria-label="declared relationship">→</span>{' '}
            {graph.nodes.find((n) => n.id === e.to)?.label}
          </p>
          <p>
            {e.label}; review receipt {e.receiptId}; valid until{' '}
            {formatDateTime(e.reviewValidUntil)}
          </p>
          <Link href={e.href}>Inspect reviewed declaration and history</Link>
        </div>
      ))}
    </>
  );
}
