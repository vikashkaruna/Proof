'use client';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  proposalOptionsSchema,
  ProposalRequestError,
  PROPOSAL_CHANGED,
  proposalJournalKey,
  readProposalJournal,
  retainProposalJournal,
  retainedProposalSchema,
  submitProposal,
  readSelectedProposalSource,
  type Proposal,
} from './proposal-request';
export function ProposalPanel(props: { tenantId: string; actorId: string; canPropose: boolean }) {
  return <Panel key={`${props.tenantId}:${props.actorId}:${props.canPropose}`} {...props} />;
}
function Panel({
  tenantId,
  actorId,
  canPropose,
}: {
  tenantId: string;
  actorId: string;
  canPropose: boolean;
}) {
  const key = proposalJournalKey(tenantId, actorId);
  const subscribe = useCallback(
    (notify: () => void) => {
      const storage = (e: StorageEvent) => {
        if (e.key === null || e.key === key) notify();
      };
      window.addEventListener('storage', storage);
      window.addEventListener(PROPOSAL_CHANGED, notify);
      return () => {
        window.removeEventListener('storage', storage);
        window.removeEventListener(PROPOSAL_CHANGED, notify);
      };
    },
    [key],
  );
  const read = useCallback(() => {
    try {
      return localStorage.getItem(key);
    } catch {
      return '__unavailable__';
    }
  }, [key]);
  const raw = useSyncExternalStore(subscribe, read, () => '__unhydrated__');
  const journal = useMemo(() => {
    if (raw === '__unhydrated__') return { ready: false, retained: null, invalid: false };
    try {
      return {
        ready: true,
        retained: readProposalJournal({ getItem: () => raw }, tenantId, actorId),
        invalid: false,
      };
    } catch {
      return { ready: false, retained: null, invalid: true };
    }
  }, [raw, tenantId, actorId]);
  const [options, setOptions] = useState<ReturnType<typeof proposalOptionsSchema.parse> | null>(
      null,
    ),
    [selected, setSelected] = useState(''),
    [title, setTitle] = useState('Assessment review proposal'),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState<{ key: string; proposal: Proposal; runId: string } | null>(null);
  const mounted = useRef(true),
    active = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!canPropose) return;
    const abort = new AbortController();
    void fetch('/api/bff/v1/plans/proposal-assessment-options', {
      cache: 'no-store',
      headers: { 'X-Tenant-Id': tenantId },
      signal: abort.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new ProposalRequestError();
        const parsed = proposalOptionsSchema.parse(await response.json());
        if (!abort.signal.aborted) setOptions(parsed);
      })
      .catch(() => {
        if (!abort.signal.aborted)
          setError('Finalized assessment sources are unavailable. Refresh to check again.');
      });
    return () => abort.abort();
  }, [canPropose, tenantId]);
  const retained = journal.retained,
    displayed = result && retained && result.key === retained.request.operationKey ? result : null;
  const execute = async (recover: boolean) => {
    if (active.current || !canPropose || !journal.ready) return;
    active.current = true;
    setBusy(true);
    setError(null);
    try {
      if (!navigator.locks)
        throw new ProposalRequestError(
          'Cross-tab request protection is unavailable. Use a supported browser.',
        );
      await navigator.locks.request(key, async () => {
        if (!mounted.current) return;
        let value = readProposalJournal(localStorage, tenantId, actorId);
        if (recover) {
          if (!value || !retained || JSON.stringify(value) !== JSON.stringify(retained))
            throw new ProposalRequestError(
              'The retained request changed. Review it before retrying.',
            );
        } else {
          if (value)
            throw new ProposalRequestError(
              'Another tab has retained a proposal. Review that request first.',
            );
          const option = options?.assessments.find((a) => a.assessmentRunId === selected);
          if (!options?.runtimeAvailable || !option || !title.trim() || title.trim().length > 300)
            throw new ProposalRequestError(
              'Choose an available finalized assessment and a valid title.',
            );
          const source = await readSelectedProposalSource(
            tenantId,
            option.assessmentRunId,
            option.engagementId,
          );
          if (!mounted.current) return;
          const input = { ...source, title: title.trim() };
          value = {
            version: 1,
            tenantId,
            actorId,
            input,
            request: {
              operationKey: crypto.randomUUID(),
              engagementId: input.engagement_id,
              assessmentRunId: input.source.assessmentRunId,
              title: input.title,
            },
          };
          retainProposalJournal(localStorage, value);
        }
        const current = retainedProposalSchema.parse(value);
        const response = await submitProposal(current);
        if (!mounted.current) return;
        const live = readProposalJournal(localStorage, tenantId, actorId);
        if (!live || JSON.stringify(live) !== JSON.stringify(current))
          throw new ProposalRequestError(
            'The retained request changed while waiting. Its response was not adopted.',
          );
        setResult({
          key: current.request.operationKey,
          proposal: response.proposal,
          runId: response.invocation.runId,
        });
      });
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof ProposalRequestError
            ? cause.message
            : 'The response was interrupted. Keep the retained request and use the same request to check again.',
        );
    } finally {
      active.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  if (!canPropose) return null;
  return (
    <section
      aria-labelledby="proposal-title"
      className="min-w-0 space-y-4 rounded-lg border border-slate-200 bg-white p-4"
    >
      <h2 id="proposal-title" className="text-lg font-semibold text-[#1E2A4A]">
        Request an assessment review proposal
      </h2>
      <p className="text-sm text-slate-600">
        Sudhaar reads a finalized assessment and proposes human review tasks. The proposal is not a
        saved remediation plan, does not close findings, and cannot authorize execution.
      </p>
      {journal.invalid && (
        <p role="alert">
          The retained proposal request is unreadable. Preserve browser state for administrator
          review.
        </p>
      )}
      {retained ? (
        <div className="space-y-2">
          <p className="break-all">Retained request: {retained.request.operationKey}</p>
          <p className="break-all">Assessment run: {retained.request.assessmentRunId}</p>
          <p>
            No request is resubmitted automatically. A retry preserves the exact source, actor,
            title and operation key.
          </p>
          <button
            type="button"
            disabled={busy || !journal.ready}
            onClick={() => void execute(true)}
            className="rounded-md border px-3 py-2"
          >
            {busy ? 'Checking proposal…' : 'Check using the same request'}
          </button>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void execute(false);
          }}
          className="space-y-3"
        >
          <label className="block">
            Finalized assessment
            <select
              aria-label="Finalized assessment"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              disabled={!options || !options.runtimeAvailable || busy}
              className="mt-1 block w-full rounded-md border p-2"
            >
              <option value="">Choose an assessment</option>
              {options?.assessments.map((a) => (
                <option key={a.assessmentRunId} value={a.assessmentRunId}>
                  {a.engagementTitle} · {a.libraryVersion} · {a.finalizedAt}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            Proposal title
            <input
              aria-label="Proposal title"
              value={title}
              maxLength={300}
              onChange={(e) => setTitle(e.target.value)}
              disabled={busy}
              className="mt-1 block w-full rounded-md border p-2"
            />
          </label>
          <button
            type="submit"
            disabled={
              !journal.ready || !options?.runtimeAvailable || !selected || !title.trim() || busy
            }
            className="rounded-md bg-[#1E2A4A] px-3 py-2 text-white disabled:opacity-50"
          >
            {busy ? 'Requesting proposal…' : 'Request review proposal'}
          </button>
        </form>
      )}
      {!options && !error && <p role="status">Loading finalized assessment sources…</p>}
      {options && !options.runtimeAvailable && (
        <p role="status">
          Proposal execution is unavailable in this environment. An administrator must configure the
          planning runtime and independent source key.
        </p>
      )}
      {options?.runtimeAvailable && options.assessments.length === 0 && (
        <p>
          No finalized assessment is available. Complete an assessment before requesting review
          work.
        </p>
      )}
      {options && options.total > 25 && <p>Showing the latest 25 finalized assessments.</p>}
      {error && (
        <p role="alert" className="rounded-md border border-red-200 p-3">
          {error}
        </p>
      )}
      {displayed && (
        <div className="space-y-3" aria-label="Review proposal">
          <h3 className="break-words font-semibold">{displayed.proposal.title}</h3>
          <p>Human review required · Escalated · Not saved as a plan · Execution unavailable</p>
          <p>
            {displayed.proposal.review_tasks.length} review tasks · 0 corrective actions · No
            inferred record counts or systems
          </p>
          <p className="break-all text-xs">
            Run {displayed.runId} · Source {displayed.proposal.source.assessmentRunId} · Library{' '}
            {displayed.proposal.source.libraryVersion}
          </p>
          <ol className="space-y-3">
            {displayed.proposal.review_tasks.map((task) => (
              <li key={task.finding_id} className="break-words rounded-md border p-3">
                <strong>
                  {task.sequence}. {task.control_id}: {task.title}
                </strong>
                <p>{task.reason.replaceAll('_', ' ')}</p>
                <p className="text-sm text-slate-600">{task.instruction}</p>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
