'use client';

import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { z } from 'zod';
import {
  createPublicAgentRunSchema,
  createPublicSourceBindingSchema,
  publicSourcePreviewSchema,
  recordedPublicSourceBindingSchema,
  publicSourceEngagementOptionsResponseSchema,
  publicSourceObservationHistoryResponseSchema,
  publicSourceRequestReconciliationResponseSchema,
  type PublicSourcePreview,
  type PublicAgentObservation,
  type PublicSourceObservationMetadata,
} from '@axiom/types';
import {
  sourceOperationSchema,
  sourceOperationPath,
  saveSourceOperation,
  clearSourceOperation,
  loadSourceOperation,
  sourceRequest,
  validateSourceObservation,
  type SourceOperation,
  SourceWorkflowError,
} from './source-request';
import { SourceProjectionView, SourceResultView } from './source-result';
import { SourceReview } from './source-review';

const checksSchema = z.object({
  data: z
    .array(
      z.object({
        id: z.uuid(),
        finalUrl: z.string().max(8192),
        checkedAt: z.string(),
        status: z.string(),
        contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .max(20),
});
type Checks = z.infer<typeof checksSchema>['data'];
type Choices = z.infer<typeof publicSourceEngagementOptionsResponseSchema>;
type History = z.infer<typeof publicSourceObservationHistoryResponseSchema>;
const button =
  'rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-[#1E2A4A] disabled:cursor-not-allowed disabled:opacity-50';
const field = 'mt-1 block w-full rounded-lg border border-slate-300 bg-white p-2 text-sm';

export function PublicSourceWorkflow(props: {
  tenantId: string;
  actorId: string;
  canInvoke: boolean;
  canReview?: boolean;
}) {
  return <Workflow key={`${props.tenantId}/${props.actorId}`} {...props} />;
}
function Workflow({
  tenantId,
  actorId,
  canInvoke,
  canReview = false,
}: {
  tenantId: string;
  actorId: string;
  canInvoke: boolean;
  canReview?: boolean;
}) {
  const helpId = useId();
  const [reviewLocked, setReviewLocked] = useState(true);
  const [choices, setChoices] = useState<Choices | null>(null);
  const [checks, setChecks] = useState<Checks>([]);
  const [engagementId, setEngagement] = useState('');
  const [checkId, setCheck] = useState('');
  const [selectedEngagement, setSelectedEngagement] = useState<Choices['data'][number] | null>(
    null,
  );
  const [preview, setPreview] = useState<PublicSourcePreview | null>(null);
  const [history, setHistory] = useState<History | null>(null);
  const [observation, setObservation] = useState<PublicAgentObservation | null>(null);
  const [selectedDrishti, setSelectedDrishti] = useState<PublicAgentObservation | null>(null);
  const [pending, setPending] = useState<SourceOperation | null>(null);
  const [canRetry, setCanRetry] = useState(false);
  const [storageReady, setStorageReady] = useState(false);
  const [storageError, setStorageError] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const reading = useRef(false);
  const active = useRef(true);

  async function task(work: () => Promise<void>) {
    if (reading.current) return;
    reading.current = true;
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (reason) {
      if (active.current)
        setError(
          reason instanceof SourceWorkflowError
            ? reason.message
            : 'This action could not be confirmed. Reconcile any retained request before continuing.',
        );
    } finally {
      reading.current = false;
      if (active.current) setBusy(false);
    }
  }
  async function readChoices(cursor?: string) {
    const parsed = publicSourceEngagementOptionsResponseSchema.parse(
      await sourceRequest(
        tenantId,
        `/public-source/options/engagements?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      ),
    );
    if (parsed.data.some((row) => row.tenant_id !== tenantId.toLowerCase()))
      throw new SourceWorkflowError('Engagement choices do not match this tenant.');
    if (active.current) setChoices(parsed);
  }
  async function readChecks() {
    const parsed = checksSchema.parse(await sourceRequest(tenantId, '/public-website-checks'));
    if (active.current) setChecks(parsed.data);
  }
  useEffect(() => {
    active.current = true;
    void Promise.resolve().then(async () => {
      if (!active.current) return;
      let journalError = false;
      try {
        const retained = loadSourceOperation(localStorage, tenantId, actorId);
        setPending(retained);
        setStorageReady(true);
        if (retained) {
          setEngagement(retained.engagementId);
          setCheck(retained.checkId);
          setNotice('A retained request needs reconciliation before another action.');
        }
      } catch {
        journalError = true;
        setStorageError(
          'Retained request storage is unavailable or invalid. Resolve it before starting an action.',
        );
      }
      try {
        await Promise.all([readChoices(), readChecks()]);
      } catch {
        if (active.current && !journalError)
          setError('Source choices could not be loaded. Refresh choices to retry.');
      } finally {
        if (active.current) setBusy(false);
      }
    });
    return () => {
      active.current = false;
    };
    // Tenant and actor changes remount this scoped workflow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function readPreview(engagement: string, check: string, expected?: SourceOperation) {
    const value = z
      .object({ data: publicSourcePreviewSchema })
      .strict()
      .parse(
        await sourceRequest(
          tenantId,
          `/public-website-checks/${check}/source-preview?engagementId=${engagement}`,
        ),
      ).data;
    const source = value.runtime_binding;
    const selectedCheck = checks.find((row) => row.id === check);
    if (selectedCheck && source.root_content_sha256 !== selectedCheck.contentSha256)
      throw new SourceWorkflowError('Saved check digest differs from this preview.');
    if (
      source.tenant_id !== tenantId.toLowerCase() ||
      source.engagement_id !== engagement ||
      source.check_id !== check ||
      (expected &&
        (source.root_content_sha256 !== expected.rootSha256 ||
          source.projection_sha256 !== expected.projectionSha256 ||
          (expected.bindingId && value.binding_id !== expected.bindingId)))
    )
      throw new SourceWorkflowError('Preview differs from the selected source.');
    if (active.current) setPreview(value);
    return value;
  }
  async function readHistory(value: PublicSourcePreview, cursor?: string) {
    if (!value.binding_id) return;
    const parsed = publicSourceObservationHistoryResponseSchema.parse(
      await sourceRequest(
        tenantId,
        `/public-source-bindings/${value.binding_id}/observations?engagementId=${value.runtime_binding.engagement_id}&limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      ),
    );
    if (
      parsed.data.some(
        (row) =>
          row.tenant_id !== tenantId.toLowerCase() ||
          row.engagement_id !== value.runtime_binding.engagement_id ||
          row.binding_id !== value.binding_id,
      )
    )
      throw new SourceWorkflowError('Observation history differs from this source.');
    if (active.current) setHistory(parsed);
  }
  async function readObservation(
    id: string,
    value: PublicSourcePreview,
    agent?: 'drishti' | 'vibhaag',
    metadata?: PublicSourceObservationMetadata,
  ) {
    if (!value.binding_id) throw new SourceWorkflowError('A recorded source binding is required.');
    const result = await validateSourceObservation(
      await sourceRequest(
        tenantId,
        `/public-source-observations/${id}?engagementId=${value.runtime_binding.engagement_id}`,
      ),
      {
        tenantId,
        engagementId: value.runtime_binding.engagement_id,
        bindingId: value.binding_id,
        checkId: value.runtime_binding.check_id,
        rootSha256: value.runtime_binding.root_content_sha256,
        projectionSha256: value.runtime_binding.projection_sha256,
        agent,
      },
    );
    if (
      metadata &&
      (metadata.run_id !== result.run_id ||
        metadata.dispatch_id !== result.dispatch_id ||
        metadata.binding_id !== result.binding_id ||
        metadata.output_sha256 !== result.output_sha256 ||
        metadata.completion_receipt !== result.completion_receipt ||
        metadata.agent !== result.agent)
    )
      throw new SourceWorkflowError('Retained result differs from its history receipt.');
    if (result.observation_id !== id)
      throw new SourceWorkflowError('Observation identity differs from the selected result.');
    if (active.current) {
      setObservation(result);
      if (result.agent === 'drishti') setSelectedDrishti(result);
    }
    return result;
  }
  function finish(operation: SourceOperation) {
    clearSourceOperation(localStorage, operation);
    if (active.current) {
      setPending(null);
      setCanRetry(false);
    }
  }
  async function dispatch(operation: SourceOperation) {
    const stored = loadSourceOperation(localStorage, tenantId, actorId);
    if (!stored || JSON.stringify(stored) !== JSON.stringify(operation))
      throw new SourceWorkflowError(
        'The retained request changed. Reconcile it before dispatching.',
      );
    const value = await sourceRequest(tenantId, sourceOperationPath(operation), { operation });
    if (operation.kind === 'bind') {
      const confirmed = recordedPublicSourceBindingSchema.parse(
        z.object({ data: z.unknown() }).parse(value).data,
      );
      if (
        confirmed.runtime_binding.tenant_id !== tenantId.toLowerCase() ||
        confirmed.runtime_binding.engagement_id !== operation.engagementId ||
        confirmed.runtime_binding.check_id !== operation.checkId ||
        confirmed.runtime_binding.root_content_sha256 !== operation.rootSha256 ||
        confirmed.runtime_binding.projection_sha256 !== operation.projectionSha256
      )
        throw new SourceWorkflowError('Binding result differs from this retained request.');
      const next = await readPreview(operation.engagementId, operation.checkId);
      if (next.binding_id !== confirmed.binding_id)
        throw new SourceWorkflowError('Binding could not be read back.');
      await readHistory(next);
      finish(operation);
      setNotice('Source binding recorded. Review it before running discovery.');
    } else {
      const result = await validateSourceObservation(value, {
        ...operation,
        bindingId: operation.bindingId!,
        agent: operation.kind,
      });
      // Retain the request until the persisted result is read back successfully.
      const next = await readPreview(operation.engagementId, operation.checkId, operation);
      await readObservation(result.observation_id, next, operation.kind);
      await readHistory(next);
      finish(operation);
      setNotice('Result retained. Human review remains pending.');
    }
  }
  function start(kind: SourceOperation['kind']) {
    void task(async () => {
      if (!canInvoke || reviewLocked || !storageReady || pending || !preview)
        throw new SourceWorkflowError('Select a source and reconcile any retained request first.');
      if (kind !== 'bind' && !preview.binding_id)
        throw new SourceWorkflowError('Record the source binding first.');
      if (kind === 'vibhaag' && selectedDrishti?.agent !== 'drishti')
        throw new SourceWorkflowError('Select and load a retained Drishti observation first.');
      const source = preview.runtime_binding;
      const body =
        kind === 'bind'
          ? createPublicSourceBindingSchema.parse({
              checkId: source.check_id,
              engagementId: source.engagement_id,
              expectedRootSha256: source.root_content_sha256,
              expectedProjectionSha256: source.projection_sha256,
            })
          : createPublicAgentRunSchema.parse({
              engagementId: source.engagement_id,
              expectedProjectionSha256: source.projection_sha256,
              ...(kind === 'vibhaag' ? { observationId: selectedDrishti!.observation_id } : {}),
            });
      const operation = sourceOperationSchema.parse({
        tenantId,
        actorId,
        operationKey: crypto.randomUUID(),
        kind,
        engagementId: source.engagement_id,
        checkId: source.check_id,
        bindingId: kind === 'bind' ? null : preview.binding_id,
        rootSha256: source.root_content_sha256,
        projectionSha256: source.projection_sha256,
        bodyUtf8: JSON.stringify(body),
      });
      saveSourceOperation(localStorage, operation);
      setPending(operation);
      setCanRetry(false);
      await dispatch(operation);
    });
  }
  function reconcile() {
    void task(async () => {
      if (!pending) return;
      setCanRetry(false);
      const next = await readPreview(pending.engagementId, pending.checkId, pending);
      if (pending.kind === 'bind') {
        if (next.binding_id) {
          await readHistory(next);
          finish(pending);
          setNotice('Matching source binding is retained.');
        } else {
          setCanRetry(true);
          setNotice(
            'No binding is recorded yet. An earlier attempt may still finish; any retry uses the exact retained key and body.',
          );
        }
        return;
      }
      const parsed = publicSourceRequestReconciliationResponseSchema.parse(
        await sourceRequest(
          tenantId,
          `/public-source-bindings/${pending.bindingId}/agents/${pending.kind}/request?engagementId=${pending.engagementId}`,
          { requestKey: pending.operationKey },
        ),
      ).data;
      if (
        parsed.tenant_id !== tenantId.toLowerCase() ||
        parsed.actor_id !== actorId.toLowerCase() ||
        parsed.engagement_id !== pending.engagementId ||
        parsed.binding_id !== pending.bindingId ||
        parsed.agent !== pending.kind
      )
        throw new SourceWorkflowError('Reconciliation differs from the retained request.');
      if (parsed.outcome.state === 'retained') {
        await readObservation(
          parsed.outcome.observation.observation_id,
          next,
          pending.kind,
          parsed.outcome.observation,
        );
        await readHistory(next);
        finish(pending);
        setNotice('Matching retained result recovered. Human review remains pending.');
      } else if (parsed.outcome.state === 'not_found') {
        setCanRetry(true);
        setNotice(
          'No request is recorded yet. An earlier attempt may still finish; any retry uses the exact retained key and body.',
        );
      } else if (parsed.outcome.state === 'confirmed_failed') {
        finish(pending);
        setNotice(
          `The runtime reported failure. Settlement receipt ${parsed.outcome.settlement_receipt}. Review the failure before starting another run.`,
        );
      } else
        setNotice(
          parsed.outcome.state === 'running'
            ? 'The recorded run is still running. Reconcile later; no new run will be started.'
            : 'Outcome or retained observation is unconfirmed. Keep this request and review recorded state; no new run will be started.',
        );
    });
  }
  const locked = busy || pending !== null;
  const lockedReason = busy
    ? 'Loading recorded state. Wait for the current action to finish.'
    : pending
      ? 'Reconcile the retained request before starting another action.'
      : undefined;
  const writeReason =
    lockedReason ??
    (!storageReady
      ? 'Restore browser request storage before starting an action; keep any retained request intact.'
      : reviewLocked
        ? 'Wait for human-review state to load, or reconcile a retained review shown below.'
        : undefined);
  const previewReason =
    lockedReason ??
    (!engagementId
      ? 'Choose an engagement first.'
      : !checkId
        ? 'Choose a saved public website check first.'
        : undefined);
  const bindReason =
    writeReason ??
    (!preview
      ? 'Preview the saved source first.'
      : preview.binding_id
        ? 'The source binding is already recorded. Continue with Drishti or retained observations.'
        : undefined);
  const drishtiReason =
    writeReason ??
    (!preview
      ? 'Preview the saved source first.'
      : !preview.binding_id
        ? 'Record the source binding first.'
        : undefined);
  const vibhaagReason =
    drishtiReason ??
    (selectedDrishti?.agent !== 'drishti'
      ? 'Select a retained Drishti observation below, or run Drishti to create one.'
      : undefined);

  const selectedChoice = selectedEngagement ?? choices?.data.find((row) => row.id === engagementId);
  const engagementChoices =
    selectedChoice && !choices?.data.some((row) => row.id === selectedChoice.id)
      ? [selectedChoice, ...(choices?.data ?? [])]
      : (choices?.data ?? []);
  return (
    <section
      aria-label="Public website agent workflow"
      className="w-full space-y-4 rounded-xl border border-slate-200 bg-white p-3 sm:p-4"
    >
      <div>
        <h2 className="text-lg font-semibold text-[#1E2A4A]">
          Public website discovery and classification
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          Select a saved public HTML check, retain its source binding, then review Drishti
          observations and tentative Vibhaag indicators.
        </p>
        <Link
          href="/connectors"
          className="mt-2 inline-block text-sm font-medium text-teal-700 underline"
        >
          Create or review a public website check
        </Link>
      </div>
      {!canInvoke && (
        <p className="text-sm">
          {canReview
            ? 'Human review is available. Ask an authorized operator to start a run.'
            : 'Read-only access: inspect retained source facts and results. Ask an authorized operator to start a run.'}
        </p>
      )}
      {busy && (
        <p role="status" className="text-sm">
          Loading recorded state…
        </p>
      )}
      {(storageError || error) && (
        <p role="alert" className="text-sm text-[#D9534F]">
          {storageError || error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      <div className="grid gap-3 lg:grid-cols-2">
        <label className="text-sm">
          Engagement
          <select
            className={field}
            value={engagementId}
            disabled={locked}
            aria-describedby={`${helpId}-choices`}
            onChange={(event) => {
              setEngagement(event.target.value);
              setSelectedEngagement(
                engagementChoices.find((row) => row.id === event.target.value) ?? null,
              );
              setPreview(null);
              setHistory(null);
              setObservation(null);
              setSelectedDrishti(null);
              setNotice('');
            }}
          >
            <option value="">Choose an engagement</option>
            {pending && !selectedChoice && (
              <option value={pending.engagementId}>Retained request engagement</option>
            )}
            {engagementChoices.map((row) => (
              <option key={row.id} value={row.id}>
                {row.title} · {row.library_version} · {row.status}
                {row.estate ? ` · ${row.estate.name}` : ' · historical estate unavailable'}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          Saved public website check
          <select
            className={field}
            aria-label="Saved public website check"
            aria-describedby={`source-check-help ${helpId}-choices`}
            value={checkId}
            disabled={locked}
            onChange={(event) => {
              setCheck(event.target.value);
              setPreview(null);
              setHistory(null);
              setObservation(null);
              setSelectedDrishti(null);
              setNotice('');
            }}
          >
            <option value="">Choose a saved check</option>
            {pending && !checks.some((row) => row.id === pending.checkId) && (
              <option value={pending.checkId}>Retained request check</option>
            )}
            {checks.map((row) => (
              <option key={row.id} value={row.id} disabled={row.status !== 'checked'}>
                {row.finalUrl} · {row.checkedAt}
              </option>
            ))}
          </select>
          <span id="source-check-help" className="mt-1 block text-xs text-slate-600">
            Latest 20 saved checks. Source HTML is never fetched from this screen.
          </span>
        </label>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={button}
          disabled={locked}
          aria-describedby={`${helpId}-choices`}
          onClick={() =>
            void task(() => Promise.all([readChoices(), readChecks()]).then(() => undefined))
          }
        >
          Refresh choices
        </button>
        <button
          type="button"
          className={button}
          disabled={locked || !choices?.meta.hasMore}
          aria-describedby={`${helpId}-next-engagements`}
          onClick={() => void task(() => readChoices(choices?.meta.nextCursor ?? undefined))}
        >
          Next engagements
        </button>
        <button
          type="button"
          className={button}
          disabled={!!previewReason}
          aria-describedby={`${helpId}-preview`}
          onClick={() =>
            void task(async () => {
              const value = await readPreview(engagementId, checkId);
              await readHistory(value);
            })
          }
        >
          Preview saved source
        </button>
      </div>
      <div className="space-y-1 text-sm text-slate-600">
        <p id={`${helpId}-choices`}>
          Choices: {lockedReason ?? 'Ready to select or refresh saved choices.'}
        </p>
        <p id={`${helpId}-next-engagements`}>
          Next engagements:{' '}
          {lockedReason ??
            (!choices?.meta.hasMore
              ? 'No additional engagements are available in the current list.'
              : 'Ready to load more engagements.')}
        </p>
        <p id={`${helpId}-preview`}>
          Preview saved source:{' '}
          {previewReason ?? 'Ready to inspect the saved source without starting an agent.'}
        </p>
      </div>
      {preview && <SourceProjectionView preview={preview} />}
      {pending && (
        <section
          aria-label="Retained request"
          className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm"
        >
          <p>
            {pending.kind} request retained. Reconcile before retrying or starting another action.
          </p>
          <p className="break-all">
            Operation key: <code>{pending.operationKey}</code>
          </p>
          <button
            type="button"
            className={button}
            disabled={busy}
            aria-describedby={`${helpId}-reconcile`}
            onClick={reconcile}
          >
            Reconcile retained request
          </button>
          <p id={`${helpId}-reconcile`}>
            {busy
              ? 'Loading recorded state. Wait before reconciling.'
              : 'Reconcile this retained request to check its recorded outcome without starting another run.'}
          </p>
          {canRetry && canInvoke && !reviewLocked && (
            <button
              type="button"
              className={`${button} ml-2`}
              disabled={busy}
              aria-describedby={`${helpId}-retry`}
              onClick={() =>
                void task(async () => {
                  setCanRetry(false);
                  await dispatch(pending);
                })
              }
            >
              Retry exact retained request
            </button>
          )}
          <p id={`${helpId}-retry`}>
            {busy
              ? 'Loading recorded state. Wait before retrying.'
              : canRetry && canInvoke && !reviewLocked
                ? 'Ready to retry only the exact retained key and body.'
                : 'Exact retry requires explicit not-found reconciliation, invocation access and a resolved review journal.'}
          </p>
        </section>
      )}
      {canInvoke && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={button}
            disabled={!!bindReason}
            aria-describedby={`${helpId}-bind`}
            onClick={() => start('bind')}
          >
            Record source binding
          </button>
          <button
            type="button"
            className={button}
            disabled={!!drishtiReason}
            aria-describedby={`${helpId}-drishti`}
            onClick={() => start('drishti')}
          >
            Run Drishti on saved source
          </button>
          <button
            type="button"
            className={button}
            disabled={!!vibhaagReason}
            aria-describedby={`${helpId}-vibhaag`}
            onClick={() => start('vibhaag')}
          >
            Run Vibhaag on selected observation
          </button>
        </div>
      )}
      {canInvoke && (
        <div className="space-y-1 text-sm text-slate-600">
          <p id={`${helpId}-bind`}>
            Record source binding: {bindReason ?? 'Ready to record the selected source binding.'}
          </p>
          <p id={`${helpId}-drishti`}>
            Run Drishti: {drishtiReason ?? 'Ready to run Drishti on the bound saved source.'}
          </p>
          <p id={`${helpId}-vibhaag`}>
            Run Vibhaag:{' '}
            {vibhaagReason ?? 'Ready to run Vibhaag on the selected retained Drishti observation.'}
          </p>
        </div>
      )}
      {preview?.binding_id && (
        <section aria-label="Retained observations" className="space-y-2 text-sm">
          <h3 className="font-semibold">Retained observations</h3>
          {history?.data.length === 0 && <p>No retained observations for this source binding.</p>}
          <ul className="space-y-2">
            {history?.data.map((row) => (
              <li
                key={row.observation_id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 p-2"
              >
                <span>
                  {row.agent} · {row.created_at} · receipt {row.completion_receipt}
                </span>
                <button
                  type="button"
                  className={button}
                  disabled={busy}
                  aria-describedby={`${helpId}-observations`}
                  onClick={() =>
                    void task(() =>
                      readObservation(row.observation_id, preview, row.agent, row).then(
                        () => undefined,
                      ),
                    )
                  }
                >
                  {row.agent === 'drishti' ? 'Select Drishti observation' : 'Review Vibhaag result'}
                </button>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={button}
              disabled={busy}
              aria-describedby={`${helpId}-observations`}
              onClick={() => void task(() => readHistory(preview))}
            >
              Refresh observations
            </button>
            <button
              type="button"
              className={button}
              disabled={busy || !history?.meta.hasMore}
              aria-describedby={`${helpId}-next-observations`}
              onClick={() =>
                void task(() => readHistory(preview, history?.meta.nextCursor ?? undefined))
              }
            >
              Next observations
            </button>
          </div>
          <p id={`${helpId}-observations`}>
            {busy
              ? 'Loading recorded state. Wait before reading observations.'
              : 'Ready to refresh or select retained observations.'}
          </p>
          <p id={`${helpId}-next-observations`}>
            {busy
              ? 'Loading recorded state. Wait before reading observations.'
              : !history?.meta.hasMore
                ? 'No additional retained observations are available in the current list.'
                : 'Ready to load more retained observations.'}
          </p>
          {selectedDrishti && (
            <p className="break-all text-xs">
              Selected Drishti observation: <code>{selectedDrishti.observation_id}</code>
            </p>
          )}
        </section>
      )}
      {observation && <SourceResultView observation={observation} />}
      <SourceReview
        tenantId={tenantId}
        actorId={actorId}
        canReview={canReview}
        observation={observation}
        onWriteLock={setReviewLocked}
      />
    </section>
  );
}
