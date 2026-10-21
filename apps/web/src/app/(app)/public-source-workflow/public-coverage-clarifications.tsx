'use client';
import { useState } from 'react';
import { z } from 'zod';
import { canonicalJson } from '@axiom/ledger';
import {
  PUBLIC_COVERAGE_PAGES,
  publicCoverageClarificationRequestSchema,
  publicCoverageClarificationRecordSchema,
  publicCoverageClarificationSnapshotSchema,
  type PublicControlAssessmentV2,
  type PublicCoverageClarificationRequest,
} from '@axiom/types';
const labels = {
  not_public: 'Available privately only',
  not_found: 'Public page not found',
  access_blocked: 'Access blocked or failed',
  interactive_content: 'Requires interactive inspection',
  not_applicable: 'Owner considers not applicable',
  needs_investigation: 'Further investigation needed',
  other: 'Other explanation',
} as const;
async function digest(text: string) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))),
    (v) => v.toString(16).padStart(2, '0'),
  ).join('');
}
export function PublicCoverageClarifications({
  actorId,
  assessment,
}: {
  actorId: string;
  assessment: PublicControlAssessmentV2;
}) {
  const source = assessment.source;
  const gaps = PUBLIC_COVERAGE_PAGES.map(
    (page) =>
      source.pages.find((p) => p.page === page) ?? {
        page,
        state: 'unexamined' as const,
        truncated: false,
      },
  ).filter((p) => p.state !== 'examined' || p.truncated);
  const storageKey = `axiom.coverage.v1/${source.tenantId}/${actorId}/${source.engagementId}/${source.checkId}/${source.projectionSha256}`;
  const [head, setHead] = useState<z.infer<typeof publicCoverageClarificationRecordSchema> | null>(
      null,
    ),
    [allowed, setAllowed] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [confirmed, setConfirmed] = useState(false);
  const [entries, setEntries] = useState<PublicCoverageClarificationRequest['clarifications']>(() =>
    gaps.map((p) => ({
      page: p.page,
      sourceState: p.state,
      sourceTruncated: p.truncated,
      reasonCategory: 'needs_investigation',
      reason: '',
      proposedPublicUrl: null,
    })),
  );
  const [pending, setPending] = useState<string | null>(null);
  const query = new URLSearchParams({
    engagementId: source.engagementId,
    checkId: source.checkId,
    payloadSha256: source.projectionSha256,
  }).toString();
  async function verify(value: unknown, requestText?: string) {
    const r = publicCoverageClarificationRecordSchema.parse(value),
      s = publicCoverageClarificationSnapshotSchema.parse(JSON.parse(r.snapshotText)),
      q = publicCoverageClarificationRequestSchema.parse(JSON.parse(r.requestText));
    if (
      r.tenantId !== source.tenantId ||
      r.engagementId !== source.engagementId ||
      r.checkId !== source.checkId ||
      r.payloadSha256 !== source.projectionSha256 ||
      r.requestSha256 !== (await digest(r.requestText)) ||
      r.snapshotSha256 !== (await digest(r.snapshotText)) ||
      canonicalJson(q) !== r.requestText ||
      canonicalJson(s) !== r.snapshotText ||
      canonicalJson(s.request) !== r.requestText ||
      s.revisionId !== r.id ||
      s.actorId !== r.actorId ||
      s.tenantId !== r.tenantId ||
      q.operationKey !== r.operationKey ||
      q.checkId !== r.checkId ||
      q.engagementId !== r.engagementId ||
      q.payloadSha256 !== r.payloadSha256 ||
      s.previousRevisionId !== q.expectedPreviousRevisionId ||
      (requestText !== undefined && (requestText !== r.requestText || r.actorId !== actorId))
    )
      throw Error('Receipt did not match the retained source and request.');
    return { r, q };
  }
  async function call(path: string, body?: string) {
    const q = body ? publicCoverageClarificationRequestSchema.parse(JSON.parse(body)) : null;
    const response = await fetch(`/api/bff/v1/public-coverage-clarifications${path}`, {
      method: body ? 'POST' : 'GET',
      cache: 'no-store',
      signal: AbortSignal.timeout(30000),
      headers: {
        'X-Tenant-Id': source.tenantId,
        ...(q
          ? {
              'Content-Type': 'application/json',
              'X-Expected-Actor-Id': actorId,
              'Idempotency-Key': q.operationKey,
            }
          : {}),
      },
      ...(body ? { body } : {}),
    });
    if (!response.ok)
      throw Error(
        `Request was refused or unavailable (${response.status}). Keep any retained request and check it again.`,
      );
    const result: unknown = await response.json();
    return z.object({ data: z.unknown() }).parse(result).data;
  }
  async function load() {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const q = publicCoverageClarificationRequestSchema.parse(JSON.parse(saved));
        if (
          q.engagementId !== source.engagementId ||
          q.checkId !== source.checkId ||
          q.payloadSha256 !== source.projectionSha256
        )
          throw Error();
        setPending(saved);
      }
    } catch {
      setPending('invalid-retained-request');
      setMessage(
        'Retained local request cannot be decoded. Do not submit another declaration until it is reconciled.',
      );
    }

    setBusy(true);
    try {
      const result = z
        .object({
          canClarify: z.boolean(),
          record: publicCoverageClarificationRecordSchema.nullable(),
        })
        .strict()
        .parse(await call(`?${query}`));
      setAllowed(result.canClarify);
      if (result.record) {
        const { r, q } = await verify(result.record);
        setHead(r);
        setEntries(q.clarifications);
      }
      setMessage('');
    } catch (e) {
      setMessage(
        e instanceof z.ZodError
          ? 'The retained declaration could not be verified. Keep any saved request and retry loading.'
          : e instanceof Error
            ? e.message
            : 'Unable to load declarations.',
      );
    } finally {
      setBusy(false);
    }
  }
  async function reconcile(submit: boolean) {
    setBusy(true);
    try {
      let text = pending;
      if (!text) {
        const request = publicCoverageClarificationRequestSchema.parse({
          version: 1,
          operationKey: crypto.randomUUID(),
          engagementId: source.engagementId,
          checkId: source.checkId,
          payloadSha256: source.projectionSha256,
          expectedPreviousRevisionId: head?.id ?? null,
          clarifications: entries,
        });
        text = canonicalJson(request);
        localStorage.setItem(storageKey, text);
        setPending(text);
      }
      const q = publicCoverageClarificationRequestSchema.parse(JSON.parse(text));
      const value = submit
        ? z
            .object({ record: publicCoverageClarificationRecordSchema, replayed: z.boolean() })
            .parse(await call('', text))
        : z
            .object({
              record: publicCoverageClarificationRecordSchema.nullable(),
              canClarify: z.boolean(),
            })
            .parse(await call(`/operations/${q.operationKey}?${query}`));
      if (!value.record) {
        setMessage('No receipt found yet. Retry the retained request; do not prepare another.');
        return;
      }
      const { r } = await verify(value.record, text);
      setHead(r);
      if (localStorage.getItem(storageKey) === text) localStorage.removeItem(storageKey);
      setPending(null);
      setConfirmed(false);
      setMessage(
        `Owner declaration retained. Receipt ${r.receiptId}. Source coverage remains unchanged.`,
      );
    } catch (e) {
      setMessage(
        e instanceof z.ZodError
          ? 'The declaration or receipt failed validation. Explain each gap using 20–2,000 characters and keep any saved request for reconciliation.'
          : e instanceof Error
            ? e.message
            : 'Unable to verify receipt. Keep the retained request.',
      );
    } finally {
      setBusy(false);
    }
  }
  if (!gaps.length) return null;
  return (
    <section
      aria-label="Owner explanations for coverage gaps"
      className="space-y-3 rounded border border-slate-200 p-4"
    >
      <h3 className="font-semibold text-indigo-900">Explain incomplete public coverage</h3>
      <p className="text-sm text-slate-600">
        SVG exclusion only affects that page’s partial coverage. Other pages are assessed
        separately. Unexamined means no accepted capture; unavailable means a request failed or was
        blocked. A missing historical page was not present in the retained capture. Owner
        explanations remain unverified declarations and never change evidence to examined or
        compliant. Suggested public URLs require a new website audit.
      </p>
      {head && (
        <p className="text-sm">
          Latest retained revision: {head.id} · Ledger receipt {head.receiptId}
        </p>
      )}
      {entries.map((entry, i) => (
        <fieldset
          key={entry.page}
          disabled={!allowed || busy || !!pending}
          className="space-y-2 rounded border border-slate-200 p-3"
        >
          <legend className="capitalize">
            {entry.page}: {entry.sourceState}
            {!source.pages.some((p) => p.page === entry.page)
              ? ' · Not present in retained capture'
              : ''}
            {entry.sourceTruncated ? ' · partial' : ''}
          </legend>
          <label className="block text-sm">
            Reason
            <select
              value={entry.reasonCategory}
              onChange={(e) => {
                setConfirmed(false);
                setEntries((v) =>
                  v.map((x, n) =>
                    n === i
                      ? { ...x, reasonCategory: e.target.value as typeof entry.reasonCategory }
                      : x,
                  ),
                );
              }}
              className="ml-2 rounded border p-1"
            >
              {Object.entries(labels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            Owner explanation (20–2,000 characters)
            <textarea
              value={entry.reason}
              minLength={20}
              maxLength={2000}
              onChange={(e) => {
                setConfirmed(false);
                setEntries((v) =>
                  v.map((x, n) => (n === i ? { ...x, reason: e.target.value } : x)),
                );
              }}
              className="block w-full rounded border p-2"
            />
          </label>
          <label className="block text-sm">
            Suggested same-origin public URL (optional)
            <input
              type="url"
              value={entry.proposedPublicUrl ?? ''}
              onChange={(e) => {
                setConfirmed(false);
                setEntries((v) =>
                  v.map((x, n) =>
                    n === i ? { ...x, proposedPublicUrl: e.target.value || null } : x,
                  ),
                );
              }}
              className="block w-full rounded border p-2"
            />
          </label>
        </fieldset>
      ))}
      {allowed && (
        <>
          <label className="block text-sm">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy || !!pending}
              onChange={(e) => setConfirmed(e.target.checked)}
            />{' '}
            I authorize retention of these owner declarations for this exact capture.
          </label>
          <button
            disabled={busy || (!pending && !confirmed)}
            onClick={() => void reconcile(true)}
            className="rounded bg-indigo-900 px-3 py-2 text-white"
          >
            {pending ? 'Retry retained declaration' : 'Retain owner explanations'}
          </button>
        </>
      )}
      {pending && (
        <button
          disabled={busy}
          onClick={() => void reconcile(false)}
          className="ml-2 rounded border px-3 py-2"
        >
          Check saved request
        </button>
      )}
      {!allowed && (
        <p className="text-sm">
          Only a current organization owner or administrator can record explanations.
        </p>
      )}
      <button
        disabled={busy || !!pending}
        onClick={() => void load()}
        className="text-sm underline"
      >
        Load / refresh owner declarations
      </button>
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
    </section>
  );
}
