'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { z } from 'zod';
import { reportRequest } from '../../reports/report-request';
import {
  applyRetainedBuild,
  mergeRetainedRequests,
  retainedArtifactSchema,
  retainedBuildResultSchema,
} from '../../reports/retained-artifact-state';

export type DpbBreach = { id: string; title: string; detected_at: string };
export type DpbNotification = {
  id: string;
  breach_id: string;
  kind: string;
  status: string;
  subject: string;
  reviewed_at: string | null;
  delivery_outcome: string | null;
};

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const artifactSchema = retainedArtifactSchema;
const requestSchema = z.object({
  requestId: z.uuid(),
  breachId: z.uuid(),
  notificationId: z.uuid(),
  title: z.string(),
  status: z.string(),
  reportId: z.uuid().nullable(),
  reportStatus: z.string().nullable(),
  contentHash: digest.nullable(),
  artifact: artifactSchema.nullable(),
  createdAt: z.string(),
});
const listSchema = z.object({ requests: z.array(requestSchema), total: z.number() });
const sourceSchema = z.object({ sourceText: z.string(), sourceSha256: digest });
const draftSchema = z.object({
  data: z.object({
    id: z.uuid(),
    kind: z.literal('dpb'),
    contentText: z.string(),
    contentHash: digest,
  }),
});
const manifestSchema = z
  .object({
    schema_version: z.literal(2),
    kind: z.literal('dpb_notification_review_pack'),
    request_id: z.uuid(),
    tenant_id: z.uuid(),
    source_sha256: digest,
    title: z.string(),
    generated_by: z.literal('dpb-report-builder'),
  })
  .strict();
type Request = z.infer<typeof requestSchema>;
type Artifact = z.infer<typeof artifactSchema>;

function errorText(error: unknown) {
  return error instanceof Error ? error.message : 'Request failed.';
}

