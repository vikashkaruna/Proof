'use client';
import { formatDateTime } from '@/lib/display-time';

import {
  cloneElement,
  isValidElement,
  useId,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import Link from 'next/link';
import { z } from 'zod';
import {
  workflowRequestSchema,
  workflowPageResponseSchema,
  workflowRecordedResponseSchema,
  policyDocumentPayloadSchema,
  type WorkflowKind,
  type WorkflowRecord,
} from '@axiom/types';
import {
  readJournal,
  JOURNAL_CHANGED,
  JOURNAL_SAVED,
  journalSchema,
  notifySavedJournal,
  retainJournal,
  clearJournal,
  workflowFetch,
  validateRecorded,
  WorkflowError,
  type Journal,
} from './request';

import { parseListDeclaration } from './list-input';
import { ListInputField } from './list-input-field';

const input = 'mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm';
const button =
  'rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-indigo-700 disabled:cursor-not-allowed disabled:opacity-50';
function Field({
  name,
  label,
  children,
  type = 'text',
  optional = false,
  ...rest
}: {
  name: string;
  label: string;
  children?: ReactNode;
  type?: string;
  optional?: boolean;
  min?: number;
  max?: number;
  maxLength?: number;
  defaultValue?: string | number;
}) {
  const labelId = useId();
  return (
    <label className="block text-sm font-medium text-slate-700">
      <span id={labelId}>
        {label}
        {optional ? ' (unknown if blank)' : ''}
      </span>
      {isValidElement<{ 'aria-labelledby'?: string }>(children)
        ? cloneElement(children, { 'aria-labelledby': labelId })
        : (children ?? (
            <input
              className={input}
              name={name}
              type={type}
              required={!optional}
              aria-labelledby={labelId}
              {...rest}
            />
          ))}
    </label>
  );
}
function listValue(value: string[] | null) {
  return value === null
    ? null
    : value.length
      ? value.join(', ')
      : 'Human recorded none — review required';
}
const title: Record<WorkflowKind, string> = {
  ropa: 'Processing activities',
  delivery_task: 'Delivery task capture',
  policy_draft: 'Policy and notice drafts',
  policy_review: 'Policy review history',
};
export function WorkflowPanel(props: {
  tenantId: string;
  actorId: string;
  kind: WorkflowKind;
  canWrite: boolean;
  canReview?: boolean;
}) {
  return <Panel key={`${props.tenantId}/${props.actorId}/${props.kind}`} {...props} />;
}
function Panel({
  tenantId,
  actorId,
  kind,
  canWrite,
  canReview = false,
}: {
  tenantId: string;
  actorId: string;
  kind: WorkflowKind;
  canWrite: boolean;
  canReview?: boolean;
}) {
  const [rows, setRows] = useState<WorkflowRecord[]>([]);
  const [reviews, setReviews] = useState<WorkflowRecord[]>([]);
  const [ropas, setRopas] = useState<WorkflowRecord[]>([]);
  const [sourceOffset, setSourceOffset] = useState(0);
  const [sourceMore, setSourceMore] = useState(false);
  const [selectedRopa, setSelectedRopa] = useState<WorkflowRecord | null>(null);
  const [offset, setOffset] = useState(0);
  const [more, setMore] = useState(false);
  const [pending, setPending] = useState<Journal | null>(null);
  const [storageReady, setStorageReady] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [notFound, setNotFound] = useState(false);
  const [listErrors, setListErrors] = useState<Record<string, string>>({});
  const [listRevision, setListRevision] = useState(0);
  const [reviewErrors, setReviewErrors] = useState<Record<string, string>>({});
  const [generatedFrom, setGeneratedFrom] = useState<{ id: string; category: string } | null>(null);
  const [generationChanged, setGenerationChanged] = useState(false);
  const alive = useRef(true);
  const lock = useRef(false);
  const draftForm = useRef<HTMLFormElement>(null);
  const reviewForms = useRef(new Map<string, HTMLFormElement>());
  async function task(work: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (e) {
      if (alive.current)
        setError(
          e instanceof WorkflowError
            ? e.message
            : 'The recorded response could not be validated. Keep the request and check its outcome.',
        );
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function load(page = 0) {
    const result = workflowPageResponseSchema.parse(
      await workflowFetch(
        tenantId,
        `/operator-workflows/records?kind=${kind}&limit=20&offset=${page}`,
      ),
    );
    if (
      result.meta.offset !== page ||
      result.meta.limit !== 20 ||
      result.data.some((r) => r.kind !== kind)
    )
      throw new WorkflowError('Recorded page does not match this view.');
    const next = result.data.map((r) => validateRecorded(r, tenantId));
    let history: WorkflowRecord[] = [];
    if (kind === 'policy_draft') {
      const failures: Record<string, string> = {};
      const perDraft = await Promise.all(
        next.map(async (draft) => {
          try {
            const review = workflowPageResponseSchema.parse(
              await workflowFetch(
                tenantId,
                `/operator-workflows/policy-drafts/${draft.id}/reviews`,
              ),
            );
            if (
              review.meta.limit !== 1 ||
              review.meta.offset !== 0 ||
              review.meta.hasMore ||
              review.data.length > 1 ||
              review.data.some(
                (r) =>
                  r.kind !== 'policy_review' ||
                  r.payload.draftId !== draft.id ||
                  r.payload.expectedHash !== draft.content_sha256,
              )
            )
              throw new WorkflowError('Review history could not be validated.');
            return review.data.map((r) => validateRecorded(r, tenantId));
          } catch {
            failures[draft.id] =
              'Review history is unavailable or incomplete. Refresh before recording a decision.';
            return [];
          }
        }),
      );
      history = perDraft.flat();
      if (alive.current) setReviewErrors(failures);
      await loadSources(sourceOffset);
    }
    if (alive.current) {
      setRows(next);
      setOffset(page);
      setMore(result.meta.hasMore);
      setReviews(history);
    }
  }
  async function loadSources(page: number) {
    const sources = workflowPageResponseSchema.parse(
      await workflowFetch(
        tenantId,
        `/operator-workflows/records?kind=ropa&limit=50&offset=${page}`,
      ),
    );
    if (
      sources.meta.limit !== 50 ||
      sources.meta.offset !== page ||
      sources.data.some((r) => r.kind !== 'ropa')
    )
      throw new WorkflowError('Processing sources could not be validated.');
    const validated = sources.data.map((r) => validateRecorded(r, tenantId));
    if (alive.current) {
      setRopas(validated);
      setSourceOffset(page);
      setSourceMore(sources.meta.hasMore);
    }
  }
  useEffect(() => {
    alive.current = true;
    const syncJournal = () => {
      try {
        const journal = readJournal(sessionStorage, tenantId, actorId);
        setPending(journal);
        setNotFound(false);
        setStorageReady(true);
      } catch {
        setStorageReady(false);
        setError('The retained request could not be read. Reload before continuing.');
      }
    };
    window.addEventListener(JOURNAL_CHANGED, syncJournal);
    window.addEventListener('storage', syncJournal);
    const savedJournal = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const parsed = journalSchema.safeParse(event.detail);
      if (parsed.success && parsed.data.tenantId === tenantId && parsed.data.actorId === actorId)
        resetSavedForm(parsed.data);
    };
    window.addEventListener(JOURNAL_SAVED, savedJournal);
    void task(async () => {
      try {
        const journal = readJournal(sessionStorage, tenantId, actorId);
        if (alive.current) {
          setPending(journal);
          setStorageReady(true);
        }
      } catch {
        setStorageReady(false);
        setError(
          'The retained request could not be read. Records remain available; restore the saved request before another save.',
        );
      }
      await load();
    });
    return () => {
      alive.current = false;
      window.removeEventListener(JOURNAL_CHANGED, syncJournal);
      window.removeEventListener('storage', syncJournal);
      window.removeEventListener(JOURNAL_SAVED, savedJournal);
    };
    // Scope changes remount the keyed component and never reuse another tenant's state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  function resetSavedForm(journal: Journal, form?: HTMLFormElement) {
    if (!alive.current) return;
    const savedForm =
      form ??
      (journal.request.kind === kind
        ? draftForm.current
        : journal.request.kind === 'policy_review' && kind === 'policy_draft'
          ? reviewForms.current.get(journal.request.payload.draftId)
          : null);
    savedForm?.reset();
    if (journal.request.kind === kind) {
      setGeneratedFrom(null);
      setGenerationChanged(false);
      setSelectedRopa(null);
    }
  }
  async function refreshAfterOutcome(outcome: 'save' | 'cancellation' = 'save') {
    try {
      await load();
    } catch {
      if (alive.current)
        setError(
          outcome === 'save'
            ? 'The saved record was confirmed, but records could not be refreshed. Use Refresh records to read it; do not submit it again.'
            : 'Cancellation was confirmed, but records could not be refreshed. Use Refresh records to read current state.',
        );
    }
  }
  async function confirmed(journal: Journal, form?: HTMLFormElement) {
    const result = workflowRecordedResponseSchema.parse(
      await workflowFetch(
        tenantId,
        '/operator-workflows/records',
        journal.request,
        journal.actorId,
      ),
    );
    validateRecorded(result.data, tenantId, journal.request, actorId);
    clearJournal(sessionStorage, journal);
    resetSavedForm(journal, form);
    notifySavedJournal(journal);
    if (alive.current) {
      setPending(null);
      setNotFound(false);
      setNotice('Saved with a human audit receipt. Reload reads the retained record.');
    }
    await refreshAfterOutcome();
  }
  function submit(event: FormEvent<HTMLFormElement>, requestKind: WorkflowKind = kind) {
    event.preventDefault();
    if (pending || !storageReady || (kind === 'policy_draft' && generationChanged)) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    const text = (key: string) => String(fields.get(key) ?? '').trim();
    const nullable = (key: string) => text(key) || null;
    const invalidLists: Record<string, string> = {};
    const list = (key: string) => {
      try {
        return parseListDeclaration(text(`${key}Declaration`), text(key));
      } catch (cause) {
        invalidLists[key] = cause instanceof Error ? cause.message : 'Check this declaration.';
        return null;
      }
    };
    const source =
      text('sourceObservation') || text('sourceDigest')
        ? { observationId: text('sourceObservation'), outputSha256: text('sourceDigest') }
        : undefined;
    const provenance = {
      engagementId: nullable('engagementId'),
      sourceNote: text('sourceNote'),
      ...(source ? { source } : {}),
    };
    const payload =
      requestKind === 'ropa'
        ? {
            ...provenance,
            system: text('system'),
            purpose: nullable('purpose'),
            legalBasis: nullable('legalBasis'),
            retentionMonths: text('retentionMonths') ? Number(text('retentionMonths')) : null,
            dataCategories: list('dataCategories'),
            dataPrincipals: list('dataPrincipals'),
            processors: list('processors'),
            recipients: list('recipients'),
            destinationCountries: list('destinationCountries'),
            transferSafeguards: nullable('transferSafeguards'),
            dpiaRequired: text('dpiaRequired') === '' ? null : text('dpiaRequired') === 'yes',
            region: nullable('region'),
            crossBorder: text('crossBorder') === '' ? null : text('crossBorder') === 'yes',
            securityMeasures: nullable('securityMeasures'),
          }
        : requestKind === 'delivery_task'
          ? {
              engagementId: nullable('engagementId'),
              taskName: text('taskName'),
              source: text('source'),
              durationMinutes: Number(text('durationMinutes')),
              repetitions: Number(text('repetitions')),
              notes: text('notes'),
            }
          : requestKind === 'policy_review'
            ? {
                draftId: text('draftId'),
                expectedHash: text('expectedHash'),
                decision: text('decision'),
                reason: text('reason'),
              }
            : {
                ...provenance,
                title: text('title'),
                category: text('category'),
                content: String(fields.get('content') ?? ''),
                sourceRopaId: nullable('sourceRopaId'),
              };
    setListErrors(invalidLists);
    if (Object.keys(invalidLists).length) {
      setError('');
      setNotice('');
      const field = form.elements.namedItem(Object.keys(invalidLists)[0]!);
      if (field instanceof HTMLInputElement) field.focus();
      return;
    }
    void task(async () => {
      const request = workflowRequestSchema.parse({
        operationKey: crypto.randomUUID(),
        kind: requestKind,
        payload,
      });
      const journal = { tenantId, actorId, request };
      retainJournal(sessionStorage, journal);
      setPending(journal);
      setNotFound(false);
      setNotice('');
      await confirmed(journal, form);
    });
  }
  async function recover() {
    if (!pending) return;
    const journal = pending;
    await task(async () => {
      const response = z
        .object({ data: workflowRecordedResponseSchema.shape.data.nullable() })
        .strict()
        .parse(
          await workflowFetch(
            tenantId,
            `/operator-workflows/requests/${journal.request.operationKey}`,
          ),
        );
      if (response.data === null) {
        setNotFound(true);
        setNotice(
          'This account has no retained result for that key. Retry sends the same recorded request.',
        );
        return;
      }
      validateRecorded(response.data, tenantId, journal.request, actorId);
      clearJournal(sessionStorage, journal);
      resetSavedForm(journal);
      notifySavedJournal(journal);
      setPending(null);
      setNotFound(false);
      setNotice('The interrupted request was already saved. No duplicate was submitted.');
      await refreshAfterOutcome();
    });
  }
  async function cancel() {
    if (!pending) return;
    const journal = pending;
    await task(async () => {
      const result = z
        .discriminatedUnion('cancelled', [
          z.object({ cancelled: z.literal(true), data: z.null() }).strict(),
          z
            .object({
              cancelled: z.literal(false),
              data: workflowRecordedResponseSchema.shape.data,
            })
            .strict(),
        ])
        .parse(
          await workflowFetch(
            tenantId,
            `/operator-workflows/requests/${journal.request.operationKey}/cancel`,
            journal.request,
            journal.actorId,
          ),
        );
      if (!result.cancelled) validateRecorded(result.data, tenantId, journal.request, actorId);
      clearJournal(sessionStorage, journal);
      if (!result.cancelled) {
        resetSavedForm(journal);
        notifySavedJournal(journal);
      }
      setPending(null);
      setNotFound(false);
      setNotice(
        result.cancelled
          ? 'Cancellation recorded. This request cannot be saved by a late response; you can correct the form and submit a new request.'
          : 'The request was already saved. Its recorded result was recovered; nothing was cancelled.',
      );
      await refreshAfterOutcome(result.cancelled ? 'cancellation' : 'save');
    });
  }
  const writable = kind === 'policy_review' ? canReview : canWrite;
  async function generate() {
    const form = draftForm.current;
    if (!form) return;
    const fields = new FormData(form);
    const id = String(fields.get('sourceRopaId') ?? '');
    const category = String(fields.get('category') ?? '');
    if (
      !z.uuid().safeParse(id).success ||
      !['privacy_notice', 'consent_notice', 'retention', 'dpa_template'].includes(category)
    ) {
      setError(
        'Select a saved processing activity and a supported notice, retention or agreement template.',
      );
      return;
    }
    await task(async () => {
      const response = z
        .object({ data: policyDocumentPayloadSchema })
        .strict()
        .parse(
          await workflowFetch(
            tenantId,
            `/operator-workflows/policy-preview?ropaId=${encodeURIComponent(id)}&category=${encodeURIComponent(category)}`,
          ),
        );
      if (response.data.sourceRopaId !== id || response.data.category !== category)
        throw new WorkflowError('Generated draft does not match the selected source.');
      const currentSource = form.elements.namedItem('sourceRopaId');
      const currentCategory = form.elements.namedItem('category');
      if (
        !(currentSource instanceof HTMLSelectElement) ||
        !(currentCategory instanceof HTMLSelectElement) ||
        currentSource.value !== id ||
        currentCategory.value !== category
      )
        throw new WorkflowError('The selected source changed. Generate again before saving.');
      setGeneratedFrom({ id, category });
      setGenerationChanged(false);
      for (const [name, value] of Object.entries({
        title: response.data.title,
        content: response.data.content,
        sourceNote: response.data.sourceNote,
        engagementId: response.data.engagementId ?? '',
        sourceObservation: response.data.source?.observationId ?? '',
        sourceDigest: response.data.source?.outputSha256 ?? '',
      })) {
        const field = form.elements.namedItem(name);
        if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)
          field.value = value;
      }
      setNotice(
        'Draft generated from the retained processing activity. Review and edit the text before saving; unknown facts remain unknown.',
      );
    });
  }
  return (
    <section
      aria-label={title[kind]}
      className="min-w-0 rounded-lg border border-slate-200 bg-white p-4 sm:p-5"
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-indigo-700">{title[kind]}</h2>
        <button
          className={button}
          disabled={busy}
          onClick={() =>
            void task(async () => {
              setPending(readJournal(sessionStorage, tenantId, actorId));
              await load(offset);
            })
          }
        >
          Refresh records
        </button>
      </div>
      {kind === 'ropa' && (
        <p className="mb-4 text-sm text-slate-600">
          Capture authorised processing facts; blank fields remain unknown. Public website structure
          does not establish purpose, legal basis, retention or residency. Every saved activity
          still requires review.
        </p>
      )}
      {kind === 'delivery_task' && (
        <p className="mb-4 text-sm text-slate-600">
          Record actual task time and repetition counts. Ranking uses the recorded total time; it
          does not imply annual savings or automatically approve automation.
        </p>
      )}
      {kind === 'policy_draft' && (
        <p className="mb-4 text-sm text-slate-600">
          Save exact draft text and its sources. Founder review records a reason and content digest.
          Approval here does not publish a document or establish legal compliance.
        </p>
      )}
      {error && (
        <p role="alert" className="mb-3 rounded-md bg-ember-50 p-3 text-sm text-ember-700">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="mb-3 rounded-md bg-mist-50 p-3 text-sm text-slate-700">
          {notice}
        </p>
      )}
      {pending && (
        <div className="mb-4 rounded-md border border-ember-300 bg-ember-50 p-3">
          <p className="text-sm">
            A {title[pending.request.kind].toLowerCase()} request is retained for this account.
            Check its outcome before another save. Keep this browser session open until resolved.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button className={button} disabled={busy} onClick={() => void recover()}>
              Check retained request
            </button>
            <button className={button} disabled={busy} onClick={() => void cancel()}>
              Cancel retained request or recover saved result
            </button>
            {notFound && (
              <button
                className={button}
                disabled={
                  busy || !(pending.request.kind === 'policy_review' ? canReview : canWrite)
                }
                onClick={() => void task(() => confirmed(pending))}
              >
                Retry identical request
              </button>
            )}
          </div>
        </div>
      )}
      {writable && (
        <details className="mb-5 rounded-md border border-slate-200 p-3">
          <summary className="cursor-pointer text-sm font-semibold text-indigo-700">
            {kind === 'ropa'
              ? 'Record processing activity'
              : kind === 'delivery_task'
                ? 'Record delivery task'
                : 'Create policy or notice draft'}
          </summary>
          <form
            onReset={() => {
              setListErrors({});
              setListRevision((version) => version + 1);
            }}
            ref={draftForm}
            onSubmit={submit}
            className="mt-4"
            onChange={(event) => {
              const element = event.target;
              if (!generatedFrom) return;
              if (
                element instanceof HTMLSelectElement &&
                (element.name === 'sourceRopaId' || element.name === 'category')
              ) {
                const fields = new FormData(event.currentTarget);
                setGenerationChanged(
                  fields.get('sourceRopaId') !== generatedFrom.id ||
                    fields.get('category') !== generatedFrom.category,
                );
              }
            }}
          >
            <fieldset
              disabled={busy || !!pending || !storageReady}
              className="grid min-w-0 gap-4 md:grid-cols-2"
            >
              {kind === 'ropa' ? (
                <>
                  <Field name="system" label="System or processing activity" maxLength={200} />
                  <Field
                    name="purpose"
                    label="Confirmed processing purpose"
                    optional
                    maxLength={2000}
                  />
                  <Field name="legalBasis" label="Confirmed legal basis" optional maxLength={200} />
                  <Field
                    name="retentionMonths"
                    label="Retention in months"
                    optional
                    type="number"
                    min={1}
                    max={1200}
                  />
                  <ListInputField
                    key={`dataCategories:${listRevision}`}
                    name="dataCategories"
                    label="Data categories"
                    error={listErrors.dataCategories}
                    onChange={() =>
                      setListErrors((previous) => ({ ...previous, dataCategories: '' }))
                    }
                  />
                  <ListInputField
                    key={`processors:${listRevision}`}
                    name="processors"
                    label="Processors"
                    error={listErrors.processors}
                    onChange={() => setListErrors((previous) => ({ ...previous, processors: '' }))}
                  />
                  <ListInputField
                    key={`dataPrincipals:${listRevision}`}
                    name="dataPrincipals"
                    label="Data principal groups"
                    error={listErrors.dataPrincipals}
                    onChange={() =>
                      setListErrors((previous) => ({ ...previous, dataPrincipals: '' }))
                    }
                  />
                  <ListInputField
                    key={`recipients:${listRevision}`}
                    name="recipients"
                    label="Recipients"
                    error={listErrors.recipients}
                    onChange={() => setListErrors((previous) => ({ ...previous, recipients: '' }))}
                  />
                  <ListInputField
                    key={`destinationCountries:${listRevision}`}
                    name="destinationCountries"
                    label="Transfer destinations"
                    error={listErrors.destinationCountries}
                    onChange={() =>
                      setListErrors((previous) => ({ ...previous, destinationCountries: '' }))
                    }
                  />
                  <Field
                    name="transferSafeguards"
                    label="Confirmed transfer safeguards"
                    optional
                    maxLength={2000}
                  />
                  <Field name="dpiaRequired" label="Impact assessment required">
                    <select className={input} name="dpiaRequired" defaultValue="">
                      <option value="">Unknown</option>
                      <option value="yes">Confirmed yes</option>
                      <option value="no">Confirmed no</option>
                    </select>
                  </Field>
                  <Field
                    name="region"
                    label="Confirmed processing location"
                    optional
                    maxLength={100}
                  />
                  <Field name="crossBorder" label="Cross-border transfers">
                    <select className={input} name="crossBorder" defaultValue="">
                      <option value="">Unknown</option>
                      <option value="yes">Confirmed yes</option>
                      <option value="no">Confirmed no</option>
                    </select>
                  </Field>
                  <Field
                    name="securityMeasures"
                    label="Confirmed security measures"
                    optional
                    maxLength={2000}
                  />
                </>
              ) : kind === 'delivery_task' ? (
                <>
                  <Field name="taskName" label="Task name" maxLength={200} />
                  <Field name="source" label="Source of time record" maxLength={200} />
                  <Field
                    name="durationMinutes"
                    label="Minutes per task"
                    type="number"
                    min={0}
                    max={1000000}
                  />
                  <Field
                    name="repetitions"
                    label="Recorded repetitions"
                    type="number"
                    min={1}
                    max={1000000}
                    defaultValue={1}
                  />
                  <Field name="notes" label="Notes" optional maxLength={2000} />
                </>
              ) : (
                <>
                  <Field name="title" label="Document title" maxLength={300} />
                  <Field name="category" label="Document type">
                    <select className={input} name="category" defaultValue="privacy_notice">
                      <option value="privacy_notice">Privacy notice</option>
                      <option value="consent_notice">Consent notice</option>
                      <option value="retention">Retention policy</option>
                      <option value="dpa_template">Data processing agreement template</option>
                      <option value="data_protection">Data protection policy</option>
                      <option value="breach_response">Breach response policy</option>
                      <option value="access_control">Access control policy</option>
                      <option value="vendor_management">Vendor management policy</option>
                      <option value="acceptable_use">Acceptable use policy</option>
                    </select>
                  </Field>
                  <label className="block text-sm font-medium text-slate-700 md:col-span-2">
                    Draft text
                    <textarea
                      className={`${input} min-h-48`}
                      name="content"
                      required
                      maxLength={100000}
                    />
                  </label>
                  <Field name="sourceRopaId" label="Saved processing activity">
                    <select
                      className={input}
                      name="sourceRopaId"
                      value={selectedRopa?.id ?? ''}
                      onChange={(event) =>
                        setSelectedRopa(
                          ropas.find((r) => r.id === event.currentTarget.value) ??
                            (selectedRopa?.id === event.currentTarget.value ? selectedRopa : null),
                        )
                      }
                    >
                      <option value="">No linked activity (manual draft)</option>
                      {selectedRopa && !ropas.some((r) => r.id === selectedRopa.id) && (
                        <option value={selectedRopa.id}>
                          {selectedRopa.kind === 'ropa'
                            ? selectedRopa.payload.system
                            : selectedRopa.id}{' '}
                          · {selectedRopa.id.slice(0, 8)} (selected activity)
                        </option>
                      )}
                      {ropas.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.kind === 'ropa' ? r.payload.system : r.id} · {r.id.slice(0, 8)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <div className="md:col-span-2">
                    <div className="mb-3 flex flex-wrap items-center gap-3">
                      <button
                        type="button"
                        className={button}
                        disabled={busy || sourceOffset === 0}
                        onClick={() => void task(() => loadSources(Math.max(0, sourceOffset - 50)))}
                      >
                        Previous activities
                      </button>
                      <span className="text-xs text-slate-500">
                        Showing up to 50 activities from {sourceOffset + 1}
                      </span>
                      <button
                        type="button"
                        className={button}
                        disabled={busy || !sourceMore || sourceOffset >= 100_000}
                        onClick={() => void task(() => loadSources(sourceOffset + 50))}
                      >
                        Next activities
                      </button>
                    </div>
                    <button
                      type="button"
                      className={button}
                      disabled={busy || !!pending}
                      onClick={() => void generate()}
                    >
                      Generate draft from selected activity
                    </button>
                    <p className="mt-2 text-xs text-slate-500">
                      Browse saved activities using the activity page controls. Generation replaces
                      this editor with a reviewable privacy notice, consent notice, retention policy
                      or agreement template.{' '}
                      <Link href="/datamap" className="text-teal-700 underline">
                        Record processing facts
                      </Link>{' '}
                      first if no activity is available.
                    </p>
                  </div>
                </>
              )}
              <Field name="engagementId" label="Engagement ID" optional maxLength={36} />
              {kind !== 'delivery_task' && (
                <>
                  <Field
                    name="sourceNote"
                    label="Source and reason for this record"
                    maxLength={2000}
                  />
                  <details className="md:col-span-2">
                    <summary className="cursor-pointer text-sm text-slate-600">
                      Link a retained public observation (optional)
                    </summary>
                    <div className="mt-3 grid gap-3 md:grid-cols-2">
                      <Field
                        name="sourceObservation"
                        label="Observation ID"
                        optional
                        maxLength={36}
                      />
                      <Field
                        name="sourceDigest"
                        label="Exact output digest"
                        optional
                        maxLength={64}
                      />
                    </div>
                    <p className="mt-2 text-xs text-slate-500">
                      The server validates the source in this organisation and engagement. This
                      records provenance; it does not turn a public observation into verified
                      processing facts.
                    </p>
                  </details>
                </>
              )}
              <div className="md:col-span-2">
                <button
                  className={button}
                  type="submit"
                  disabled={busy || !!pending || !storageReady || generationChanged}
                >
                  Save{' '}
                  {kind === 'ropa'
                    ? 'processing activity'
                    : kind === 'delivery_task'
                      ? 'delivery task'
                      : 'draft'}
                </button>
              </div>
              {generationChanged && (
                <p role="alert" className="text-sm text-ember-700 md:col-span-2">
                  The generated draft uses a different source or document type. Generate again or
                  restore the original selection before saving.
                </p>
              )}
            </fieldset>
          </form>
        </details>
      )}
      {!writable && (
        <p className="mb-3 text-sm text-slate-600">
          Your role can read recorded activities. Creating records requires an authorised owner or
          administrator.
        </p>
      )}
      {busy && (
        <p role="status" className="text-sm text-slate-500">
          Reading recorded state…
        </p>
      )}
      {!busy && !error && rows.length === 0 && (
        <p className="rounded-md bg-mist-50 p-3 text-sm text-slate-600">
          No {title[kind].toLowerCase()} recorded for this organisation.
        </p>
      )}
      <div className="space-y-3">
        {rows.map((row) => (
          <article key={row.id} className="min-w-0 rounded-md border border-slate-200 p-3">
            <h3 className="font-semibold text-indigo-700">
              {row.kind === 'ropa'
                ? row.payload.system
                : row.kind === 'delivery_task'
                  ? row.payload.taskName
                  : row.kind === 'policy_draft'
                    ? row.payload.title
                    : `Policy ${row.payload.decision}`}
            </h3>
            <p className="mt-1 break-all text-xs text-slate-500">
              Record {row.id} · audit receipt {row.receipt_id} · {formatDateTime(row.created_at)}
            </p>
            {row.kind !== 'policy_review' && (
              <details className="mt-3">
                <summary className="cursor-pointer text-sm text-teal-700">
                  Retained provenance
                </summary>
                <dl className="mt-2 grid gap-2 text-sm">
                  <div>
                    <dt className="text-slate-500">Engagement ID</dt>
                    <dd className="break-all">
                      {row.payload.engagementId ?? 'No engagement assigned'}
                    </dd>
                  </div>
                  {row.kind === 'policy_draft' && (
                    <div>
                      <dt className="text-slate-500">Processing activity ID</dt>
                      <dd className="break-all">
                        {row.payload.sourceRopaId ?? 'No processing activity linked'}
                      </dd>
                    </div>
                  )}
                  {(row.kind === 'ropa' || row.kind === 'policy_draft') && (
                    <>
                      <div>
                        <dt className="text-slate-500">Retained observation ID</dt>
                        <dd className="break-all">
                          {row.payload.source?.observationId ?? 'No public observation bound'}
                        </dd>
                      </div>
                      {row.payload.source && (
                        <div>
                          <dt className="text-slate-500">Exact observation output SHA-256</dt>
                          <dd className="break-all">{row.payload.source.outputSha256}</dd>
                        </div>
                      )}
                    </>
                  )}
                </dl>
              </details>
            )}
            {row.kind === 'ropa' && (
              <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
                {[
                  ['Purpose', row.payload.purpose],
                  ['Legal basis', row.payload.legalBasis],
                  ['Retention in months', row.payload.retentionMonths],
                  ['Processing location', row.payload.region],
                  [
                    'Cross-border',
                    row.payload.crossBorder === null
                      ? null
                      : row.payload.crossBorder
                        ? 'Confirmed yes'
                        : 'Confirmed no',
                  ],
                  ['Data categories', listValue(row.payload.dataCategories)],
                  ['Data principal groups', listValue(row.payload.dataPrincipals)],
                  ['Processors', listValue(row.payload.processors)],
                  ['Recipients', listValue(row.payload.recipients)],
                  ['Transfer destinations', listValue(row.payload.destinationCountries)],
                  ['Transfer safeguards', row.payload.transferSafeguards],
                  [
                    'Impact assessment',
                    row.payload.dpiaRequired === null
                      ? null
                      : row.payload.dpiaRequired
                        ? 'Confirmed required'
                        : 'Confirmed not required',
                  ],
                  ['Security measures', row.payload.securityMeasures],
                  ['Source', row.payload.sourceNote],
                ].map(([label, value]) => (
                  <div key={String(label)} className="min-w-0">
                    <dt className="text-slate-500">{label}</dt>
                    <dd className="break-words">
                      {value ?? 'Unknown — human confirmation required'}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
            {row.kind === 'delivery_task' && (
              <p className="mt-2 text-sm text-slate-600">
                {row.payload.durationMinutes} minutes × {row.payload.repetitions} recorded
                repetitions = {row.payload.durationMinutes * row.payload.repetitions} total minutes.
                Source: {row.payload.source}. {row.payload.notes}
              </p>
            )}
            {row.kind === 'policy_draft' && (
              <>
                <p className="mt-2 break-all text-xs text-slate-600">
                  Draft only · {row.payload.category} · SHA-256 {row.content_sha256} · source:{' '}
                  {row.payload.sourceNote}
                </p>
                <details className="mt-3">
                  <summary className="cursor-pointer text-sm text-teal-700">
                    Read exact draft text
                  </summary>
                  <pre className="mt-2 whitespace-pre-wrap break-words rounded-md bg-mist-50 p-3 font-sans text-sm">
                    {row.payload.content}
                  </pre>
                </details>
                <ul className="mt-3 space-y-2">
                  {reviews
                    .filter((r) => r.kind === 'policy_review' && r.payload.draftId === row.id)
                    .map((r) => (
                      <li key={r.id} className="text-sm text-slate-700">
                        {r.kind === 'policy_review' && (
                          <>
                            {r.payload.decision}: {r.payload.reason} · audit receipt {r.receipt_id}
                          </>
                        )}
                      </li>
                    ))}
                </ul>
                {reviewErrors[row.id] && (
                  <p role="alert" className="mt-3 text-sm text-ember-700">
                    {reviewErrors[row.id]}
                  </p>
                )}
                {canReview &&
                  !reviewErrors[row.id] &&
                  !reviews.some(
                    (r) => r.kind === 'policy_review' && r.payload.draftId === row.id,
                  ) && (
                    <form
                      className="mt-4 grid gap-3"
                      ref={(form) => {
                        if (form) reviewForms.current.set(row.id, form);
                        else reviewForms.current.delete(row.id);
                      }}
                      onSubmit={(e) => submit(e, 'policy_review')}
                    >
                      <input type="hidden" name="draftId" value={row.id} />
                      <input type="hidden" name="expectedHash" value={row.content_sha256 ?? ''} />
                      <Field name="decision" label={`Decision for ${row.payload.title}`}>
                        <select className={input} name="decision" required defaultValue="">
                          <option value="" disabled>
                            Select a decision
                          </option>
                          <option value="approved">Approve draft</option>
                          <option value="rejected">Reject draft</option>
                        </select>
                      </Field>
                      <Field
                        name="reason"
                        label={`Review reason for ${row.payload.title}`}
                        maxLength={2000}
                      />
                      <button
                        className={button}
                        disabled={busy || !!pending || !storageReady}
                        type="submit"
                      >
                        Record founder review
                      </button>
                    </form>
                  )}
              </>
            )}
          </article>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          className={button}
          disabled={busy || offset === 0}
          onClick={() => void task(() => load(Math.max(0, offset - 20)))}
        >
          Previous records
        </button>
        <span className="text-xs text-slate-500">Showing up to 20 records from {offset + 1}</span>
        <button
          className={button}
          disabled={busy || !more}
          onClick={() => void task(() => load(offset + 20))}
        >
          Next records
        </button>
      </div>
      {kind === 'ropa' && (
        <p className="mt-4 text-sm">
          <Link href="/classification" className="text-teal-700 underline">
            Review source observations
          </Link>{' '}
          ·{' '}
          <Link href="/policies" className="text-teal-700 underline">
            Prepare policy and notice drafts
          </Link>
        </p>
      )}
    </section>
  );
}
