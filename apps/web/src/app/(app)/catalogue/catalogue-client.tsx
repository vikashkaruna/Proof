'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import { generateUUID } from '@axiom/ui';
import {
  CatalogueEngagementResponseSchema,
  CatalogueReauditRequestSchema,
  CatalogueReauditDecisionSchema,
} from '@axiom/types';
import { formatDateTime } from '@/lib/display-time';

type Snapshot = z.infer<typeof CatalogueEngagementResponseSchema>;
const snapshotResponseSchema = z.object({ data: CatalogueEngagementResponseSchema });
type Release = Snapshot['releasedVersions'][number];
type Request = Snapshot['requests'][number];
type Intent =
  z.infer<typeof CatalogueReauditRequestSchema> | z.infer<typeof CatalogueReauditDecisionSchema>;
const button =
  'rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-indigo-950 hover:bg-slate-50 disabled:opacity-50';
const field = 'mt-1 block w-full rounded-md border border-slate-300 bg-white p-2 text-sm';
const challengeSchema = z.object({
  data: z.object({ challengeId: z.uuid(), expiresAt: z.string() }),
});
const verifiedSchema = z.object({ data: z.object({ verified: z.literal(true) }) });
const submittedSchema = z.object({
  data: z.object({
    requestId: z.uuid(),
    status: z.enum(['pending', 'approved', 'rejected']),
    engagementId: z.uuid().nullable(),
    receiptId: z.string().min(1),
    replayed: z.boolean(),
  }),
});

function readableField(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ');
}

