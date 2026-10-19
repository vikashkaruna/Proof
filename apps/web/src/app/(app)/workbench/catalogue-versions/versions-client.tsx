'use client';
import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import { canonicalJson } from '@axiom/ledger';
import { generateUUID } from '@axiom/ui';
import {
  CatalogueVersionApprovalRequestSchema,
  CatalogueCurrentVersionRequestSchema,
  ApprovedLibraryVersionSchema,
  CatalogueVersionSummarySchema,
  type CatalogueVersionSummary,
} from '@axiom/types';
import { formatDateTime } from '@/lib/display-time';
const list = z.object({ data: z.object({ versions: z.array(CatalogueVersionSummarySchema) }) });
type Intent =
  | z.infer<typeof CatalogueVersionApprovalRequestSchema>
  | z.infer<typeof CatalogueCurrentVersionRequestSchema>;
const button =
  'rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-[#1E2A4A] hover:bg-slate-50 disabled:opacity-50';
export function CatalogueVersionsClient({
  tenantId,
  actorId,
}: {
  tenantId: string;
  actorId: string;
}) {
  const [versions, setVersions] = useState<CatalogueVersionSummary[]>([]),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const [selected, setSelected] = useState<CatalogueVersionSummary | null>(null),
    [reason, setReason] = useState(''),
    [confirmed, setConfirmed] = useState(false),
    [intent, setIntent] = useState<Intent | null>(null),
    [challenge, setChallenge] = useState(''),
    [code, setCode] = useState('');
  const load = useCallback(
    async (signal?: AbortSignal, clearError = true) => {
      setLoading(true);
      if (clearError) setError('');
      try {
        const response = await fetch('/api/bff/v1/catalogue-versions', {
          cache: 'no-store',
          signal,
          headers: { 'x-tenant-id': tenantId },
        });
        if (!response.ok) throw Error('Catalogue versions could not be verified.');
        const result = list.parse(await response.json());
        if (!signal?.aborted) setVersions(result.data.versions);
      } catch (cause) {
        if (!signal?.aborted) {
          setVersions([]);
          setError(
            cause instanceof Error ? cause.message : 'Catalogue versions could not be loaded.',
          );
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
  async function send(step: string, request: Intent, extra: Record<string, string> = {}) {
    const response = await fetch(
      `/api/bff/v1/catalogue-versions${'transition' in request ? '/current' : ''}/${step}`,
      {
        method: 'POST',
        cache: 'no-store',
        headers: {
          'content-type': 'application/json',
          'x-tenant-id': tenantId,
          'x-expected-actor-id': actorId,
          'idempotency-key': request.operationKey,
        },
        body: JSON.stringify({ request, ...extra }),
      },
    );
    if (!response.ok)
      throw Error(
        'Approval was not confirmed. Refresh versions to check the recorded state before preparing a fresh approval.',
      );
    return response.json() as Promise<unknown>;
  }
  async function prepare() {
    if (!selected || !confirmed) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const source = {
        version: 1,
        operationKey: generateUUID(),
        libraryVersion: selected.libraryVersion,
        rowsHash: selected.rowsHash,
        questionnaireDigest: selected.questionnaireDigest,
        manifestSha256: selected.manifestSha256,
        mappingVersion: selected.mappingVersion,
        reason,
        confirmed: true,
      };
      const request = selected.approved
        ? CatalogueCurrentVersionRequestSchema.parse({
            ...source,
            transition: 'make_current',
            previousCurrentVersion:
              versions.find((version) => version.isCurrent)?.libraryVersion ?? null,
          })
        : CatalogueVersionApprovalRequestSchema.parse(source);
      const result = z
        .object({ data: z.object({ challengeId: z.uuid(), expiresAt: z.string() }) })
        .parse(await send('challenge', request));
      setIntent(request);
      setChallenge(result.data.challengeId);
      setMessage(
        'Review is bound to this version and reason. Enter a fresh authenticator code to approve.',
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Approval preparation failed.');
    } finally {
      setBusy(false);
    }
  }
  async function approve() {
    if (!intent || !challenge) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await send('verify', intent, { challengeId: challenge, code });
      const result = z
        .object({
          data: z.object({
            approved: z.literal(true),
            libraryVersion: ApprovedLibraryVersionSchema,
            receiptId: z.string(),
          }),
        })
        .parse(await send('approve', intent, { challengeId: challenge }));
      setMessage(
        'transition' in intent
          ? `Version ${result.data.libraryVersion} is now current for new assessments. Audit receipt ${result.data.receiptId}. Existing assessments retain their recorded version.`
          : `Version ${result.data.libraryVersion} approved. Audit receipt ${result.data.receiptId}. The current version has not been changed.`,
      );
      setIntent(null);
      setChallenge('');
      setCode('');
      setSelected(null);
      setConfirmed(false);
      setReason('');
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Approval outcome is uncertain. Refresh recorded versions.',
      );
      setIntent(null);
      setChallenge('');
      setCode('');
      setSelected(null);
      await load(undefined, false);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-4" aria-busy={busy || loading}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-[#1E2A4A]">Published and approved versions</h2>
        <button className={button} disabled={busy || loading} onClick={() => void load()}>
          Refresh versions
        </button>
      </div>
      {error && (
        <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-800">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="rounded-md bg-teal-50 p-3 text-sm text-teal-900">
          {message}
        </p>
      )}
      {loading ? (
        <p role="status">Loading catalogue versions…</p>
      ) : (
        <ul className="space-y-3">
          {versions.map((version) => (
            <li
              key={version.libraryVersion}
              className="rounded-xl border border-slate-200 bg-white p-5"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="font-semibold text-[#1E2A4A]">Version {version.libraryVersion}</h3>
                <span className="text-sm text-slate-600">
                  {version.approved ? 'Approved' : 'Published · awaiting founder approval'}
                  {version.isCurrent ? ' · Current for new assessments' : ''}
                </span>
              </div>
              <p className="mt-2 text-sm text-slate-600">
                {version.controlCount} controls · Published {formatDateTime(version.publishedAt)} by{' '}
                {version.publishedBy}
              </p>
              <details className="mt-3">
                <summary className="cursor-pointer text-sm font-medium text-[#1E2A4A]">
                  Review changes and source fingerprints
                </summary>
                <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">
                  {version.changeLog}
                </p>
                <dl className="mt-3 space-y-2 text-xs text-slate-600">
                  {[
                    ['Rows', version.rowsHash],
                    ['Questionnaire', version.questionnaireDigest],
                    ['Public evidence mapping', version.mappingVersion],
                    ['Manifest', version.manifestSha256],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <dt className="font-medium">{label}</dt>
                      <dd className="break-all font-mono">{value}</dd>
                    </div>
                  ))}
                </dl>
              </details>
              {version.approved && !version.isCurrent && (
                <button
                  className={`${button} mt-3`}
                  disabled={busy || !!intent}
                  onClick={() => {
                    setSelected(version);
                    setConfirmed(false);
                    setReason('');
                    setMessage('');
                  }}
                >
                  Make current for new assessments
                </button>
              )}
              {!version.approved && version.libraryVersion === '0.2.0' && (
                <button
                  className={`${button} mt-3`}
                  disabled={busy || !!intent}
                  onClick={() => {
                    setSelected(version);
                    setConfirmed(false);
                    setReason('');
                    setMessage('');
                  }}
                >
                  Review version for approval
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!loading && !versions.some((v) => v.libraryVersion === '0.2.0') && (
        <p className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
          Version 0.2.0 has not been published with its reviewed manifest. An operator must publish
          the candidate before founder approval is available. Existing assessments continue on their
          recorded version.
        </p>
      )}
      {selected && (
        <section
          className="space-y-3 rounded-xl border border-teal-200 bg-white p-5"
          aria-label="Approve catalogue version"
        >
          <h2 className="font-semibold text-[#1E2A4A]">
            {selected.approved ? 'Make current: version ' : 'Approve version '}
            {selected.libraryVersion}
          </h2>
          <p className="text-sm text-slate-600">
            {selected.approved
              ? 'This changes the default catalogue for new assessments. Existing assessments keep their recorded version. Select the previous approved version through this same workflow to change the default back.'
              : 'This global approval authorizes this exact catalogue and mapping. It does not change the current version, revise existing assessments, or adopt sector mappings for any organisation.'}
          </p>
          {selected.approved && (
            <p className="text-sm font-medium text-[#1E2A4A]">
              Current default:{' '}
              {versions.find((version) => version.isCurrent)?.libraryVersion ?? 'None'} →{' '}
              {selected.libraryVersion}
            </p>
          )}
          <label className="block text-sm">
            Approval reason
            <textarea
              className="mt-1 block w-full rounded-md border border-slate-300 p-2"
              maxLength={2000}
              value={reason}
              disabled={busy || !!intent}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <label className="flex gap-2 text-sm">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy || !!intent}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            {selected.approved
              ? 'I reviewed the current and target versions and approve changing the default for new assessments.'
              : 'I reviewed the version changes, control count and exact source fingerprints.'}
          </label>
          {!intent ? (
            <button
              className={button}
              disabled={busy || !reason.trim() || !confirmed}
              onClick={() => void prepare()}
            >
              Prepare approval with MFA
            </button>
          ) : (
            <>
              <p className="text-xs text-slate-600">
                Recorded review intent: {intent.operationKey}
              </p>
              <details>
                <summary className="cursor-pointer text-xs">Exact approval request</summary>
                <pre className="overflow-auto whitespace-pre-wrap break-all text-xs">
                  {canonicalJson(intent)}
                </pre>
              </details>
              <label className="block text-sm">
                Authenticator code
                <input
                  className="ml-2 rounded-md border border-slate-300 p-2"
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  value={code}
                  disabled={busy}
                  onChange={(e) => setCode(e.target.value)}
                />
              </label>
              <button
                className={button}
                disabled={busy || !code.trim()}
                onClick={() => void approve()}
              >
                {selected.approved ? 'Make reviewed version current' : 'Approve reviewed version'}
              </button>
              <button
                className={button}
                disabled={busy}
                onClick={() => {
                  setIntent(null);
                  setChallenge('');
                  setCode('');
                  setMessage('Prepared review discarded. Prepare a fresh review before approving.');
                }}
              >
                Discard prepared review
              </button>
            </>
          )}
        </section>
      )}
    </div>
  );
}
