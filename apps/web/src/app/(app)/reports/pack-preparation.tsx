'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { z } from 'zod';
import { evidenceRowSchema, pageMetaSchema, type EvidenceRow } from '../evidence/evidence-contract';
import { preparePackBody, reportRequest } from './report-request';
import { button, field, panel, failure } from './report-ui';
import { EngagementPicker } from './engagement-picker';
const evidenceList = z.object({ data: z.array(evidenceRowSchema), meta: pageMetaSchema });

export function PackPreparation({
  tenantId,
  onPrepared,
}: {
  tenantId: string;
  onPrepared: (reportId: string) => void;
}) {
  const [rows, setRows] = useState<EvidenceRow[]>([]);
  const [selected, setSelected] = useState<Record<string, EvidenceRow>>({});
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [listError, setListError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [scopeReady, setScopeReady] = useState(false);
  const [revision, setRevision] = useState(0);
  const operationKey = useRef<string | null>(null);
  function changed() {
    setConfirmed(false);
    operationKey.current = null;
    setError('');
  }
  function reload(next = offset) {
    setOffset(next);
    setLoading(true);
    setRows([]);
    setListError('');
    setRevision((v) => v + 1);
  }
  useEffect(() => {
    const controller = new AbortController();
    void reportRequest(
      tenantId,
      `/evidence?limit=20&offset=${offset}&q=${encodeURIComponent(query)}`,
      { signal: controller.signal },
    )
      .then((response) => response.json())
      .then((value) => {
        if (controller.signal.aborted) return;
        const result = evidenceList.parse(value);
        setRows(result.data);
        setMore(result.meta.hasMore);
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setListError(failure(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [tenantId, offset, query, revision]);
  async function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    try {
      operationKey.current ??= crypto.randomUUID();
      const body = preparePackBody(
        new FormData(event.currentTarget),
        Object.keys(selected),
        operationKey.current,
      );
      setBusy(true);
      const response = await reportRequest(tenantId, '/evidence-packs', { body });
      const result = z
        .object({ data: z.object({ reportId: z.uuid() }) })
        .parse(await response.json());
      setConfirmed(false);
      onPrepared(result.data.reportId);
    } catch (err) {
      setError(failure(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className={panel} aria-label="Prepare evidence pack">
      <h2 className="text-lg font-semibold">Prepare evidence pack</h2>
      <p className="text-sm text-slate-600">
        Select 1–20 verified human-submitted versions, up to 48 MiB in total. A storage receipt
        proves retained bytes, not the truth of a document. Reference, sandbox and unknown
        collection provenance cannot establish production compliance.
      </p>
      <form
        aria-label="Find pack evidence"
        className="flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setQuery(search);
          reload(0);
        }}
      >
        <label className="min-w-0 flex-1 text-sm">
          Description or evidence UUID
          <input
            className={`${field} mt-1`}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <button type="submit" className={button} disabled={busy || loading}>
          Find evidence
        </button>
        <button
          type="button"
          className={button}
          disabled={busy || loading}
          onClick={() => reload()}
        >
          Retry evidence list
        </button>
      </form>
      <div aria-label="Available evidence versions" aria-busy={loading} className="space-y-2">
        {loading ? (
          <p role="status">Loading available evidence…</p>
        ) : listError ? (
          <p role="alert" className="text-[#D9534F]">
            {listError}
          </p>
        ) : rows.length === 0 ? (
          <p>No evidence matches this search.</p>
        ) : (
          rows.map((row) => {
            const receiptId = row.object_version?.id;
            const eligible = !!receiptId && row.collected_by_agent === 'human';
            return (
              <label
                key={row.id}
                className="flex min-w-0 items-start gap-3 rounded border border-slate-200 p-3 text-sm"
              >
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={!!receiptId && !!selected[receiptId]}
                  disabled={
                    busy ||
                    !eligible ||
                    (!selected[receiptId!] && Object.keys(selected).length >= 20)
                  }
                  onChange={(event) => {
                    if (!receiptId) return;
                    const checked = event.target.checked;
                    changed();
                    setSelected((old) => {
                      const next = { ...old };
                      if (checked) next[receiptId] = row;
                      else delete next[receiptId];
                      return next;
                    });
                  }}
                />
                <span className="min-w-0 break-words">
                  <span className="block font-medium">{row.filename ?? row.id}</span>
                  <span className="block">{row.description}</span>
                  <span className="block text-slate-600">
                    {eligible
                      ? `Verified human submission · ${row.byte_size ?? 0} bytes`
                      : 'Unavailable: legacy or unbound collection provenance'}
                  </span>
                </span>
              </label>
            );
          })
        )}
        <div className="flex flex-wrap gap-2">
          <button
            className={button}
            disabled={busy || loading || offset === 0}
            onClick={() => reload(Math.max(0, offset - 20))}
          >
            Previous evidence
          </button>
          <button
            className={button}
            disabled={busy || loading || !!listError || !more}
            onClick={() => reload(offset + 20)}
          >
            Next evidence
          </button>
        </div>
      </div>
      <p className="text-sm">
        {Object.keys(selected).length} versions selected ·{' '}
        {Object.values(selected).reduce((sum, row) => sum + (row.byte_size ?? 0), 0)} bytes
      </p>
      {Object.keys(selected).length > 0 && (
        <ul className="space-y-1">
          {Object.entries(selected).map(([id, row]) => (
            <li key={id} className="flex min-w-0 items-center justify-between gap-2 text-sm">
              <span className="break-all">{row.filename ?? row.id}</span>
              <button
                className={button}
                disabled={busy}
                onClick={() => {
                  changed();
                  setSelected((old) => {
                    const next = { ...old };
                    delete next[id];
                    return next;
                  });
                }}
                aria-label={`Remove ${row.filename ?? row.id}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <form aria-label="Prepare pack" className="space-y-3" onSubmit={prepare}>
        <label className="block text-sm">
          Pack title
          <input
            name="title"
            required
            maxLength={200}
            disabled={busy}
            className={`${field} mt-1`}
            onChange={changed}
          />
        </label>
        <EngagementPicker
          tenantId={tenantId}
          disabled={busy}
          onChanged={changed}
          onReady={setScopeReady}
        />
        <p className="text-xs text-slate-600">
          An unscoped pack accepts only unscoped evidence. An engagement pack accepts evidence for
          that engagement and unscoped evidence. The server binds the applicable control library.
        </p>
        <label className="flex gap-2 text-sm">
          <input
            type="checkbox"
            name="confirmed"
            checked={confirmed}
            disabled={busy}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          I reviewed the selected evidence and authorize preparing this immutable pack for founder
          review.
        </label>
        <button
          className={button}
          type="submit"
          disabled={busy || !confirmed || !scopeReady || Object.keys(selected).length === 0}
        >
          {busy ? 'Preparing…' : 'Prepare pack for review'}
        </button>
        {error && (
          <p role="alert" className="text-sm text-[#D9534F]">
            {error}
          </p>
        )}
      </form>
    </section>
  );
}
