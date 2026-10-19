'use client';
import Link from 'next/link';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { coverageScopeContext, coverageScopeIntent, coverageScopeOperation } from '@axiom/types';
import { formatDateTime } from '@/lib/display-time';
import {
  archiveConfirmed,
  validateOperation,
  assertJournal,
  journalText,
  journalKey,
  locked,
  readJournal,
  writeJournal,
  type CoverageJournal,
} from './coverage-journal';
import { requestCoverage } from './coverage-transport';
const panel = 'space-y-3 rounded-xl border border-slate-200 bg-white p-5';
const button = 'rounded-md bg-[#1E2A4A] px-3 py-2 text-sm text-white disabled:opacity-40';
const field = 'block w-full rounded-md border border-slate-300 p-2';
type Context = z.infer<typeof coverageScopeContext>;
type Operation = z.infer<typeof coverageScopeOperation>;
function SourceSummary({ source }: { source: Context['candidates'][number]['source'] }) {
  const labels = {
    Schedule: source.scheduleId,
    'Read scope': source.readScopeId,
    Estate: source.estateId,
    Connector: source.connectorId,
    'Recorded baseline run': source.baselineRunId,
    'Reviewed discovery': source.preflightDiscoveryId,
    'Catalogue version': source.catalogue.libraryVersion,
    Cadence: source.cadence,
    'Custody epoch': source.custodyEpoch,
  };
  return (
    <>
      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        {Object.entries(labels).map(([label, value]) => (
          <div key={label}>
            <dt className="font-medium text-slate-600">{label}</dt>
            <dd className="break-all">{value}</dd>
          </div>
        ))}
      </dl>
      <details>
        <summary>Inspect exact source commitments and authority references</summary>
        <dl className="space-y-2 text-xs">
          {Object.entries({
            Grant: source.grantId,
            Workload: source.workloadId,
            'Custody policy': source.custodyPolicyId,
            'Custody activation': source.custodyActivationEventId,
            'Configuration hash': source.configurationSha256,
            'Baseline result hash': source.baselineResultSha256,
            'Discovery fire': source.preflightFireId,
            'Discovery request': source.preflightDiscoveryRequestId,
            'Discovery result hash': source.preflightResultSha256,
            'Policy hash': source.custodyPolicySha256,
            'Key policy hash': source.keyPolicySha256,
            'Deployment binding hash': source.deploymentBindingSha256,
            'Catalogue rows hash': source.catalogue.rowsSha256,
            'Questionnaire digest': source.catalogue.questionnaireDigest,
            'Manifest hash': source.catalogue.manifestSha256,
            'Catalogue selection':
              source.catalogue.selectionOperationKey ?? 'Default recorded selection',
          }).map(([label, value]) => (
            <div key={label}>
              <dt className="font-medium">{label}</dt>
              <dd className="break-all font-mono">{value}</dd>
            </div>
          ))}
        </dl>
      </details>
    </>
  );
}
export function CoverageClient({ tenantId, actorId }: { tenantId: string; actorId: string }) {
  const scope = `${tenantId}:${actorId}`,
    active = useRef<string | null>(scope),
    inFlight = useRef(false),
    observed = useRef<string | null>(null);
  const [context, setContext] = useState<Context | null>(null),
    [journal, setJournal] = useState<CoverageJournal | null>(null),
    [operation, setOperation] = useState<Operation | null>(null);
  const [busy, setBusy] = useState(false),
    [ready, setReady] = useState(false),
    [error, setError] = useState(''),
    [reason, setReason] = useState(''),
    [selected, setSelected] = useState(''),
    [minutes, setMinutes] = useState('15'),
    [sourceReviewed, setSourceReviewed] = useState(false),
    [maxFires, setMaxFires] = useState('1'),
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
    setContext(null);
    const raw = await requestCoverage(tenantId, actorId, '/scheduled-coverage');
    current();
    const v = coverageScopeContext.parse(z.object({ data: z.unknown() }).parse(raw).data);
    if (v.tenantId !== tenantId || v.actorId !== actorId)
      throw new Error('Current account or organization could not be confirmed.');
    if (
      v.scopes.some(
        (s) => s.request.tenantId !== tenantId || s.scopeId !== s.request.operationKey,
      ) ||
      v.fires.some((f) => f.tenantId !== tenantId)
    )
      throw new Error(
        'Recorded scope or fire references have a different organization or source binding.',
      );
    setContext(v);
    setSelected('');
    setSourceReviewed(false);
  };
  useEffect(() => {
    let live = true;
    void locked(tenantId, actorId, async () => {
      const v = readJournal(localStorage, tenantId, actorId);
      if (live) {
        observed.current = v ? journalText(v) : null;
        setJournal(v);
        setReady(true);
      }
      await refresh();
      if (live) setReady(true);
    }).catch((e) => {
      if (live) setError(e instanceof Error ? e.message : 'Scheduled assessment unavailable.');
    });
    const change = (event: StorageEvent) => {
      if (event.key !== null && event.key !== journalKey(tenantId, actorId)) return;
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
  const action = async (run: (v: CoverageJournal | null) => Promise<void>) => {
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
  const save = (v: CoverageJournal, old: CoverageJournal | null) => {
    const saved = writeJournal(localStorage, v, old);
    observed.current = journalText(saved);
    setJournal(saved);
    return saved;
  };
  const post = async (step: string, v: CoverageJournal, extra: Record<string, string> = {}) => {
    current();
    assertJournal(localStorage, v);
    const raw = await requestCoverage(tenantId, actorId, `/scheduled-coverage/${step}`, {
      intent: v.intent,
      ...extra,
    });
    current();
    assertJournal(localStorage, v);
    return z.object({ data: z.unknown() }).parse(raw).data;
  };
  const acceptOperation = async (raw: unknown, v: CoverageJournal) => {
    const value = await validateOperation(v, raw);
    current();
    assertJournal(localStorage, v);
    setOperation(value);
    return value;
  };
  const recover = async (v: CoverageJournal) => {
    const result = await acceptOperation(await post('recover', v), v);
    await refresh();
    return result;
  };
  const prepare = (intent: unknown) => {
    const parsed = coverageScopeIntent.safeParse(intent);
    if (!parsed.success)
      throw new Error(
        'Review the selected source, reason, expiry and maximum fire limit (1–24). Nothing was sent.',
      );
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
    return v;
  };
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const candidate = selected === '' ? undefined : context?.candidates[Number(selected)],
    blocked = busy || !ready,
    authorityBlocked = blocked || !context,
    settled = Boolean(operation && (operation.recorded || operation.fenced));
  const prepareRevoke = (r: Context['scopes'][number]) =>
    void action(async (v) => {
      if (v) throw new Error('Recover the original request before another decision.');
      prepare({
        phase: 'revoke',
        request: {
          schemaVersion: 1,
          operationKey: crypto.randomUUID(),
          scopeId: r.scopeId,
          requestSha256: r.requestSha256,
          reason: reason.trim(),
        },
      });
    });
  return (
    <main className="space-y-5">
      <Link href="/monitoring">Back to monitoring</Link>
      <h1 className="text-2xl font-semibold">Scheduled coverage assessments</h1>
      <p>
        The current organization owner may delegate bounded assessment output after an authorized
        PostgreSQL metadata rediscovery. This is a separate findings.write scope, not permission
        inherited from a read schedule or standing approval.
      </p>
      <p className="text-sm text-slate-600">
        Discovery is technical provenance only. Every business/questionnaire fact remains Unknown;
        this workflow establishes no legal conclusion, compliance score, corrective action, report
        release or hosted-provider readiness.
      </p>
      <button
        className={button}
        disabled={busy}
        onClick={() =>
          void action(async () => {
            await refresh();
          })
        }
      >
        Refresh sources and recorded scopes
      </button>
      {error && (
        <p role="alert" className="rounded border border-red-200 bg-red-50 p-3">
          {error}
        </p>
      )}
      {!context && !error && (
        <p role="status">Loading current owner sources and recorded scope history…</p>
      )}
      {context && (
        <p className="text-sm text-slate-600">
          Owner context read {formatDateTime(context.checkedAt)}. Each new decision and fire still
          requires current server authority.
        </p>
      )}
      {journal ? (
        <section className={panel}>
          <h2 className="font-semibold">Recover or confirm your retained {journal.intent.phase}</h2>
          <p className="break-all">Original operation: {journal.intent.request.operationKey}</p>
          <p>Reason: {journal.intent.request.reason}</p>
          {journal.intent.phase === 'authorize' ? (
            <>
              <SourceSummary source={journal.intent.request.source} />
              <p>
                Scope expires {formatDateTime(journal.intent.request.expiresAt)}; at most{' '}
                {journal.intent.request.maxFires} scheduled assessments. Only technical provenance;
                all business facts remain Unknown.
              </p>
              <p>
                New task scope: control_library.read and findings.write. This adds assessment output
                authority beyond rediscovery or standing approval.
              </p>
            </>
          ) : (
            <p className="break-all">
              Original scope: {journal.intent.request.scopeId}; original authorization commitment:{' '}
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
                ? `Recorded receipt ${operation.receiptId}; recorded scope ${operation.scopeId}; revoked: ${operation.revoked ? 'yes' : 'no'}`
                : operation.fenced
                  ? `Original request fenced; receipt ${operation.fenceReceiptId}`
                  : 'No recorded decision confirmed. The original request remains retained.'}
            </p>
          )}
          <button
            className={button}
            disabled={authorityBlocked || settled}
            onClick={() =>
              void action(async (v) => {
                if (!v) return;
                const old = await recover(v);
                if (old.recorded || old.fenced) return;
                if (old.challengeExpiresAt && Date.parse(old.challengeExpiresAt) > Date.now())
                  throw new Error(
                    `An earlier challenge may still be active until ${formatDateTime(old.challengeExpiresAt)}. Recover or fence this same request; do not replace it.`,
                  );
                if (v.challengeId || old.challengeExpiresAt)
                  throw new Error(
                    'The original challenge cannot be replaced. Recover its receipt, or fence and archive this exact request before preparing a new decision.',
                  );
                const raw = await post('challenge', v);
                if (coverageScopeOperation.safeParse(raw).success) {
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
                disabled={authorityBlocked || settled || !code || verified}
                onClick={() =>
                  void action(async (v) => {
                    if (!v?.challengeId) return;
                    try {
                      const raw = await post('verify', v, { challengeId: v.challengeId, code });
                      if (coverageScopeOperation.safeParse(raw).success) {
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
                disabled={authorityBlocked || settled || !verified}
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
                  disabled={authorityBlocked}
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
            disabled={authorityBlocked || settled}
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
                  // Receipt recovery is authoritative independently of a
                  // temporarily unavailable eligibility/history projection.
                  const proof = await acceptOperation(await post('recover', v), v);
                  await archiveConfirmed(localStorage, v, proof);
                  observed.current = null;
                  setJournal(null);
                  setOperation(null);
                  setVerified(false);
                  setCode('');
                  await refresh();
                })
              }
            >
              Archive confirmed receipt and prepare another decision
            </button>
          )}
        </section>
      ) : context ? (
        <>
          <section className={panel}>
            <h2 className="font-semibold">1. Review an eligible assessment source</h2>
            {context.candidates.length === 0 ? (
              <p>
                No eligible assessment source is recorded for this owner. A current authorized
                PostgreSQL read scope, completed rediscovery, baseline assessment, catalogue and
                custody binding must be established first.{' '}
                <Link href="/monitoring">Inspect monitoring</Link> and{' '}
                <Link href="/assessment">assessment sources</Link>.
              </p>
            ) : (
              <>
                <label>
                  Eligible schedule and baseline
                  <select
                    className={field}
                    value={selected}
                    disabled={authorityBlocked}
                    onChange={(e) => {
                      setSelected(e.target.value);
                      setSourceReviewed(false);
                    }}
                  >
                    <option value="">Choose a server-derived source</option>
                    {context.candidates.map((c, i) => (
                      <option
                        key={c.source.scheduleId + ':' + c.source.preflightDiscoveryId}
                        value={i}
                      >
                        Schedule {c.source.scheduleId.slice(0, 8)} · baseline{' '}
                        {c.source.baselineRunId.slice(0, 8)} · catalogue{' '}
                        {c.source.catalogue.libraryVersion}
                      </option>
                    ))}
                  </select>
                </label>
                {candidate && (
                  <>
                    <SourceSummary source={candidate.source} />
                    <p>
                      Source authorization ends no later than{' '}
                      {formatDateTime(candidate.maxExpiresAt)}. Final runtime authority is rechecked
                      for every fire.
                    </p>
                    <label>
                      Maximum delegation duration
                      <select
                        className={field}
                        value={minutes}
                        onChange={(e) => setMinutes(e.target.value)}
                      >
                        {[5, 15, 30, 60].map((m) => (
                          <option key={m} value={m}>
                            {m} minutes, bounded by source expiry
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Maximum scheduled assessments
                      <input
                        className={field}
                        type="number"
                        min="1"
                        max="24"
                        value={maxFires}
                        onChange={(e) => setMaxFires(e.target.value)}
                      />
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={sourceReviewed}
                        onChange={(e) => setSourceReviewed(e.target.checked)}
                      />{' '}
                      I reviewed the exact source and separate findings.write authority. All
                      business facts remain Unknown.
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
              disabled={authorityBlocked}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          {candidate && (
            <button
              className={button}
              disabled={
                authorityBlocked ||
                !sourceReviewed ||
                reason.trim().length < 20 ||
                Date.parse(candidate.maxExpiresAt) <= now
              }
              onClick={() =>
                void action(async (v) => {
                  if (v) throw new Error('An original request is already retained.');
                  const expiresAt = new Date(
                    Math.min(
                      Date.now() + Number(minutes) * 60000,
                      Date.parse(context.checkedAt) + 3600000,
                      Date.parse(candidate.maxExpiresAt),
                    ),
                  ).toISOString();
                  if (Date.parse(expiresAt) <= Date.now())
                    throw new Error(
                      'The eligible source expired. Refresh before preparing a new request.',
                    );
                  prepare({
                    phase: 'authorize',
                    request: {
                      schemaVersion: 1,
                      purpose: 'axiom.scheduled-coverage.authority.v1',
                      operationKey: crypto.randomUUID(),
                      tenantId,
                      ownerId: actorId,
                      previousScopeId: candidate.previousScopeId,
                      source: candidate.source,
                      expiresAt,
                      maxFires: Number(maxFires),
                      taskScopes: ['control_library.read', 'findings.write'],
                      declarationPolicy: 'all_business_facts_unknown',
                      discoveryUse: 'technical_provenance_only',
                      reason: reason.trim(),
                    },
                  });
                })
              }
            >
              Retain owner assessment authorization
            </button>
          )}
        </>
      ) : null}
      {context && (
        <>
          <section className={panel}>
            <h2 className="font-semibold">2. Recorded scope history</h2>
            <p>
              Recorded active means the unrevoked, unexpired current head at read time. It does not
              prove current source permissions, producer/worker readiness or completed assessments.
              History remains retained after revocation or expiry. Revocation does not erase prior
              findings or prove that an in-flight assessment was cancelled.
            </p>
            {context.scopes.length === 0 && (
              <p>No recorded assessment scope is visible in this bounded history.</p>
            )}
            {context.scopes.map((r) => (
              <article key={r.scopeId} className="space-y-3 border-t py-3">
                <h3 className="font-medium break-all">Scope {r.scopeId}</h3>
                <p>
                  Recorded state:{' '}
                  {r.revoked
                    ? 'revoked'
                    : Date.parse(r.request.expiresAt) <= now
                      ? 'expired'
                      : r.active
                        ? 'active head at read time'
                        : 'inactive or superseded'}
                  . Expires {formatDateTime(r.request.expiresAt)}; maximum {r.request.maxFires}{' '}
                  fires.
                </p>
                <p>{r.request.reason}</p>
                <SourceSummary source={r.request.source} />
                <p className="break-all">
                  Owner {r.request.ownerId}; receipt #{r.receiptId}; authorization commitment{' '}
                  {r.requestSha256}
                </p>
                {!journal && !r.revoked && (
                  <button
                    className={button}
                    disabled={authorityBlocked || reason.trim().length < 20}
                    onClick={() => prepareRevoke(r)}
                  >
                    Retain revocation of scope {r.scopeId.slice(0, 8)}
                  </button>
                )}
              </article>
            ))}
          </section>
          <section className={panel}>
            <h2 className="font-semibold">3. Recorded assessment fires</h2>
            <p>
              These are independent retained fire references, not inferred matches to a scope.
              Queued, handed-off and unconfirmed work is not finalized; preserve each original
              reference rather than relaunching it.
            </p>
            {context.fires.length === 0 && (
              <p>No assessment fire is visible in this bounded history.</p>
            )}
            {context.fires.map((f) => (
              <article key={f.fireId} className="space-y-2 border-t py-3">
                <h3 className="font-medium break-all">Fire {f.fireId}</h3>
                <p>Recorded state: {f.state}</p>
                <p className="break-all">
                  Engagement {f.engagementId}; job {f.jobId}; run {f.runId ?? 'not recorded'};
                  receipt {f.receiptId ?? 'not recorded'}
                </p>
                {f.resultDigest && (
                  <p className="break-all">
                    Exact finalized result commitment: {f.resultDigest}. Technical provenance only;
                    business facts remain Unknown.
                  </p>
                )}
              </article>
            ))}
          </section>
        </>
      )}
    </main>
  );
}
