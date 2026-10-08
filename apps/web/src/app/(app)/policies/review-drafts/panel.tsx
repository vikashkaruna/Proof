'use client';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import {
  workflowPageResponseSchema,
  type ReviewedWorkflowInput,
  type WorkflowRecord,
} from '@axiom/types';
import {
  DRAFT_CHANGED,
  draftKey,
  readDraftJournal,
  retainDraftJournal,
  retainDraftAcknowledgement,
  readDraftSource,
  submitDraft,
  recoverDraft,
  resolveDraftAcknowledgement,
  archiveDraftReference,
  draftMatchesJournal,
  acknowledgementMatchesJournal,
  type DraftJournal,
  type ConfirmedDraft,
  type ConfirmedAcknowledgement,
  DraftRequestError,
} from './request';

const button =
  'rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-indigo-700 disabled:cursor-not-allowed disabled:opacity-50';
export function ReviewDraftPanel(props: {
  tenantId: string;
  actorId: string;
  canSavePolicy: boolean;
}) {
  return <Panel key={`${props.tenantId}:${props.actorId}:${props.canSavePolicy}`} {...props} />;
}
function Panel({
  tenantId,
  actorId,
  canSavePolicy,
}: {
  tenantId: string;
  actorId: string;
  canSavePolicy: boolean;
}) {
  const key = draftKey(tenantId, actorId),
    mounted = useRef(true),
    active = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const subscribe = useCallback(
    (notify: () => void) => {
      const changed = (event: StorageEvent) => {
        if (event.key === key || event.key === null) notify();
      };
      window.addEventListener('storage', changed);
      window.addEventListener(DRAFT_CHANGED, notify);
      return () => {
        window.removeEventListener('storage', changed);
        window.removeEventListener(DRAFT_CHANGED, notify);
      };
    },
    [key],
  );
  const read = useCallback(() => {
    try {
      return localStorage.getItem(key);
    } catch {
      return '__blocked__';
    }
  }, [key]);
  const raw = useSyncExternalStore(subscribe, read, () => '__unhydrated__');
  const journal = useMemo(() => {
    if (raw === '__unhydrated__') return { ready: false, value: null, invalid: false };
    try {
      return {
        ready: true,
        value: readDraftJournal({ getItem: () => raw }, tenantId, actorId),
        invalid: false,
      };
    } catch {
      return { ready: false, value: null, invalid: true };
    }
  }, [raw, tenantId, actorId]);
  const [rows, setRows] = useState<WorkflowRecord[]>([]),
    [offset, setOffset] = useState(0),
    [hasMore, setHasMore] = useState(false),
    [selected, setSelected] = useState<string[]>([]),
    [preview, setPreview] = useState<ReviewedWorkflowInput | null>(null),
    [result, setResult] = useState<ConfirmedDraft | null>(null),
    [ack, setAck] = useState<ConfirmedAcknowledgement | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [confirmSource, setConfirmSource] = useState(false),
    [confirmAck, setConfirmAck] = useState(false),
    [policyIndex, setPolicyIndex] = useState<string>(''),
    [reason, setReason] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    let alive = true;
    void Promise.all(
      ['ropa', 'delivery_task'].map(async (kind) => {
        const response = await fetch(
          `/api/bff/v1/operator-workflows/records?kind=${kind}&limit=20&offset=${offset}`,
          { cache: 'no-store', signal: controller.signal, headers: { 'X-Tenant-Id': tenantId } },
        );
        if (!response.ok) throw new Error('Recorded source choices are unavailable.');
        const page = workflowPageResponseSchema.parse(await response.json());
        if (
          page.meta.limit !== 20 ||
          page.meta.offset !== offset ||
          page.data.some((r) => r.kind !== kind || r.tenant_id !== tenantId)
        )
          throw new Error('The source choices did not match this organisation.');
        return page;
      }),
    )
      .then((pages) => {
        if (alive) {
          setRows(pages.flatMap((p) => p.data));
          setHasMore(pages.some((p) => p.meta.hasMore));
        }
      })
      .catch(() => {
        if (alive)
          setError('Recorded source choices are unavailable. Retained requests are preserved.');
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [tenantId, actorId, offset]);
  const retained = journal.value;
  const currentResult = result && retained && draftMatchesJournal(result, retained) ? result : null;
  const currentAck =
    ack && retained?.acknowledgement && acknowledgementMatchesJournal(ack, retained) ? ack : null;
  async function protectedAction(action: (live: DraftJournal | null) => Promise<void>) {
    if (active.current || !journal.ready) return;
    active.current = true;
    setBusy(true);
    setError(null);
    try {
      if (!navigator.locks)
        throw new DraftRequestError(
          'Cross-tab request protection is unavailable. Nothing was submitted.',
        );
      await navigator.locks.request(key, async () => {
        if (!mounted.current) return;
        const live = readDraftJournal(localStorage, tenantId, actorId);
        if (JSON.stringify(live) !== JSON.stringify(retained))
          throw new DraftRequestError(
            'The retained request changed in another tab. Reload before continuing.',
          );
        await action(live);
      });
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof DraftRequestError
            ? cause.message
            : 'The response was interrupted or could not be verified. Preserve the retained request and check its outcome.',
        );
    } finally {
      active.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function showSource() {
    if (active.current || selected.length === 0 || retained) return;
    setBusy(true);
    setError(null);
    active.current = true;
    try {
      const records = rows.filter(
        (r): r is Extract<WorkflowRecord, { kind: 'ropa' | 'delivery_task' }> =>
          (r.kind === 'ropa' || r.kind === 'delivery_task') && selected.includes(r.id),
      );
      const engagementId = records[0]?.payload.engagementId;
      if (
        !engagementId ||
        records.length !== selected.length ||
        records.some((r) => r.payload.engagementId !== engagementId)
      )
        throw new DraftRequestError('Select records from one bound engagement.');
      const value = await readDraftSource(tenantId, actorId, engagementId, selected);
      if (mounted.current) {
        setPreview(value);
        setConfirmSource(false);
      }
    } catch (cause) {
      if (mounted.current)
        setError(cause instanceof Error ? cause.message : 'Source review is unavailable.');
    } finally {
      active.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const execute = (retry: boolean) =>
    protectedAction(async (live) => {
      let value = live;
      if (!value) {
        if (retry || !preview || !confirmSource)
          throw new DraftRequestError('Review and confirm the retained human source first.');
        value = {
          version: 1,
          tenantId,
          actorId,
          input: preview,
          request: {
            engagementId: preview.engagement_id,
            recordIds: preview.records.map((r) => r.id),
            sourceDigest: preview.source_records_sha256,
            operationKey: crypto.randomUUID(),
            confirmSourceReview: true,
          },
        };
        retainDraftJournal(localStorage, value);
      }
      const confirmed = await submitDraft(value);
      if (!mounted.current) return;
      if (
        JSON.stringify(readDraftJournal(localStorage, tenantId, actorId)) !== JSON.stringify(value)
      )
        throw new DraftRequestError('The retained request changed. This response was not adopted.');
      setResult(confirmed);
    });
  const check = () =>
    protectedAction(async (live) => {
      if (!live) return;
      const confirmed = await recoverDraft(live);
      let acknowledgement: ConfirmedAcknowledgement | null = null;
      if (live.acknowledgement) acknowledgement = await resolveDraftAcknowledgement(live, true);
      if (!mounted.current) return;
      if (
        JSON.stringify(readDraftJournal(localStorage, tenantId, actorId)) !== JSON.stringify(live)
      )
        throw new DraftRequestError('The retained request changed during recovery.');
      setResult(confirmed);
      setAck(acknowledgement);
    });
  const acknowledge = (retry: boolean) =>
    protectedAction(async (live) => {
      if (!live) throw new DraftRequestError('No original request is retained.');
      let value = live;
      if (!value.acknowledgement) {
        if (retry || !currentResult || !confirmAck)
          throw new DraftRequestError(
            'Confirm the exact saved output before requesting an acknowledgement.',
          );
        const index = policyIndex === '' ? null : Number(policyIndex);
        if (index !== null && !canSavePolicy)
          throw new DraftRequestError('This account cannot save policy drafts.');
        value = retainDraftAcknowledgement(localStorage, value, {
          operationKey: crypto.randomUUID(),
          body: {
            runId: currentResult.invocation.runId,
            outputHash: currentResult.invocation.responseHash,
            policyIndex: index,
            reason,
            confirmReview: true,
          },
        });
      }
      const confirmed = await resolveDraftAcknowledgement(value, false);
      const refreshed = await recoverDraft(value);
      if (!mounted.current) return;
      if (
        JSON.stringify(readDraftJournal(localStorage, tenantId, actorId)) !== JSON.stringify(value)
      )
        throw new DraftRequestError(
          'The acknowledgement reference changed. Keep its retained request.',
        );
      setAck(confirmed);
      setResult(refreshed);
    });
  const archive = () =>
    protectedAction(async (live) => {
      if (!live) return;
      const confirmed = await recoverDraft(live),
        acknowledgement = live.acknowledgement
          ? await resolveDraftAcknowledgement(live, true)
          : undefined;
      if (!mounted.current) return;
      archiveDraftReference(localStorage, live, confirmed, acknowledgement);
      setResult(null);
      setAck(null);
      setPreview(null);
      setSelected([]);
      setConfirmSource(false);
      setConfirmAck(false);
      setPolicyIndex('');
      setReason('');
    });
  return (
    <section
      aria-labelledby="reviewed-draft-title"
      className="min-w-0 space-y-4 rounded-lg border border-slate-200 bg-white p-4"
    >
      <h2 id="reviewed-draft-title" className="text-lg font-semibold text-indigo-950">
        Review retained declarations with Vibhaag
      </h2>
      <p className="text-sm text-slate-600">
        Human declarations remain unverified. Public website provenance does not prove private
        processing, legal compliance or contracts. Task time is human-reported, with no verified
        measurement or reporting period. This workflow proposes artifacts and authorises no
        publication or execution.
      </p>
      {error && (
        <p
          role="alert"
          className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
        >
          {error}
        </p>
      )}
      {journal.invalid && (
        <p role="alert">
          The retained request is unreadable or browser storage is unavailable. Preserve it for
          review; no new request can be submitted.
        </p>
      )}
      {!retained && (
        <fieldset disabled={busy || !journal.ready} className="space-y-3">
          <legend className="font-medium">
            1. Select retained human source records from one engagement
          </legend>
          {rows.length === 0 && (
            <p className="text-sm text-slate-600">
              No records on this page.{' '}
              <Link className="text-indigo-700 underline" href="/datamap">
                Record processing declarations or reported tasks
              </Link>
              .
            </p>
          )}
          {rows
            .filter((r) => r.kind === 'ropa' || r.kind === 'delivery_task')
            .map((row) => (
              <label
                key={row.id}
                className="flex items-start gap-3 rounded border border-slate-200 p-3 text-sm"
              >
                <input
                  type="checkbox"
                  checked={selected.includes(row.id)}
                  disabled={
                    !row.payload.engagementId ||
                    (!selected.includes(row.id) && selected.length >= 20)
                  }
                  onChange={(event) => {
                    setSelected((old) =>
                      event.target.checked ? [...old, row.id] : old.filter((id) => id !== row.id),
                    );
                    setPreview(null);
                    setConfirmSource(false);
                  }}
                />
                <span className="min-w-0 break-words">
                  {row.kind === 'ropa'
                    ? row.payload.system
                    : row.kind === 'delivery_task'
                      ? row.payload.taskName
                      : ''}
                  <span className="block text-xs text-slate-500">
                    {row.kind === 'ropa' ? 'Processing declaration' : 'Reported task'} · human
                    receipt {row.receipt_id} ·{' '}
                    {row.payload.engagementId
                      ? `Engagement ${row.payload.engagementId}`
                      : 'No engagement bound; unavailable for this workflow'}
                  </span>
                </span>
              </label>
            ))}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={button}
              disabled={offset === 0}
              onClick={() => {
                setPreview(null);
                setSelected([]);
                setConfirmSource(false);
                setOffset((v) => Math.max(0, v - 20));
              }}
            >
              Previous source records
            </button>
            <button
              type="button"
              className={button}
              disabled={!hasMore}
              onClick={() => {
                setPreview(null);
                setSelected([]);
                setConfirmSource(false);
                setOffset((v) => v + 20);
              }}
            >
              Next source records
            </button>
            <button
              type="button"
              className={button}
              disabled={selected.length === 0}
              onClick={() => void showSource()}
            >
              Review selected source
            </button>
          </div>
        </fieldset>
      )}
      {(preview || retained) && (
        <div className="space-y-3">
          <h3 className="font-medium">Exact retained human declarations</h3>
          <p className="break-all text-xs text-slate-500">
            Source digest {(retained?.input ?? preview)!.source_records_sha256}
          </p>
          {(retained?.input ?? preview)!.records.map((record) => (
            <details key={record.id} className="rounded border border-slate-200 p-3">
              <summary className="cursor-pointer text-sm">
                {record.kind === 'ropa' ? record.payload.system : record.payload.taskName} ·
                original human receipt {record.receipt_id}
              </summary>
              <pre className="mt-3 whitespace-pre-wrap break-words text-xs">
                {JSON.stringify(record.payload, null, 2)}
              </pre>
            </details>
          ))}
        </div>
      )}
      {!retained && preview && (
        <div className="space-y-3">
          <label className="flex gap-2 text-sm">
            <input
              type="checkbox"
              checked={confirmSource}
              disabled={busy}
              onChange={(event) => setConfirmSource(event.target.checked)}
            />
            I reviewed these exact retained declarations and understand their unknown and unverified
            fields.
          </label>
          <button
            type="button"
            className={button}
            disabled={busy || !confirmSource || !journal.ready}
            onClick={() => void execute(false)}
          >
            Retain request and prepare review drafts
          </button>
        </div>
      )}
      {retained && (
        <div className="space-y-3">
          <p className="break-all text-sm">
            Retained request {retained.request.operationKey}. An interrupted response preserves this
            key and source.
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={button} disabled={busy} onClick={() => void check()}>
              Check saved output and acknowledgement
            </button>
            {!currentResult && !retained.acknowledgement && (
              <button
                type="button"
                className={button}
                disabled={busy}
                onClick={() => void execute(true)}
              >
                Submit the same retained request
              </button>
            )}
            {retained?.acknowledgement && !currentAck && (
              <button
                type="button"
                className={button}
                disabled={busy}
                onClick={() => void acknowledge(true)}
              >
                Submit the same retained acknowledgement
              </button>
            )}
          </div>
        </div>
      )}
      {currentResult && (
        <div className="space-y-4">
          <h3 className="font-medium">Saved source-bound review artifacts</h3>
          <p className="text-sm">
            These are original agent proposals. RoPA and reported-task records remain unchanged.
          </p>
          {currentResult.data.processing_reviews.map((item) => (
            <p key={item.source.record_id} className="text-sm">
              {item.declarations.system}: {item.unresolved_fields.length} unresolved declarations.
              Human-recorded facts remain unverified.
            </p>
          ))}
          {currentResult.data.playbook_reviews.map((item) => (
            <p key={item.source.record_id} className="text-sm">
              {item.reported_task.taskName}: {item.reported_total_minutes} human-reported minutes (
              {item.reported_task.durationMinutes} × {item.reported_task.repetitions}). Measurement
              not verified; time horizon not recorded; no automation authorised.
            </p>
          ))}
          {currentResult.data.policy_drafts.map((item, index) => (
            <details
              key={`${item.source_ropa_id}:${item.category}`}
              className="rounded border border-slate-200 p-3"
            >
              <summary className="cursor-pointer text-sm">
                {index + 1}. {item.title} — original unpublished proposal
              </summary>
              <pre className="mt-3 whitespace-pre-wrap break-words text-sm">{item.content}</pre>
            </details>
          ))}
          {!retained?.acknowledgement && (
            <fieldset disabled={busy} className="space-y-3">
              <legend className="font-medium">2. Record a separate human review</legend>
              <label className="block text-sm">
                Optional policy save
                <select
                  className="mt-1 block w-full rounded border border-slate-300 p-2"
                  value={policyIndex}
                  onChange={(event) => setPolicyIndex(event.target.value)}
                >
                  <option value="">
                    Acknowledge artifacts only; preserve original RoPA and task rows
                  </option>
                  {canSavePolicy &&
                    currentResult.data.policy_drafts.map((item, index) => (
                      <option key={`${item.source_ropa_id}:${item.category}`} value={String(index)}>
                        Save new draft: {item.title}
                      </option>
                    ))}
                </select>
              </label>
              <label className="block text-sm">
                Human review reason
                <textarea
                  className="mt-1 block w-full rounded border border-slate-300 p-2"
                  maxLength={2000}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </label>
              <label className="flex gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={confirmAck}
                  onChange={(event) => setConfirmAck(event.target.checked)}
                />
                I reviewed these exact artifacts. Any selected policy will be saved as an initial
                draft; legal approval and publication are separate.
              </label>
              <button
                type="button"
                className={button}
                disabled={!confirmAck || reason.length === 0}
                onClick={() => void acknowledge(false)}
              >
                Retain and record human acknowledgement
              </button>
            </fieldset>
          )}
          {currentAck && (
            <p role="status" className="text-sm">
              Human acknowledgement recorded, receipt {currentAck.data.receipt_id}.
              {currentAck.data.policy_draft_id && (
                <>
                  {' '}
                  Policy initial save: draft. Current saved policy status:{' '}
                  <strong>{currentAck.data.manifest.currentPolicyStatus}</strong>.{' '}
                  <Link className="text-indigo-700 underline" href="/policies">
                    Review saved policies
                  </Link>
                  .
                </>
              )}
            </p>
          )}
          <button
            type="button"
            className={button}
            disabled={busy || Boolean(retained?.acknowledgement && !currentAck)}
            onClick={() => void archive()}
          >
            Archive confirmed browser reference
          </button>
          <p className="text-xs text-slate-500">
            Archiving rechecks saved proofs and clears only this completed browser reference. Server
            artifacts, policies and audit receipts remain available.
          </p>
        </div>
      )}
    </section>
  );
}