function CatalogueDelta({ release }: { release: Release }) {
  return (
    <section className="space-y-3" aria-label={`Changes in version ${release.libraryVersion}`}>
      <p className="text-sm text-slate-600">
        {release.delta.previousVersion
          ? `Changes from version ${release.delta.previousVersion} to ${release.libraryVersion}`
          : `Initial published basis for version ${release.libraryVersion}`}
      </p>
      <p className="whitespace-pre-wrap text-sm text-slate-700">{release.changeLog}</p>
      <div className="grid gap-3 md:grid-cols-3">
        {[
          { label: 'Added controls', controls: release.delta.added },
          { label: 'Removed controls', controls: release.delta.removed },
          { label: 'Revised controls', controls: release.delta.changed },
        ].map(({ label, controls }) => (
          <div key={label} className="rounded-lg border border-slate-200 p-3">
            <h4 className="text-sm font-semibold text-indigo-950">
              {label} ({controls.length})
            </h4>
            {controls.length ? (
              <ul className="mt-2 space-y-2 text-sm text-slate-700">
                {controls.map((control) => (
                  <li key={control.id}>
                    <span className="font-medium">{control.id}</span> — {control.title}
                    {'fields' in control && Array.isArray(control.fields) && (
                      <p className="mt-1 text-xs text-slate-600">
                        Changed: {control.fields.map(readableField).join(', ')}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-slate-500">None recorded.</p>
            )}
          </div>
        ))}
      </div>
      <details className="text-xs text-slate-600">
        <summary className="cursor-pointer">Exact change-set fingerprint</summary>
        <p className="mt-2 break-all font-mono">{release.delta.sha256}</p>
      </details>
    </section>
  );
}

export function CatalogueEngagementClient({
  tenantId,
  actorId,
  canRequest,
  canDecide,
}: {
  tenantId: string;
  actorId: string;
  canRequest: boolean;
  canDecide: boolean;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [baseline, setBaseline] = useState('');
  const [target, setTarget] = useState('');
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [review, setReview] = useState<{ request: Request; decision: 'approve' | 'reject' } | null>(
    null,
  );
  const [intent, setIntent] = useState<Intent | null>(null);
  const [challenge, setChallenge] = useState('');
  const [code, setCode] = useState('');

  const load = useCallback(
    async (signal?: AbortSignal, clearError = true) => {
      setLoading(true);
      if (clearError) setError('');
      try {
        const response = await fetch('/api/bff/v1/catalogue-engagement', {
          cache: 'no-store',
          signal,
          headers: { 'x-tenant-id': tenantId },
        });
        if (!response.ok) throw Error('The recorded catalogue position could not be verified.');
        const value = snapshotResponseSchema.parse(await response.json()).data;
        if (!signal?.aborted) {
          setSnapshot(value);
          const nextBaseline = value.auditedBaselines[0]?.runId ?? '';
          const options = value.upgradeOptions.filter(
            (item) => item.baselineRunId === nextBaseline,
          );
          setBaseline(nextBaseline);
          setTarget(
            options.find((item) => item.targetVersion === value.currentVersion)?.targetVersion ??
              options[0]?.targetVersion ??
              value.currentVersion,
          );
        }
      } catch (cause) {
        if (!signal?.aborted) {
          setSnapshot(null);
          setError(cause instanceof Error ? cause.message : 'Catalogue status is unavailable.');
        }
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [tenantId],
  );
  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => load(controller.signal));
    return () => controller.abort();
  }, [load]);

  async function send(step: 'challenge' | 'verify' | 'submit', request: Intent) {
    const response = await fetch(
      `/api/bff/v1/catalogue-engagement/${'baselineRunId' in request ? 'request' : 'decision'}/${step}`,
      {
        method: 'POST',
        cache: 'no-store',
        headers: {
          'content-type': 'application/json',
          'x-tenant-id': tenantId,
          'x-expected-actor-id': actorId,
          'idempotency-key': request.operationKey,
        },
        body: JSON.stringify({
          request,
          ...(step === 'challenge' ? {} : { challengeId: challenge }),
          ...(step === 'verify' ? { code: code.trim() } : {}),
        }),
      },
    );
    if (!response.ok)
      throw Error(
        'The outcome was not confirmed. Refresh the recorded requests before preparing another request or decision.',
      );
    return response.json() as Promise<unknown>;
  }

  async function prepare() {
    if (!snapshot || !confirmed || !reason.trim() || (review ? !canDecide : !canRequest)) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const common = { version: 1, operationKey: generateUUID(), reason, confirmed: true };
      const request = review
        ? CatalogueReauditDecisionSchema.parse({
            ...common,
            requestId: review.request.requestId,
            decision: review.decision,
          })
        : CatalogueReauditRequestSchema.parse({
            ...common,
            baselineRunId: baseline,
            targetVersion: target,
            deltaSha256: snapshot.upgradeOptions.find(
              (item) => item.baselineRunId === baseline && item.targetVersion === target,
            )?.delta.sha256,
          });
      const result = challengeSchema.parse(await send('challenge', request));
      setIntent(request);
      setChallenge(result.data.challengeId);
      setMessage('The exact request and reason are prepared. Confirm with your authenticator.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The request could not be prepared.');
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (!intent || !challenge) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      verifiedSchema.parse(await send('verify', intent));
      const result = submittedSchema.parse(await send('submit', intent)).data;
      setMessage(
        result.status === 'pending'
          ? `Re-audit requested. Founder approval is pending. Audit receipt ${result.receiptId}.`
          : result.status === 'approved'
            ? `Re-audit approved. A separate assessment is available. Audit receipt ${result.receiptId}. Existing reports are unchanged.`
            : `Re-audit request rejected. Audit receipt ${result.receiptId}. Existing reports are unchanged.`,
      );
      clearReview();
      await load(undefined, false);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'The recorded outcome could not be verified.',
      );
      clearReview();
      await load(undefined, false);
    } finally {
      setBusy(false);
    }
  }

  function clearReview() {
    setIntent(null);
    setChallenge('');
    setCode('');
    setReview(null);
    setReason('');
    setConfirmed(false);
  }

  const baselineRecord = snapshot?.auditedBaselines.find((item) => item.runId === baseline);
  const targetRelease = snapshot?.releasedVersions.find((item) => item.libraryVersion === target);
  const upgrade = snapshot?.upgradeOptions.find(
    (item) => item.baselineRunId === baseline && item.targetVersion === target,
  );
  const existingRequest = snapshot?.requests.find(
    (item) =>
      item.baselineRunId === baseline &&
      item.targetVersion === target &&
      item.status !== 'rejected',
  );
  const editing = busy || !!intent;
  return (
    <div className="space-y-5" aria-busy={loading || busy}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-indigo-950">
          {canDecide
            ? 'Selected company: catalogue position and re-audit requests'
            : 'Your catalogue position'}
        </h2>
        <button
          className={button}
          disabled={busy || loading || !!intent}
          onClick={() => void load()}
        >
          Refresh catalogue position
        </button>
      </div>
      {error && (
        <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="rounded-lg bg-teal-50 p-3 text-sm text-teal-900">
          {message}
        </p>
      )}
      {loading && <p role="status">Loading recorded catalogue position…</p>}
      {snapshot && (
        <>
          <dl className="grid gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-3">
            <div>
              <dt className="text-sm text-slate-600">Released current catalogue</dt>
              <dd className="mt-1 font-semibold text-indigo-950">{snapshot.currentVersion}</dd>
            </div>
            <div>
              <dt className="text-sm text-slate-600">
                Basis available for your next authorized assessment
              </dt>
              <dd className="mt-1 font-semibold text-indigo-950">{snapshot.effectiveVersion}</dd>
            </div>
            <div>
              <dt className="text-sm text-slate-600">Completed audit history</dt>
              <dd className="mt-1 font-semibold text-indigo-950">
                {snapshot.historicalAuditNeedsReview
                  ? 'Historical basis needs review'
                  : snapshot.hasFinalizedAudit
                    ? 'Recorded below'
                    : 'No finalized audit recorded'}
              </dd>
            </div>
          </dl>
          <p className="text-sm text-slate-700">
            {snapshot.historicalAuditNeedsReview
              ? 'A historical audit needs its retained basis verified before a first-audit or re-audit path can be offered. Existing records are unchanged; contact your Axiom reviewer.'
              : snapshot.hasFinalizedAudit
                ? 'Completed assessments and reports retain their recorded catalogue. Request a re-audit of released changes; founder approval opens a separate assessment.'
                : 'The released current catalogue applies by default to an organization with no finalized audit. No re-audit permission is needed for a first assessment.'}
          </p>
          {snapshot.requiresOwnerRequest && (
            <p className="rounded-lg border border-teal-200 bg-teal-50 p-3 text-sm text-teal-950">
              A newer catalogue is available. A delta assessment is recommended; an owner request
              and founder approval are required before re-audit.
            </p>
          )}
          {snapshot.auditedBaselines.length > 0 && (
            <section aria-label="Recorded audited catalogues" className="space-y-2">
              <h3 className="font-semibold text-indigo-950">Recorded audited catalogues</h3>
              <ul className="space-y-2">
                {snapshot.auditedBaselines.map((item) => (
                  <li key={item.runId} className="rounded-lg border border-slate-200 p-3 text-sm">
                    <span className="font-medium">Catalogue {item.libraryVersion}</span> · Finalized{' '}
                    {formatDateTime(item.finalizedAt)}
                    <Link
                      className="ml-3 font-medium text-teal-800 underline"
                      href={`/assessment?engagement=${encodeURIComponent(item.engagementId)}`}
                    >
                      Inspect saved assessment
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section aria-label="Released catalogue changes" className="space-y-3">
            <h3 className="font-semibold text-indigo-950">Released changes</h3>
            {snapshot.releasedVersions.map((release) => (
              <details
                key={release.libraryVersion}
                className="rounded-xl border border-slate-200 bg-white p-4"
              >
                <summary className="cursor-pointer font-medium text-indigo-950">
                  Version {release.libraryVersion}
                  {release.libraryVersion === snapshot.currentVersion ? ' · Current' : ''} ·
                  Released {formatDateTime(release.publishedAt)}
                </summary>
                <div className="mt-3">
                  <CatalogueDelta release={release} />
                </div>
              </details>
            ))}
          </section>
          {canRequest && snapshot.requiresOwnerRequest && !review && (
            <section
              aria-label="Request a catalogue re-audit"
              className="space-y-3 rounded-xl border border-teal-200 bg-white p-4"
            >
              <h3 className="font-semibold text-indigo-950">Request a catalogue re-audit</h3>
              <label className="block text-sm">
                Completed audit to reassess
                <select
                  className={field}
                  disabled={editing}
                  value={baseline}
                  onChange={(event) => {
                    const next = event.target.value;
                    const options = snapshot.upgradeOptions.filter(
                      (item) => item.baselineRunId === next,
                    );
                    setBaseline(next);
                    setTarget(
                      options.find((item) => item.targetVersion === snapshot.currentVersion)
                        ?.targetVersion ??
                        options[0]?.targetVersion ??
                        '',
                    );
                  }}
                >
                  {snapshot.auditedBaselines.map((item) => (
                    <option key={item.runId} value={item.runId}>
                      Catalogue {item.libraryVersion} · {formatDateTime(item.finalizedAt)} ·{' '}
                      {item.engagementId}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm">
                Released target catalogue
                <select
                  className={field}
                  disabled={editing}
                  value={target}
                  onChange={(event) => setTarget(event.target.value)}
                >
                  {snapshot.releasedVersions
                    .filter((item) =>
                      snapshot.upgradeOptions.some(
                        (option) =>
                          option.baselineRunId === baseline &&
                          option.targetVersion === item.libraryVersion,
                      ),
                    )
                    .map((item) => (
                      <option key={item.libraryVersion} value={item.libraryVersion}>
                        {item.libraryVersion}
                      </option>
                    ))}
                </select>
              </label>
              {baselineRecord && targetRelease && (
                <p className="text-sm text-slate-600">
                  Review request: {baselineRecord.libraryVersion} → {targetRelease.libraryVersion}.
                  The founder will review the engagement before it becomes available.
                </p>
              )}
              {upgrade && targetRelease && (
                <CatalogueDelta release={{ ...targetRelease, delta: upgrade.delta }} />
              )}
              {!upgrade && (
                <p className="text-sm text-slate-600">
                  No released change-set is currently available for this selected audit and target.
                  Refresh the recorded position.
                </p>
              )}
            </section>
          )}
          {canRequest && existingRequest && (
            <p
              role="status"
              className="rounded-lg border border-slate-200 p-3 text-sm text-slate-700"
            >
              {existingRequest.status === 'pending'
                ? 'This audit and target catalogue already have a request awaiting founder approval.'
                : 'This audit and target catalogue already have an approved re-audit. Open that separate assessment from the request below.'}{' '}
              No duplicate request is needed.
            </p>
          )}
          <section aria-label="Re-audit request history" className="space-y-3">
            <h3 className="font-semibold text-indigo-950">Re-audit requests</h3>
            {snapshot.requests.length === 0 && (
              <p className="text-sm text-slate-600">
                No re-audit requests recorded for this company.
              </p>
            )}
            {snapshot.requests.map((item) => (
              <article
                key={item.requestId}
                className="space-y-2 rounded-xl border border-slate-200 bg-white p-4"
              >
                <div className="flex flex-wrap justify-between gap-2">
                  <h4 className="font-semibold text-indigo-950">
                    Target catalogue {item.targetVersion}
                  </h4>
                  <span className="text-sm font-medium text-slate-700">
                    {item.status === 'pending'
                      ? 'Awaiting founder decision'
                      : item.status === 'approved'
                        ? 'Approved for re-audit'
                        : 'Rejected'}
                  </span>
                </div>
                <p className="text-sm text-slate-600">
                  Requested {formatDateTime(item.requestedAt)} · Request {item.requestId}
                </p>
                <p className="whitespace-pre-wrap text-sm text-slate-700">
                  Owner reason: {item.ownerReason}
                </p>
                <p className="text-xs text-slate-600">
                  Owner request receipt: {item.ownerReceiptId}
                  {item.decisionReceiptId
                    ? ` · Founder decision receipt: ${item.decisionReceiptId}`
                    : ' · Founder decision not recorded'}
                </p>
                {item.decisionReason && (
                  <p className="whitespace-pre-wrap text-sm text-slate-700">
                    Founder reason: {item.decisionReason}
                  </p>
                )}
                {item.status === 'approved' && item.engagementId && (
                  <Link
                    className="inline-block text-sm font-semibold text-teal-800 underline"
                    href={`/assessment?engagement=${encodeURIComponent(item.engagementId)}`}
                  >
                    Open approved re-audit assessment
                  </Link>
                )}
                {canDecide && item.status === 'pending' && (
                  <div className="flex flex-wrap gap-2">
                    {(['approve', 'reject'] as const).map((decision) => (
                      <button
                        key={decision}
                        className={button}
                        disabled={editing}
                        onClick={() => {
                          clearReview();
                          setReview({ request: item, decision });
                        }}
                      >
                        {decision === 'approve' ? 'Review re-audit approval' : 'Review rejection'}
                      </button>
                    ))}
                  </div>
                )}
              </article>
            ))}
          </section>
          {(review || (canRequest && snapshot.requiresOwnerRequest && !existingRequest)) && (
            <section
              aria-label="Confirm catalogue engagement request"
              className="space-y-3 rounded-xl border border-teal-300 bg-white p-4"
            >
              <h3 className="font-semibold text-indigo-950">
                {review
                  ? `${review.decision === 'approve' ? 'Approve' : 'Reject'} re-audit request`
                  : 'Explain the requested re-audit'}
              </h3>
              {review && (
                <p className="text-sm text-slate-600">
                  Request {review.request.requestId} · Target {review.request.targetVersion}.
                  Approval opens a new assessment and preserves all existing reports.
                </p>
              )}
              <label className="block text-sm">
                {review ? 'Founder decision reason' : 'Re-audit request reason'}
                <textarea
                  className={field}
                  maxLength={2000}
                  disabled={editing}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </label>
              <label className="flex gap-2 text-sm">
                <input
                  type="checkbox"
                  disabled={editing}
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                {review
                  ? 'I reviewed this request, the target catalogue and the owner’s reason.'
                  : 'I reviewed the catalogue changes and request a new audit under this target version.'}
              </label>
              {!intent ? (
                <button
                  className={button}
                  disabled={
                    busy ||
                    !confirmed ||
                    !reason.trim() ||
                    (!review &&
                      (!baseline ||
                        !upgrade ||
                        !targetRelease ||
                        target === baselineRecord?.libraryVersion))
                  }
                  onClick={() => void prepare()}
                >
                  Prepare {review ? 'decision' : 'request'} with MFA
                </button>
              ) : (
                <>
                  <p className="text-xs text-slate-600">
                    Prepared operation: {intent.operationKey}
                  </p>
                  <label className="block text-sm">
                    Authenticator code
                    <input
                      className={field}
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      value={code}
                      disabled={busy}
                      onChange={(event) => setCode(event.target.value)}
                    />
                  </label>
                  <button
                    className={button}
                    disabled={busy || !/^\d{6}$/.test(code.trim())}
                    onClick={() => void submit()}
                  >
                    {'baselineRunId' in intent
                      ? 'Submit re-audit request'
                      : intent.decision === 'approve'
                        ? 'Approve re-audit'
                        : 'Reject re-audit'}
                  </button>
                </>
              )}
              {(review || intent) && (
                <button className={button} disabled={busy} onClick={clearReview}>
                  Discard prepared review
                </button>
              )}
            </section>
          )}
          <p className="border-t border-slate-200 pt-3 text-sm text-slate-600">
            After the re-audit completes, prepare a new report from its actual results and follow
            content approval, retention and release. Catalogue release or re-audit approval alone
            never revises or releases a report.
          </p>
        </>
      )}
    </div>
  );
}
