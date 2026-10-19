'use client';
import React, { useState } from 'react';
import Link from 'next/link';
import { formatDateTime } from '@axiom/ui';
import { z } from 'zod';
import {
  monitoringReadScopeContext,
  monitoringReadScopeOperation,
  type MonitoringReadScopeContext,
  type MonitoringReadScopeIntent,
} from '@axiom/types';
import {
  loadReadJournal,
  saveReadJournal,
  assertReadJournal,
  confirmReadScope,
  confirmReadPreflight,
  withReadJournalLock,
  type ReadJournal,
} from '../../read-journal';
const challenge = z
  .object({ challengeId: z.uuid(), expiresAt: z.iso.datetime({ offset: true }) })
  .strict();
export function ReadAccessPanel({
  tenantId,
  actorId,
  scheduleId,
}: {
  tenantId: string;
  actorId: string;
  scheduleId: string;
}) {
  const [context, setContext] = useState<MonitoringReadScopeContext | null>(null),
    [pending, setPending] = useState<ReadJournal | null>(null),
    [busy, setBusy] = useState(false),
    [loaded, setLoaded] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const [canPreflight, setCanPreflight] = useState(false);
  const [connector, setConnector] = useState(''),
    [engagement, setEngagement] = useState(''),
    [reason, setReason] = useState(''),
    [code, setCode] = useState('');
  const base = `/api/bff/v1/monitoring/schedules/${scheduleId}/read-scope`;
  async function api(path: string, body?: unknown) {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(65000),
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-Id': tenantId,
        'X-Expected-Actor-Id': actorId,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value: unknown = await response.json();
    if (!response.ok)
      throw Error('Outcome could not be confirmed. Keep the retained reference and check again.');
    const parsed = z
      .object({ data: z.unknown(), preflightAvailable: z.boolean().optional() })
      .strict()
      .parse(value);
    if (path === '') setCanPreflight(parsed.preflightAvailable === true);
    return parsed.data;
  }
  async function reload() {
    const value = monitoringReadScopeContext.parse(await api(''));
    if (value.tenantId !== tenantId || value.actorId !== actorId || value.scheduleId !== scheduleId)
      throw Error('Schedule context changed.');
    setContext(value);
    setPending(loadReadJournal(localStorage, tenantId, actorId));
    setLoaded(true);
    return value;
  }
  async function work(task: () => Promise<void>) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await withReadJournalLock(tenantId, actorId, task);
    } catch {
      setError(
        'The outcome is unconfirmed. Keep the original request; check its status before continuing.',
      );
      try {
        setPending(loadReadJournal(localStorage, tenantId, actorId));
      } catch {
        setError('Retained browser storage cannot be verified. Nothing further was sent.');
      }
    } finally {
      setCode('');
      setBusy(false);
    }
  }
  const current = pending?.scheduleId === scheduleId ? pending : null;
  async function recover(v: ReadJournal) {
    assertReadJournal(localStorage, v);
    if (v.kind === 'scope') {
      const result = monitoringReadScopeOperation.parse(
        await api('/recover', { intent: v.intent }),
      );
      if (await confirmReadScope(localStorage, v, result)) {
        setMessage(
          result.recorded
            ? 'Recorded scope decision confirmed.'
            : 'Cancellation fence confirmed. A new request can now be prepared.',
        );
        await reload();
      } else
        setMessage(
          !result.recorded && result.challengeExpiresAt
            ? 'Original request remains unrecorded. Complete its existing MFA challenge, or cancel it before starting again.'
            : 'No scope decision is recorded. Prepare its challenge or cancel this retained request.',
        );
    } else {
      const result = await api(`/preflight/${v.operationKey}`);
      const row = z.object({ status: z.string() }).passthrough().nullable().parse(result);
      if (row?.status === 'completed') {
        confirmReadPreflight(localStorage, v, result);
        setMessage('Supervised read-only check completed. You can review its exact scope.');
        await reload();
      } else
        setMessage(
          `Original check ${row?.status ?? 'not found'}. Its reference is retained; no second check was started.`,
        );
    }
  }
  async function preparePreflight() {
    if (!context || pending) return;
    const v: ReadJournal = {
      kind: 'preflight',
      tenantId,
      actorId,
      scheduleId,
      operationKey: crypto.randomUUID(),
      connectorId: connector,
      engagementId: engagement,
    };
    saveReadJournal(localStorage, v);
    setPending(v);
    await api('/preflight', {
      operationKey: v.operationKey,
      connectorId: v.connectorId,
      engagementId: v.engagementId,
    });
    await recover(v);
  }
  function retainScope(intent: MonitoringReadScopeIntent) {
    if (pending) throw Error('Resolve retained request first');
    const v: ReadJournal = { kind: 'scope', tenantId, actorId, scheduleId, intent };
    saveReadJournal(localStorage, v);
    setPending(v);
    setMessage('Review the retained scope, then prepare the approval challenge.');
  }
  async function prepareApproval() {
    const fresh = await reload();
    if (pending) throw Error();
    const p = fresh.preflights.find(
        (v) => v.connectorId === connector && v.engagementId === engagement,
      ),
      target = fresh.targets.find((v) => v.connectorId === connector);
    if (
      !p ||
      !target ||
      p.grantId !== target.grantId ||
      p.configurationSha256 !== target.configurationSha256
    )
      throw Error();
    const until = new Date(
      Math.min(Date.now() + 30 * 60 * 1000, new Date(target.maxExpiresAt).getTime()),
    ).toISOString();
    retainScope({
      phase: 'authorize',
      request: {
        schemaVersion: 1,
        operationKey: crypto.randomUUID(),
        scheduleId,
        estateId: fresh.estateId,
        engagementId: engagement,
        connectorId: connector,
        grantId: target.grantId,
        configurationSha256: target.configurationSha256,
        cadence: fresh.cadence,
        preflightRequestId: p.requestId,
        previousScopeId: fresh.scopeId,
        expiresAt: until,
        reason,
      },
    });
  }
  async function scopeStep(step: 'challenge' | 'record' | 'fence', verifyCode = true) {
    if (!current || current.kind !== 'scope') throw Error();
    assertReadJournal(localStorage, current);
    if (step === 'challenge') {
      const raw = await api('/challenge', { intent: current.intent });
      const done = monitoringReadScopeOperation.safeParse(raw);
      if (done.success) {
        await confirmReadScope(localStorage, current, done.data);
        await reload();
        return;
      }
      const c = challenge.parse(raw),
        next = { ...current, challengeId: c.challengeId };
      saveReadJournal(localStorage, next, current);
      setPending(next);
      setMessage(
        `Approval challenge prepared until ${formatDateTime(c.expiresAt)}. Enter your current authenticator code.`,
      );
      return;
    }
    if (step === 'record' && verifyCode) {
      if (!current.challengeId || !/^\d{6}$/.test(code)) throw Error();
      z.object({ verified: z.literal(true), challengeId: z.literal(current.challengeId) })
        .strict()
        .parse(
          await api('/verify', { intent: current.intent, challengeId: current.challengeId, code }),
        );
    }
    const result = await api('/' + step, {
      intent: current.intent,
      ...(step === 'record' ? { challengeId: current.challengeId } : {}),
    });
    if (!(await confirmReadScope(localStorage, current, result))) throw Error();
    const proof = monitoringReadScopeOperation.parse(result);
    setMessage(
      proof.recorded
        ? 'Original scope decision is recorded; inspect its current status below.'
        : 'Cancellation fence recorded. A new request can now be prepared.',
    );
    await reload();
  }
  return (
    <section className="space-y-4 rounded-lg border p-5">
      <button
        disabled={busy}
        onClick={() =>
          void work(async () => {
            await reload();
          })
        }
      >
        Load current schedule and retained request
      </button>
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      {pending && pending.scheduleId !== scheduleId && (
        <p>
          Resolve the retained request on{' '}
          <Link href={`/monitoring/${pending.scheduleId}/read-access`}>its original schedule</Link>{' '}
          before continuing.
        </p>
      )}
      {context && (
        <>
          <dl className="grid grid-cols-2 gap-2">
            <dt>Cadence</dt>
            <dd>{context.cadence}</dd>
            <dt>Schedule</dt>
            <dd>{context.status}</dd>
            <dt>Read binding</dt>
            <dd>{context.scopeId ?? 'No recorded binding'}</dd>
          </dl>
          {!canPreflight && (
            <p>
              Discovery controller is unavailable. A new preflight cannot start in this deployment.
            </p>
          )}
          <p>
            Read-only listing only. Each fire rechecks the current owner-approved scope, connector
            grant, custody policy and workload. Expiry or revocation stops new reads. Reassessment
            is not supported by this binding.
          </p>
          {context.scopes.map((s) => (
            <p key={s.scopeId}>
              Scope {s.scopeId}:{' '}
              {s.revoked
                ? 'Revoked'
                : s.active
                  ? 'Current binding; expiry still checked at every read'
                  : 'Historical binding'}{' '}
              · expires {formatDateTime(s.expiresAt)} · receipt {s.receiptId}
            </p>
          ))}
          <table>
            <caption>Recent retained fires</caption>
            <thead>
              <tr>
                <th>Due</th>
                <th>Recorded state</th>
                <th>Cleanup</th>
                <th>Receipt</th>
              </tr>
            </thead>
            <tbody>
              {context.fires.map((f) => (
                <tr key={f.fireId}>
                  <td>{formatDateTime(f.dueAt)}</td>
                  <td>
                    {f.state}
                    {['queued', 'handed_off'].includes(f.state)
                      ? ` (bounded until ${formatDateTime(f.expiresAt)}; completion unconfirmed)`
                      : ''}
                  </td>
                  <td>{f.cleanupConfirmed === true ? 'Confirmed' : 'Unconfirmed'}</td>
                  <td>{f.receiptId ?? 'None'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!pending && context.kind === 'rediscovery' && (
            <>
              <label>
                Enrolled connector
                <select value={connector} onChange={(e) => setConnector(e.target.value)}>
                  <option value="">Select connector</option>
                  {context.targets.map((t) => (
                    <option key={t.connectorId} value={t.connectorId}>
                      {t.name} ({t.connectorId.slice(0, 8)})
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Engagement
                <select value={engagement} onChange={(e) => setEngagement(e.target.value)}>
                  <option value="">Select engagement</option>
                  {context.engagements.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.title}
                    </option>
                  ))}
                </select>
              </label>
              <button
                disabled={busy || !canPreflight || !connector || !engagement}
                onClick={() => void work(preparePreflight)}
              >
                Run supervised read-only preflight
              </button>
              <label>
                Reason
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  maxLength={2000}
                />
              </label>
              <button
                disabled={busy || reason.trim().length < 20 || !connector || !engagement}
                onClick={() => void work(prepareApproval)}
              >
                Review 30-minute read scope
              </button>
            </>
          )}
          {!pending && context.scopeId && (
            <section>
              <label>
                Revocation reason
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  maxLength={2000}
                />
              </label>
              <button
                disabled={busy || reason.trim().length < 20}
                onClick={() =>
                  void work(async () => {
                    retainScope({
                      phase: 'revoke',
                      request: {
                        schemaVersion: 1,
                        operationKey: crypto.randomUUID(),
                        scopeId: context.scopeId!,
                        reason,
                      },
                    });
                  })
                }
              >
                Review revocation
              </button>
            </section>
          )}
        </>
      )}
      {current && (
        <section className="space-y-2 border-t pt-4">
          <h2>Retained original request</h2>
          <p>
            Operation{' '}
            {current.kind === 'scope' ? current.intent.request.operationKey : current.operationKey}
          </p>
          {current.kind === 'scope' && (
            <>
              <p>
                {current.intent.phase === 'authorize'
                  ? `Enumerate metadata for connector ${current.intent.request.connectorId}, engagement ${current.intent.request.engagementId}, cadence ${current.intent.request.cadence}, until ${formatDateTime(current.intent.request.expiresAt)}. No target writes or sampled values.`
                  : `Revoke read scope ${current.intent.request.scopeId}.`}
              </p>
              {current.intent.phase === 'authorize' && (
                <dl>
                  <dt>Connector configuration SHA-256</dt>
                  <dd className="break-all">{current.intent.request.configurationSha256}</dd>
                  <dt>Current read grant</dt>
                  <dd>{current.intent.request.grantId}</dd>
                  <dt>Supervised preflight request</dt>
                  <dd>{current.intent.request.preflightRequestId}</dd>
                  <dt>Replaces scope</dt>
                  <dd>{current.intent.request.previousScopeId ?? 'None'}</dd>
                </dl>
              )}
              <p>Reason: {current.intent.request.reason}</p>
            </>
          )}
          <button disabled={busy} onClick={() => void work(() => recover(current))}>
            Check original request status
          </button>
          {current.kind === 'scope' && (
            <>
              <button
                disabled={busy || Boolean(current.challengeId)}
                onClick={() => void work(() => scopeStep('challenge'))}
              >
                Prepare approval challenge
              </button>
              {current.challengeId && (
                <>
                  <label>
                    Current authenticator code
                    <input
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                      maxLength={6}
                    />
                  </label>
                  <button
                    disabled={busy || !/^\d{6}$/.test(code)}
                    onClick={() => void work(() => scopeStep('record'))}
                  >
                    Approve this exact scope
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => void work(() => scopeStep('record', false))}
                  >
                    Recover recording of this same verified approval
                  </button>
                </>
              )}
              <button disabled={busy} onClick={() => void work(() => scopeStep('fence'))}>
                Cancel retained request and fence late replies
              </button>
            </>
          )}
        </section>
      )}
      {!loaded && (
        <p>
          Load the current schedule to review its actual grant and retained history. No request is
          sent automatically.
        </p>
      )}
    </section>
  );
}
