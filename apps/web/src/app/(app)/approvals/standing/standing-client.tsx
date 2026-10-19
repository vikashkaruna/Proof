'use client';
import Link from 'next/link';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { z } from 'zod';
import {
  standingPolicyContext,
  standingRevisionIntent,
  standingRevisionOperation,
  type StandingMeasuredSource,
  type StandingPolicyContext,
} from '@axiom/types';
import { formatDateTime } from '@/lib/display-time';
import {
  archiveConfirmed,
  validateOperation,
  assertJournal,
  journalText,
  locked,
  readJournal,
  writeJournal,
  type StandingJournal,
} from './standing-journal';
import { requestStanding } from './standing-transport';
const panel = 'space-y-3 rounded-xl border border-slate-200 bg-white p-5';
const button = 'rounded-md bg-[#1E2A4A] px-3 py-2 text-sm text-white disabled:opacity-40';
const field = 'block w-full rounded-md border border-slate-300 p-2';
type Operation = z.infer<typeof standingRevisionOperation>;
function MeasuredScope({ source }: { source: StandingMeasuredSource }) {
  return (
    <dl className="grid gap-2 text-sm sm:grid-cols-2">
      {Object.entries({
        Action: 'Enable audit logging',
        Environment: source.environment,
        Plan: source.planId,
        'Plan version': source.planVersion,
        'Action ID': source.actionId,
        Connector: source.connectorId,
        'Fixture / target': `${source.fixtureId} / ${source.resourceId}`,
        'Named operator': source.nominatedOperatorId,
        'Custody epoch': source.custodyEpoch,
        'Dry-run valid until': formatDateTime(source.dryRunExpiresAt),
        'Deployment valid until': formatDateTime(source.deploymentExpiresAt),
        'Policy valid until': formatDateTime(source.policyExpiresAt),
      }).map(([k, v]) => (
        <div key={k}>
          <dt className="font-medium text-slate-600">{k}</dt>
          <dd className="break-all">{v}</dd>
        </div>
      ))}
      <div className="sm:col-span-2">
        <dt className="font-medium">Measured source commitments</dt>
        <dd>
          <details>
            <summary>Inspect immutable content, engine, snapshot and rollback hashes</summary>
            <ul className="space-y-1 font-mono text-xs">
              {Object.entries({
                content: source.contentDigest,
                engine: source.engineSha256,
                capability: source.capabilitySha256,
                snapshot: source.snapshotSha256,
                rollback: source.rollbackSha256,
                roundtrip: source.roundtripSha256,
              }).map(([k, v]) => (
                <li key={k} className="break-all">
                  {k}: {v}
                </li>
              ))}
            </ul>
          </details>
        </dd>
      </div>
    </dl>
  );
}
export function StandingApprovalClient({
  tenantId,
  actorId,
}: {
  tenantId: string;
  actorId: string;
}) {
  const scope = `${tenantId}:${actorId}`,
    active = useRef<string | null>(scope),
    inFlight = useRef(false),
    observed = useRef<string | null>(null);
  const [context, setContext] = useState<StandingPolicyContext | null>(null),
    [journal, setJournal] = useState<StandingJournal | null>(null),
    [operation, setOperation] = useState<Operation | null>(null);
  const [busy, setBusy] = useState(false),
    [ready, setReady] = useState(false),
    [error, setError] = useState(''),
    [reason, setReason] = useState(''),
    [selected, setSelected] = useState(''),
    [minutes, setMinutes] = useState('15'),
    [sourceReviewed, setSourceReviewed] = useState(false),
    [reviewedRevision, setReviewedRevision] = useState(''),
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
    const raw = await requestStanding(tenantId, actorId, '/standing-approvals');
    current();
    const v = standingPolicyContext.parse(z.object({ data: z.unknown() }).parse(raw).data);
    if (v.tenantId !== tenantId || v.actorId !== actorId)
      throw new Error('Current account or organization could not be confirmed.');
    setContext(v);
  };
  useEffect(() => {
    let live = true;
    void locked(tenantId, actorId, async () => {
      const v = readJournal(localStorage, tenantId, actorId);
      if (live) {
        observed.current = v ? journalText(v) : null;
        setJournal(v);
      }
      await refresh();
      if (live) setReady(true);
    }).catch((e) => {
      if (live) setError(e instanceof Error ? e.message : 'Standing approval unavailable.');
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
  const action = async (run: (v: StandingJournal | null) => Promise<void>) => {
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
          e instanceof Error
            ? e.message
            : 'Outcome uncertain. Preserve and recover the original request.',
        );
    } finally {
      inFlight.current = false;
      if (active.current === scope) setBusy(false);
    }
  };
  const save = (v: StandingJournal, old: StandingJournal | null) => {
    const saved = writeJournal(localStorage, v, old);
    observed.current = journalText(saved);
    setJournal(saved);
    return saved;
  };
  const post = async (step: string, v: StandingJournal, extra: Record<string, string> = {}) => {
    current();
    assertJournal(localStorage, v);
    const raw = await requestStanding(tenantId, actorId, `/standing-approvals/${step}`, {
      intent: v.intent,
      ...extra,
    });
    current();
    assertJournal(localStorage, v);
    return z.object({ data: z.unknown() }).parse(raw).data;
  };
  const acceptOperation = async (raw: unknown, v: StandingJournal) => {
    const value = await validateOperation(v, raw);
    setOperation(value);
    return value;
  };
  const recover = async (v: StandingJournal) => {
    const result = await acceptOperation(await post('recover', v), v);
    await refresh();
    return result;
  };
  const prepare = (intent: unknown) => {
    const v = save(
      {
        version: 1,
        tenantId,
        actorId,
        intent: standingRevisionIntent.parse(intent),
        challengeId: null,
        challengeExpiresAt: null,
      },
      null,
    );
    setVerified(false);
    setOperation(null);
    setSourceReviewed(false);
    setReason('');
    return v;
  };
  const candidate = context?.candidates[Number(selected)],
    blocked = busy || !ready,
    settled = Boolean(operation && (operation.recorded || operation.fenced));
  const prepareDecision = (
    phase: 'approve' | 'revoke',
    revision: StandingPolicyContext['revisions'][number],
  ) =>
    void action(async (v) => {
      if (v) throw new Error('Recover the original request before another decision.');
      prepare({
        phase,
        request: {
          schemaVersion: 1,
          operationKey: crypto.randomUUID(),
          revisionId: revision.revisionId,
          requestSha256: revision.requestSha256,
          reason: reason.trim(),
        },
      });
    });
  return (
    <main className="space-y-5">
      <Link href="/approval">Back to approval queue</Link>
      <h1 className="text-2xl font-semibold">Standing approval delegation</h1>
      <p>
        Delegate one measured audit-log approval in a local synthetic target. The owner requests an
        exact scope; its named independent reviewer approves it with an authenticator. The
        coordinator may issue one approval after rechecking authority. Execution remains a separate
        approved step.
      </p>
      <p className="text-sm text-slate-600">
        No automatic execution or reassessment, hosted-provider use, or compliance certification is
        established here. An issued approval does not prove a target change.
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
      {!context && !error && <p role="status">Loading eligible policy scopes…</p>}
      {journal ? (
        <section className={panel}>
          <h2 className="font-semibold">Recover or confirm your retained {journal.intent.phase}</h2>
          <p className="break-all">Original operation: {journal.intent.request.operationKey}</p>
          <p>Reason: {journal.intent.request.reason}</p>
          {journal.intent.phase === 'request' ? (
            <>
              <MeasuredScope source={journal.intent.request.source} />
              <p>
                Delegation expires: {formatDateTime(journal.intent.request.expiresAt)}. One
                authorization, concurrency one, stop on failure.
              </p>
              <p className="break-all">
                Named reviewer account: {journal.intent.request.reviewerId}
              </p>
            </>
          ) : (
            <p className="break-all">
              Exact revision: {journal.intent.request.revisionId}; request commitment:{' '}
              {journal.intent.request.requestSha256}
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
                const raw = await post('challenge', v);
                if (standingRevisionOperation.safeParse(raw).success) {
                  await acceptOperation(raw, v);
                  return;
                }
                const c = z
                  .object({ challengeId: z.uuid(), expiresAt: z.iso.datetime({ offset: true }) })
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
                      if (standingRevisionOperation.safeParse(raw).success) {
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
                  The original decision is not recorded. If a verification or recording reply was
                  interrupted, retry the same retained challenge; the server independently requires
                  its exact satisfied MFA proof.
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
      ) : (
        <>
          <section className={panel}>
            <h2 className="font-semibold">1. Owner: select an eligible measured scope</h2>
            {context?.candidates.length === 0 ? (
              <p>
                No eligible current scope is available to this account. Prepare a recorded synthetic
                target plan with a measured dry-run and rollback, an active owner policy and its
                independent named reviewer first. <Link href="/plans">Inspect source plans</Link>.
              </p>
            ) : (
              <>
                <label>
                  Eligible policy and source plan
                  <select
                    className={field}
                    value={selected}
                    disabled={blocked}
                    onChange={(e) => {
                      setSelected(e.target.value);
                      setSourceReviewed(false);
                    }}
                  >
                    <option value="">Choose a server-verified scope</option>
                    {context?.candidates.map((c, i) => (
                      <option key={`${c.source.policyId}:${c.source.planId}`} value={i}>
                        {c.policyName} · plan {c.source.planId.slice(0, 8)}
                      </option>
                    ))}
                  </select>
                </label>
                {selected !== '' && candidate && (
                  <>
                    <MeasuredScope source={candidate.source} />
                    <p className="break-all">Named reviewer account: {candidate.reviewerId}</p>
                    <label>
                      Maximum delegation duration
                      <select
                        className={field}
                        value={minutes}
                        onChange={(e) => setMinutes(e.target.value)}
                      >
                        {[5, 15, 30, 60].map((m) => (
                          <option key={m} value={m}>
                            {m} minutes, bounded by all source expiries
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={sourceReviewed}
                        onChange={(e) => setSourceReviewed(e.target.checked)}
                      />{' '}
                      I reviewed this exact measured scope, named reviewer and one-authorization
                      limit.
                    </label>
                  </>
                )}
              </>
            )}
          </section>
          <label>
            Decision reason (20–2,000 characters)
            <textarea
              className={field}
              maxLength={2000}
              value={reason}
              disabled={blocked}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          {selected !== '' && candidate && candidate.ownerId === actorId && (
            <button
              className={button}
              disabled={blocked || !sourceReviewed || reason.trim().length < 20}
              onClick={() =>
                void action(async (v) => {
                  if (v) throw new Error('An original request is already retained.');
                  const expiresAt = new Date(
                    Math.min(
                      Date.parse(context!.checkedAt) + Number(minutes) * 60000,
                      Date.parse(candidate.source.policyExpiresAt),
                      Date.parse(candidate.source.deploymentExpiresAt),
                      Date.parse(candidate.source.dryRunExpiresAt),
                    ),
                  ).toISOString();
                  if (Date.parse(expiresAt) <= Date.now())
                    throw new Error(
                      'The measured scope expired. Refresh recorded revisions before preparing a request.',
                    );
                  prepare({
                    phase: 'request',
                    request: {
                      schemaVersion: 1,
                      operationKey: crypto.randomUUID(),
                      tenantId,
                      ownerId: candidate.ownerId,
                      reviewerId: candidate.reviewerId,
                      previousRevisionId: candidate.previousRevisionId,
                      source: candidate.source,
                      expiresAt,
                      maxAuthorizations: 1,
                      mode: 'individual',
                      concurrency: 1,
                      stopOnFailure: true,
                      reason: reason.trim(),
                    },
                  });
                })
              }
            >
              Retain owner delegation request
            </button>
          )}
          <section className={panel}>
            <h2 className="font-semibold">2. Named reviewer: inspect recorded revisions</h2>
            {context?.revisions.length === 0 && (
              <p>No recorded revision is available to this account.</p>
            )}
            {context?.revisions.map((r) => (
              <article key={r.revisionId} className="space-y-3 border-t py-4">
                <h3 className="font-medium break-all">Revision {r.revisionId}</h3>
                <p>
                  Recorded state: {r.state}; expires {formatDateTime(r.request.expiresAt)}
                </p>
                <p>{r.request.reason}</p>
                <p className="text-sm text-slate-600">
                  {r.state === 'issued'
                    ? 'An approval token was issued. This does not establish execution or a target change.'
                    : r.state === 'sealed'
                      ? 'Human delegation sealed; technical approval issuance is still separate.'
                      : r.state === 'unconfirmed'
                        ? 'Authority or issuance requires reconciliation. Preserve the original history.'
                        : 'Only the recorded revision state is established; execution remains separate.'}
                </p>
                <MeasuredScope source={r.request.source} />
                <p className="break-all">
                  Owner: {r.request.ownerId}; named reviewer: {r.request.reviewerId}. Owner receipt{' '}
                  {r.ownerReceiptId}; reviewer receipt {r.reviewerReceiptId ?? 'not recorded'}.
                </p>
                <p className="break-all font-mono text-xs">Request commitment: {r.requestSha256}</p>
                {r.request.reviewerId === actorId && r.state === 'requested' && (
                  <label>
                    <input
                      type="checkbox"
                      checked={reviewedRevision === r.requestSha256}
                      onChange={(e) => setReviewedRevision(e.target.checked ? r.requestSha256 : '')}
                    />{' '}
                    I reviewed this exact revision and measured scope.
                  </label>
                )}
                {r.request.reviewerId === actorId &&
                  r.state === 'requested' &&
                  Date.parse(r.request.expiresAt) > Date.parse(context.checkedAt) && (
                    <button
                      className={button}
                      disabled={
                        blocked || reviewedRevision !== r.requestSha256 || reason.trim().length < 20
                      }
                      onClick={() => prepareDecision('approve', r)}
                    >
                      Retain approval of revision {r.revisionId.slice(0, 8)}
                    </button>
                  )}
                {[r.request.ownerId, r.request.reviewerId].includes(actorId) &&
                  !['revoked', 'expired'].includes(r.state) && (
                    <button
                      className={button}
                      disabled={blocked || reason.trim().length < 20}
                      onClick={() => prepareDecision('revoke', r)}
                    >
                      Retain revocation of revision {r.revisionId.slice(0, 8)}
                    </button>
                  )}
              </article>
            ))}
          </section>
        </>
      )}
    </main>
  );
}
