'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { z } from 'zod';
import { EvidenceType } from '@axiom/types';
import { evidenceUploadBytes, verifyLocalFile } from './evidence-workflow';
import {
  evidenceRowSchema,
  uploadMetadataSchema,
  operationSchema,
  pageMetaSchema,
  verificationSchema,
  type EvidenceRow,
  type EvidenceOperation,
} from './evidence-contract';

const field = 'w-full rounded border border-slate-300 px-3 py-2 text-sm';
const button = 'rounded border border-slate-300 px-3 py-2 text-sm disabled:opacity-50';
const panel = 'rounded-xl border border-slate-200 bg-white p-5 space-y-4';
const listSchema = z.object({ data: z.array(evidenceRowSchema), meta: pageMetaSchema });
const operationsSchema = z.object({ data: z.array(operationSchema), meta: pageMetaSchema });
const operationResponse = z.object({ data: operationSchema });
const providerResponse = z.object({ data: verificationSchema });
function date(value: string) {
  return new Date(value).toLocaleString();
}

export function EvidenceClient({
  tenantId,
  canRecord,
  canExport,
  initialQuery = '',
}: {
  tenantId: string;
  canRecord: boolean;
  canExport: boolean;
  initialQuery?: string;
}) {
  const [rows, setRows] = useState<EvidenceRow[]>([]);
  const [meta, setMeta] = useState({ limit: 20, offset: 0, total: 0, hasMore: false });
  const [query, setQuery] = useState(() =>
    initialQuery ? `&${new URLSearchParams({ q: initialQuery })}` : '',
  );
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<EvidenceRow | null>(null);
  const selection = useRef<string | null>(null);
  const [localResult, setLocalResult] = useState<Awaited<
    ReturnType<typeof verifyLocalFile>
  > | null>(null);
  const [providerResult, setProviderResult] = useState<z.infer<typeof verificationSchema> | null>(
    null,
  );
  const [operations, setOperations] = useState<EvidenceOperation[]>([]);
  const [operationOffset, setOperationOffset] = useState(0);
  const [operationMore, setOperationMore] = useState(false);
  const [operationsLoading, setOperationsLoading] = useState(true);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const uploadKeys = useRef(new Map<string, string>());
  const headers = useCallback(() => ({ 'x-tenant-id': tenantId }), [tenantId]);
  const request = useCallback(
    async (path: string, body?: unknown, signal?: AbortSignal) => {
      const response = await fetch(`/api/bff/v1/evidence${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        cache: 'no-store',
        signal,
        headers: {
          ...headers(),
          ...(body === undefined
            ? {}
            : { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) {
        const parsed = z
          .object({ error: z.object({ code: z.string() }) })
          .safeParse(await response.json().catch(() => null));
        throw new Error(
          parsed.success ? parsed.data.error.code : `Request failed (${response.status}).`,
        );
      }
      return response;
    },
    [headers],
  );
  useEffect(() => {
    const controller = new AbortController();
    void request(`?limit=20&offset=${offset}${query}`, undefined, controller.signal)
      .then((response) => response.json())
      .then((value) => {
        if (controller.signal.aborted) return;
        const result = listSchema.parse(value);
        setRows(result.data);
        setMeta(result.meta);
      })
      .catch((err) => {
        if (!controller.signal.aborted)
          setError(err instanceof Error ? err.message : 'Unable to load evidence.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [request, query, offset, revision]);
  useEffect(() => {
    if (!canRecord) return;
    const controller = new AbortController();
    void request(`/ingestions?limit=20&offset=${operationOffset}`, undefined, controller.signal)
      .then((response) => response.json())
      .then((value) => {
        if (controller.signal.aborted) return;
        const result = operationsSchema.parse(value);
        setOperations(result.data);
        setOperationMore(result.meta.hasMore);
      })
      .catch((err) => {
        if (!controller.signal.aborted)
          setError(err instanceof Error ? err.message : 'Unable to load upload operations.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setOperationsLoading(false);
      });
    return () => controller.abort();
  }, [canRecord, request, revision, operationOffset]);
  function refresh() {
    setLoading(true);
    setOperationsLoading(true);
    setRows([]);
    setError('');
    setRevision((v) => v + 1);
  }
  function moveRecords(next: number) {
    setLoading(true);
    setRows([]);
    setError('');
    setOffset(next);
  }
  function moveOperations(next: number) {
    setOperationsLoading(true);
    setOperationOffset(next);
  }
  function choose(row: EvidenceRow) {
    selection.current = row.id;
    setSelected(row);
    setLocalResult(null);
    setProviderResult(null);
    setError('');
  }
  async function action(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await work();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed.');
    } finally {
      setBusy(false);
    }
  }
  function filter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const params = new URLSearchParams();
    for (const key of ['q', 'controlId', 'source', 'from', 'to']) {
      const value = String(data.get(key) || '').trim();
      if (value) params.set(key, value);
    }
    setLoading(true);
    setRows([]);
    setError('');
    setOffset(0);
    setQuery(params.size ? `&${params}` : '');
    setRevision((v) => v + 1);
    setOperationsLoading(true);
    selection.current = null;
    setSelected(null);
    setLocalResult(null);
    setProviderResult(null);
  }
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!uploadFile || !confirmed) return;
    const form = new FormData(event.currentTarget);
    const file = uploadFile;
    await action(async () => {
      const encoded = await evidenceUploadBytes(file);
      const metadata = uploadMetadataSchema.parse({
        filename: file.name,
        contentType: file.type || 'application/octet-stream',
        evidenceType: String(form.get('evidenceType')),
        description: String(form.get('description')).trim(),
        controlIds: String(form.get('controls') || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        engagementId: String(form.get('engagementId') || '').trim() || null,
      });
      const fingerprint = JSON.stringify([encoded.fingerprint, metadata]);
      const operationKey = uploadKeys.current.get(fingerprint) || crypto.randomUUID();
      uploadKeys.current.set(fingerprint, operationKey);
      // Retain the stable operation key on an uncertain response. No automatic retry or second PUT.
      setMessage(
        `Upload operation ${operationKey}. If interrupted, refresh operations before retrying.`,
      );
      const result = operationResponse.parse(
        await (
          await request('/ingestions', {
            operationKey,
            ...metadata,
            contentBase64: encoded.contentBase64,
          })
        ).json(),
      ).data;
      setMessage(
        result.status === 'settled'
          ? 'Evidence stored; its exact-version receipt is recorded.'
          : `Upload pending (${result.operationKey}). Reconcile to check storage; pending is not verified evidence.`,
      );
      refresh();
    });
  }
  return (
    <div className="space-y-5 text-slate-800">
      <header>
        <h1 className="text-2xl font-semibold text-[#1E2A4A]">Evidence vault</h1>
        <p className="mt-2 text-sm text-slate-600">
          Inspect recorded evidence, check exact stored versions, or compare a local file against
          its recorded SHA-256.
        </p>
      </header>
      {error && (
        <p role="alert" className="rounded border border-red-200 bg-red-50 p-3">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="rounded border border-teal-200 bg-teal-50 p-3 break-all">
          {message}
        </p>
      )}
      <form onSubmit={filter} className={panel} aria-label="Evidence filters">
        <div className="grid gap-3 md:grid-cols-3">
          <label>
            Search description or evidence ID
            <input name="q" defaultValue={initialQuery} maxLength={120} className={field} />
          </label>
          <label>
            Control ID
            <input name="controlId" className={field} />
          </label>
          <label>
            Source
            <input name="source" placeholder="Exact source, e.g. human" className={field} />
          </label>
          <label>
            Collected from (UTC)
            <input name="from" type="date" className={field} />
          </label>
          <label>
            Collected to (UTC)
            <input name="to" type="date" className={field} />
          </label>
        </div>
        <button className={button}>Apply filters</button>{' '}
        <button type="button" className={button} onClick={() => refresh()}>
          Refresh records
        </button>
      </form>
      <div className="grid gap-5 lg:grid-cols-2">
        <section className={panel} aria-label="Evidence records">
          <h2 className="font-semibold">Recorded evidence</h2>
          {loading ? (
            <p role="status">Loading evidence…</p>
          ) : !error ? (
            <p>{meta.total} matching records</p>
          ) : null}
          {!loading && !error && rows.length === 0 && <p>No evidence matches these filters.</p>}
          {rows.map((row) => (
            <button
              type="button"
              key={row.id}
              onClick={() => choose(row)}
              aria-pressed={selected?.id === row.id}
              className="block w-full rounded border border-slate-200 p-3 text-left hover:border-teal-600"
            >
              <strong>{row.filename || row.description || row.id}</strong>
              <span className="block break-all text-xs">{row.id}</span>
              <span className="block text-sm">
                {row.assurance === 'verified_at_ingest'
                  ? 'Provider receipt recorded'
                  : 'Legacy record — storage unverified'}{' '}
                · {date(row.collected_at)}
              </span>
            </button>
          ))}
          <div className="flex gap-2">
            <button
              className={button}
              disabled={loading || offset === 0}
              onClick={() => moveRecords(Math.max(0, offset - 20))}
            >
              Previous records
            </button>
            <button
              className={button}
              disabled={loading || !meta.hasMore}
              onClick={() => moveRecords(offset + 20)}
            >
              Next records
            </button>
          </div>
        </section>
        {selected ? (
          <section className={panel} aria-label="Evidence inspector">
            <h2 className="font-semibold break-all">{selected.filename || selected.id}</h2>
            <p>{selected.description || 'No description recorded.'}</p>
            <dl className="space-y-2 text-sm break-all">
              <dt>Evidence ID</dt>
              <dd>{selected.id}</dd>
              <dt>SHA-256</dt>
              <dd className="font-mono">{selected.content_hash}</dd>
              <dt>Recorded size</dt>
              <dd>{selected.byte_size === null ? 'Unknown' : `${selected.byte_size} bytes`}</dd>
              <dt>Source</dt>
              <dd>{selected.collected_by_agent || 'Unspecified'}</dd>
              <dt>Collected</dt>
              <dd>{date(selected.collected_at)}</dd>
              <dt>Linked controls</dt>
              <dd>
                {selected.demonstrates_control_ids.length
                  ? selected.demonstrates_control_ids.map((id) => (
                      <Link
                        className="mr-3 underline"
                        key={id}
                        href={`/controls?q=${encodeURIComponent(id)}`}
                      >
                        {id}
                      </Link>
                    ))
                  : 'None recorded'}
              </dd>
            </dl>
            {selected.object_version ? (
              <div className="rounded bg-slate-50 p-3 text-sm break-all">
                <p>
                  Provider: {selected.object_version.provider} · Encryption:{' '}
                  {selected.object_version.encryption}
                </p>
                <p>Exact version: {selected.object_version.version_id}</p>
                <p>
                  COMPLIANCE retention recorded until {date(selected.object_version.retain_until)}
                </p>
                <p>
                  Provider readback: {date(selected.object_version.readback_at)} · Legal hold:{' '}
                  {selected.object_version.legal_hold ? 'On' : 'Off'}
                </p>
                <p>
                  This receipt records the ingestion check. Use provider verification for a fresh
                  check.
                </p>
              </div>
            ) : (
              <p>
                Legacy record: no immutable object-version receipt. Retention and stored-byte
                integrity are unverified.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <button
                className={button}
                disabled={busy || !selected.object_version}
                onClick={() =>
                  void action(async () => {
                    const row = selected;
                    setProviderResult(null);
                    const result = providerResponse.parse(
                      await (await request(`/${row.id}/verify`, {})).json(),
                    ).data;
                    if (selection.current === row.id && result.evidenceId === row.id)
                      setProviderResult(result);
                  })
                }
              >
                Verify provider receipt
              </button>
              {canExport && (
                <button
                  className={button}
                  disabled={busy || !selected.object_version}
                  onClick={() =>
                    void action(async () => {
                      const row = selected;
                      const response = await request(`/${row.id}/content`);
                      const blob = await response.blob();
                      const url = URL.createObjectURL(blob);
                      const link = document.createElement('a');
                      link.href = url;
                      link.download = row.filename || `${row.id}.bin`;
                      link.click();
                      setTimeout(() => URL.revokeObjectURL(url), 1000);
                    })
                  }
                >
                  Download exact version
                </button>
              )}
            </div>
            {providerResult && (
              <p role="status">
                Stored-byte integrity and provider retention verified at{' '}
                {date(providerResult.verifiedAt)} for version {providerResult.versionId}.
              </p>
            )}
            <div className="border-t pt-4 space-y-2">
              <h3 className="font-semibold">Compare a local file</h3>
              <p className="text-sm">
                Read locally only; this file is never uploaded. A hash match does not prove storage
                retention. Maximum 32 MiB.
              </p>
              <input
                key={selected.id}
                aria-label="Local file to verify"
                type="file"
                disabled={busy}
                onChange={(event) => {
                  setLocalResult(null);
                  const file = event.target.files?.[0];
                  const row = selected;
                  if (file)
                    void action(async () => {
                      const result = await verifyLocalFile(file, row.content_hash, row.byte_size);
                      if (selection.current === row.id) setLocalResult(result);
                    });
                }}
              />
              {localResult && (
                <div role="status" className="break-all text-sm">
                  <p>SHA-256: {localResult.computedHash}</p>
                  <p>
                    {localResult.hashMatches
                      ? 'Hash matches the recorded digest.'
                      : 'Hash mismatch: this file differs from the recorded digest.'}
                  </p>
                  <p>
                    {localResult.byteSize} bytes ·{' '}
                    {localResult.sizeMatches === null
                      ? 'Recorded size unknown'
                      : localResult.sizeMatches
                        ? 'Size matches'
                        : 'Size mismatch'}
                  </p>
                </div>
              )}
            </div>
          </section>
        ) : (
          <section className={panel}>
            <p>Select a record to inspect its metadata and verification evidence.</p>
          </section>
        )}
      </div>
      {canRecord && (
        <>
          <form
            onSubmit={(event) => void upload(event)}
            className={panel}
            aria-label="Upload evidence"
          >
            <h2 className="font-semibold">Upload evidence</h2>
            <p className="text-sm">
              Human-submitted evidence is retained under the product’s seven-year policy. COMPLIANCE
              retention cannot be shortened or the object deleted before expiry.
            </p>
            <fieldset disabled={busy} className="grid gap-3 md:grid-cols-2">
              <label>
                Evidence file (maximum 8 MiB)
                <input
                  type="file"
                  required
                  className={field}
                  onChange={(event) => {
                    setUploadFile(event.target.files?.[0] || null);
                    setConfirmed(false);
                  }}
                />
              </label>
              <label>
                Evidence type
                <select name="evidenceType" aria-label="Evidence type" className={field}>
                  {Object.values(EvidenceType).map((type) => (
                    <option key={type}>{type}</option>
                  ))}
                </select>
              </label>
              <label>
                Description
                <textarea name="description" required maxLength={2000} className={field} />
              </label>
              <label>
                Control IDs (comma separated)
                <input name="controls" className={field} />
              </label>
              <label>
                Engagement ID (optional)
                <input name="engagementId" className={field} />
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  required
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                I reviewed this file and authorize its seven-year retention.
              </label>
            </fieldset>
            <button className={button} disabled={busy || !uploadFile || !confirmed}>
              Upload evidence
            </button>
          </form>
          <section className={panel} aria-label="Upload operations">
            <h2 className="font-semibold">Upload operations</h2>
            <p className="text-sm">
              Pending operations are not verified evidence. Reconciliation checks whether the exact
              uploaded version exists; it never uploads another copy.
            </p>
            {operationsLoading ? (
              <p>Loading upload operations…</p>
            ) : (
              operations.length === 0 && <p>No upload operations recorded on this page.</p>
            )}
            {operations.map((operation) => (
              <div key={operation.operationKey} className="rounded border p-3 text-sm break-all">
                <p>
                  {operation.operationKey} · {operation.status} · {date(operation.createdAt)}
                </p>
                {operation.errorCode && <p>Last outcome: {operation.errorCode}</p>}
                {operation.evidenceId && <p>Evidence: {operation.evidenceId}</p>}
                {operation.status === 'pending' && (
                  <button
                    className={button}
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        const result = operationResponse.parse(
                          await (
                            await request(`/ingestions/${operation.operationKey}/reconcile`, {})
                          ).json(),
                        ).data;
                        setMessage(
                          result.status === 'settled'
                            ? 'Upload reconciled; receipt recorded.'
                            : `Still pending: ${result.errorCode || 'no verifiable stored version yet'}.`,
                        );
                        refresh();
                      })
                    }
                  >
                    Reconcile upload
                  </button>
                )}
              </div>
            ))}
            <div className="flex gap-2">
              <button
                className={button}
                disabled={operationOffset === 0 || busy}
                onClick={() => moveOperations(Math.max(0, operationOffset - 20))}
              >
                Previous operations
              </button>
              <button
                className={button}
                disabled={!operationMore || busy}
                onClick={() => moveOperations(operationOffset + 20)}
              >
                Next operations
              </button>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