export function DpbReviewsClient({
  tenantId,
  breaches,
  notifications,
  canRequest,
  founder,
}: {
  tenantId: string;
  breaches: DpbBreach[];
  notifications: DpbNotification[];
  canRequest: boolean;
  founder: boolean;
}) {
  const [requests, setRequests] = useState<Request[]>([]);
  const [chosenNotification, setChosenNotification] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [sourcePreview, setSourcePreview] = useState<
    Record<string, { source: string; draft: string }>
  >({});
  const [reviewConfirmed, setReviewConfirmed] = useState<Record<string, boolean>>({});
  const [releaseConfirmed, setReleaseConfirmed] = useState<Record<string, boolean>>({});
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await reportRequest(tenantId, '/reports/dpb/requests?limit=50', {
          signal: controller.signal,
        });
        const list = listSchema.parse(await response.json());
        if (controller.signal.aborted) return;
        setRequests((current) => mergeRetainedRequests(current, list.requests));
      } catch (cause) {
        if (!controller.signal.aborted) {
          setRequests([]);
          setError(errorText(cause));
        }
      }
    })();
    return () => controller.abort();
  }, [tenantId, revision]);

  async function act(path: string, body: unknown, artifactReportId?: string | null) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const response = await reportRequest(tenantId, path, { body });
      if (artifactReportId) {
        const build = retainedBuildResultSchema.parse(await response.json());
        if (build.reportId !== artifactReportId)
          throw new Error('The retained build response does not match this report.');
        setRequests((current) => applyRetainedBuild(current, build));
      } else {
        await response.arrayBuffer();
      }
      setMessage(
        response.status === 202
          ? 'Storage is pending. Reconcile the recorded operation before retrying missing versions.'
          : 'Action recorded. Refreshing the recorded state.',
      );
      refresh();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  async function download(reportId: string, artifact: Artifact) {
    if (!artifact.pdf || artifact.reportStatus !== 'published') return;
    setBusy(true);
    setError('');
    try {
      const response = await reportRequest(tenantId, `/reports/dpb/${reportId}/pdf`);
      if (
        !response.body ||
        artifact.pdf.byteSize > 32 * 1024 * 1024 ||
        !response.headers.get('Content-Type')?.startsWith('application/pdf')
      )
        throw new Error('The retained PDF response is invalid.');
      const bytes = new Uint8Array(artifact.pdf.byteSize);
      const reader = response.body.getReader();
      let offset = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          if (offset + next.value.length > bytes.length)
            throw new Error('Downloaded bytes exceed the retained PDF size.');
          bytes.set(next.value, offset);
          offset += next.value.length;
        }
      } finally {
        void reader.cancel().catch(() => undefined);
      }
      if (offset !== bytes.length)
        throw new Error('Downloaded size differs from the retained version.');
      const sha = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
        (value) => value.toString(16).padStart(2, '0'),
      ).join('');
      if (sha !== artifact.pdf.sha256 || response.headers.get('X-Report-SHA256') !== sha)
        throw new Error('Downloaded bytes differ from the released PDF hash.');
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `dpb-review-${reportId}.pdf`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage('The downloaded PDF matches the recorded retained version.');
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  async function inspectSource(requestId: string, reportId: string, expectedContentHash: string) {
    setBusy(true);
    setError('');
    try {
      const response = await reportRequest(tenantId, `/reports/dpb/requests/${requestId}/source`);
      const source = sourceSchema.parse(await response.json());
      const bytes = new TextEncoder().encode(source.sourceText);
      const sha = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
        (value) => value.toString(16).padStart(2, '0'),
      ).join('');
      if (sha !== source.sourceSha256)
        throw new Error('The frozen source bytes do not match their recorded digest.');
      const draftResponse = await reportRequest(tenantId, `/reports/${reportId}`);
      const draft = draftSchema.parse(await draftResponse.json()).data;
      const draftBytes = new TextEncoder().encode(draft.contentText);
      const draftHash = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', draftBytes)),
        (value) => value.toString(16).padStart(2, '0'),
      ).join('');
      if (
        draft.id !== reportId ||
        draftHash !== draft.contentHash ||
        draftHash !== expectedContentHash
      )
        throw new Error('The draft differs from the recorded content hash.');
      const manifest = manifestSchema.parse(JSON.parse(draft.contentText) as unknown);
      if (
        manifest.request_id !== requestId ||
        manifest.tenant_id !== tenantId ||
        manifest.source_sha256 !== source.sourceSha256
      )
        throw new Error('The draft does not bind to the frozen source.');
      setSourcePreview((previous) => ({
        ...previous,
        [requestId]: {
          source: JSON.stringify(JSON.parse(source.sourceText) as unknown, null, 2),
          draft: JSON.stringify(manifest, null, 2),
        },
      }));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  const eligible = notifications.filter(
    (item) =>
      item.kind === 'dpb' &&
      (item.status === 'reviewed' || item.status === 'sent') &&
      item.reviewed_at,
  );
  const selected = eligible.find((item) => item.id === chosenNotification);
  const breachById = new Map(breaches.map((item) => [item.id, item]));

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-6">
      <nav>
        <Link className="text-sm text-teal-700 underline" href="/breaches">
          ← Breach operations
        </Link>
      </nav>
      <header>
        <h1 className="text-2xl font-semibold text-slate-900">DPB notification review packs</h1>
        <p className="mt-2 max-w-3xl text-sm text-slate-600">
          These packs freeze a recorded breach and a second-human-reviewed DPB notification.
          Delivery outcomes are operator records. A pack does not certify forensic facts, regulator
          receipt or acceptance, or statutory filing.
        </p>
      </header>
      {error && (
        <p
          role="alert"
          className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800"
        >
          {error}
        </p>
      )}
      {message && (
        <p
          role="status"
          className="rounded border border-teal-300 bg-teal-50 p-3 text-sm text-teal-900"
        >
          {message}
        </p>
      )}
      {canRequest && (
        <form
          className="space-y-3 rounded-lg border border-slate-200 bg-white p-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!selected) return;
            void act('/reports/dpb/request', {
              breachId: selected.breach_id,
              notificationId: selected.id,
              title: title.trim(),
              operationKey: crypto.randomUUID(),
            });
          }}
        >
          <h2 className="font-semibold">Request a frozen source</h2>
          <label className="block text-sm font-medium" htmlFor="dpb-notification">
            Reviewed DPB notification
          </label>
          <select
            id="dpb-notification"
            required
            value={chosenNotification}
            onChange={(event) => setChosenNotification(event.target.value)}
            className="w-full rounded border border-slate-300 p-2 text-sm"
          >
            <option value="">Select a reviewed notification</option>
            {eligible.map((item) => (
              <option key={item.id} value={item.id}>
                {breachById.get(item.breach_id)?.title ?? item.breach_id} — {item.subject} (
                {item.status}
                {item.status === 'sent'
                  ? `, operator delivery: ${item.delivery_outcome ?? 'unrecorded'}`
                  : ''}
                )
              </option>
            ))}
          </select>
          <label className="block text-sm font-medium" htmlFor="dpb-title">
            Internal reference title (not printed in the PDF)
          </label>
          <input
            id="dpb-title"
            required
            maxLength={300}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className="w-full rounded border border-slate-300 p-2 text-sm"
          />
          <button
            disabled={busy || !selected || !title.trim()}
            className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            Freeze source
          </button>
        </form>
      )}
      <section aria-labelledby="dpb-packs">
        <h2 id="dpb-packs" className="text-lg font-semibold">
          Recorded requests
        </h2>
        <p className="mb-3 text-xs text-slate-600">
          Tenant owners and admins see their own requests. Internal founders see all requests for
          this tenant.
        </p>
        {requests.length === 0 ? (
          <p className="rounded border p-4 text-sm">No DPB review pack requests are recorded.</p>
        ) : (
          <div className="space-y-3">
            {requests.map((item) => {
              const artifact = item.artifact;
              return (
                <article
                  key={item.requestId}
                  className="space-y-3 rounded-lg border border-slate-200 bg-white p-4"
                >
                  <div>
                    <h3 className="font-medium">Internal reference: {item.title}</h3>
                    <p className="text-xs text-slate-600">
                      {breachById.get(item.breachId)?.title ?? item.breachId} · Requested{' '}
                      {new Date(item.createdAt).toLocaleString()} ·{' '}
                      {item.reportStatus ?? item.status}
                    </p>
                  </div>
                  {item.contentHash && (
                    <p className="break-all font-mono text-xs">
                      Exact draft SHA-256: {item.contentHash}
                    </p>
                  )}
                  {artifact && (
                    <p className="text-sm">
                      Retained artifacts: {artifact.status}
                      {artifact.lastErrorCode ? ` (${artifact.lastErrorCode})` : ''}
                      {artifact.pdf ? ` · PDF SHA-256 ${artifact.pdf.sha256}` : ''}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {founder && !item.reportId && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          void act(`/reports/dpb/requests/${item.requestId}/generate`, {})
                        }
                        className="rounded border px-3 py-1 text-sm disabled:opacity-50"
                      >
                        Create deterministic draft
                      </button>
                    )}
                    {founder && item.reportId && item.reportStatus === 'draft' && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          item.contentHash &&
                          void inspectSource(item.requestId, item.reportId!, item.contentHash)
                        }
                        className="rounded border px-3 py-1 text-sm disabled:opacity-50"
                      >
                        Inspect frozen source
                      </button>
                    )}
                    {founder &&
                      item.reportId &&
                      item.reportStatus === 'approved' &&
                      artifact?.status === 'not_started' && (
                        <button
                          disabled={busy}
                          onClick={() =>
                            void act(
                              `/reports/dpb/${item.reportId}/artifacts`,
                              { operationKey: crypto.randomUUID() },
                              item.reportId,
                            )
                          }
                          className="rounded border px-3 py-1 text-sm disabled:opacity-50"
                        >
                          Build retained versions
                        </button>
                      )}
                    {founder &&
                      item.reportId &&
                      artifact?.status === 'pending' &&
                      artifact.operationKey && (
                        <>
                          <button
                            disabled={busy}
                            onClick={() =>
                              void act(
                                `/reports/dpb/${item.reportId}/artifacts/reconcile`,
                                { operationKey: artifact.operationKey },
                                item.reportId,
                              )
                            }
                            className="rounded border px-3 py-1 text-sm disabled:opacity-50"
                          >
                            Reconcile
                          </button>
                          <button
                            disabled={busy}
                            onClick={() =>
                              void act(
                                `/reports/dpb/${item.reportId}/artifacts/retry-missing`,
                                { operationKey: artifact.operationKey },
                                item.reportId,
                              )
                            }
                            className="rounded border px-3 py-1 text-sm disabled:opacity-50"
                          >
                            Retry missing
                          </button>
                        </>
                      )}
                    {founder &&
                      item.reportId &&
                      item.contentHash &&
                      item.reportStatus === 'approved' &&
                      artifact?.status === 'settled' &&
                      artifact.pdf && (
                        <div className="flex flex-col gap-2">
                          <label className="flex items-start gap-2 text-sm">
                            <input
                              type="checkbox"
                              checked={!!releaseConfirmed[item.requestId]}
                              onChange={(event) =>
                                setReleaseConfirmed((previous) => ({
                                  ...previous,
                                  [item.requestId]: event.target.checked,
                                }))
                              }
                            />
                            I authorize release of this reviewed PDF hash and its retained source
                            version.
                          </label>
                          <button
                            disabled={busy || !releaseConfirmed[item.requestId]}
                            onClick={() =>
                              void act(`/reports/dpb/${item.reportId}/release`, {
                                contentHash: item.contentHash,
                                pdfHash: artifact.pdf!.sha256,
                              })
                            }
                            className="rounded bg-teal-700 px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
                          >
                            Release exact PDF
                          </button>
                        </div>
                      )}
                    {item.reportId && artifact?.reportStatus === 'published' && artifact.pdf && (
                      <button
                        disabled={busy}
                        onClick={() => void download(item.reportId!, artifact)}
                        className="rounded border px-3 py-1 text-sm disabled:opacity-50"
                      >
                        Download verified PDF
                      </button>
                    )}
                  </div>
                  {founder &&
                    item.reportId &&
                    item.reportStatus === 'draft' &&
                    sourcePreview[item.requestId] && (
                      <div className="space-y-2 rounded border border-slate-200 p-3">
                        <p className="text-sm font-medium">
                          Frozen source, verified against its SHA-256
                        </p>
                        <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words bg-slate-50 p-3 text-xs">
                          {sourcePreview[item.requestId]?.source}
                        </pre>
                        <p className="text-sm font-medium">
                          Exact draft manifest, verified against its SHA-256
                        </p>
                        <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words bg-slate-50 p-3 text-xs">
                          {sourcePreview[item.requestId]?.draft}
                        </pre>
                        <label className="flex items-start gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={!!reviewConfirmed[item.requestId]}
                            onChange={(event) =>
                              setReviewConfirmed((previous) => ({
                                ...previous,
                                [item.requestId]: event.target.checked,
                              }))
                            }
                          />
                          I reviewed this source, the stated limitations, and the exact draft
                          SHA-256 above.
                        </label>
                        <button
                          disabled={busy || !reviewConfirmed[item.requestId] || !item.contentHash}
                          onClick={() =>
                            void act(`/reports/${item.reportId}/review`, {
                              decision: 'approved',
                              expectedContentHash: item.contentHash,
                              note: 'Reviewed the frozen recorded breach and DPB notification source and its stated limitations.',
                            })
                          }
                          className="rounded bg-slate-900 px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
                        >
                          Approve exact draft
                        </button>
                      </div>
                    )}
                </article>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}
