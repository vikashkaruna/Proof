'use client';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { EvidenceType } from '@axiom/types';
import { z } from 'zod';
import {
  prepareStagedEvidenceJournal,
  retainStagedEvidenceJournal,
  readStagedEvidenceJournal,
  submitStagedEvidence,
  readAcceptedStagedResult,
  archiveAcceptedStagedRequest,
  readUnconfirmedStagedStatus,
  archiveExpiredStagedRequest,
  stagedRetentionConfiguration,
  stagedEvidenceJournalKey,
  STAGED_EVIDENCE_CHANGED,
  type StagedEvidenceJournal,
  type AcceptedStagedResult,
  type UnconfirmedStagedStatus,
} from './staged-evidence-request';
const optionsSchema = z
  .object({ enabled: z.boolean(), retention: stagedRetentionConfiguration.nullable() })
  .strict()
  .refine((value) => value.enabled === Boolean(value.retention));
const field = 'w-full rounded border border-slate-300 px-3 py-2 text-sm';
const button = 'rounded border border-slate-300 px-3 py-2 text-sm disabled:opacity-50';
/** Human-approved, source-bound agent workflow, separate from legacy direct human ingestion. */
export function StagedEvidencePanel(props: { tenantId: string; actorId: string }) {
  return <StagedEvidenceSessionPanel key={`${props.tenantId}:${props.actorId}`} {...props} />;
}
function StagedEvidenceSessionPanel({ tenantId, actorId }: { tenantId: string; actorId: string }) {
  const [options, setOptions] = useState<z.infer<typeof optionsSchema> | null>(null);
  const [journal, setJournal] = useState<StagedEvidenceJournal | null>(null);
  const [file, setFile] = useState<File | null>(null),
    [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [accepted, setAccepted] = useState<AcceptedStagedResult | null>(null);
  const [unconfirmed, setUnconfirmed] = useState<UnconfirmedStagedStatus | null>(null);
  const [preservationAcknowledged, setPreservationAcknowledged] = useState(false);
  const context = useRef({ tenantId, actorId });
  useLayoutEffect(() => {
    context.current = { tenantId, actorId };
    return () => {
      context.current = { tenantId: '', actorId: '' };
    };
  }, [tenantId, actorId]);
  const [checkedAt, setCheckedAt] = useState(() => Date.now());
  useEffect(() => {
    if (!unconfirmed?.payloadExpiresAt || unconfirmed.terminalReason) return;
    const timer = setTimeout(
      () => setCheckedAt(Date.now()),
      Math.max(0, Date.parse(unconfirmed.payloadExpiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [unconfirmed]);
  const busyRef = useRef(false),
    controller = useRef<AbortController | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    const read = () => {
      try {
        setJournal(readStagedEvidenceJournal(localStorage, tenantId, actorId));
      } catch {
        setError('The retained request is unreadable. Preserve it for review.');
      }
    };
    queueMicrotask(() => {
      if (!abort.signal.aborted) read();
    });
    const changed = (event: Event) => {
      if (
        event instanceof StorageEvent &&
        event.key !== stagedEvidenceJournalKey(tenantId, actorId)
      )
        return;
      read();
      setAccepted(null);
      setUnconfirmed(null);
      setPreservationAcknowledged(false);
    };
    window.addEventListener('storage', changed);
    window.addEventListener(STAGED_EVIDENCE_CHANGED, changed);
    void fetch('/api/bff/v1/evidence/staged-ingestion-options', {
      cache: 'no-store',
      signal: abort.signal,
      headers: { 'X-Tenant-Id': tenantId },
    })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const value = optionsSchema.parse(await response.json());
        if (
          !abort.signal.aborted &&
          context.current.tenantId === tenantId &&
          context.current.actorId === actorId
        )
          setOptions(value);
      })
      .catch(() => {
        if (!abort.signal.aborted)
          setError(
            'Evidence collection is unavailable. Ask your administrator to check the environment setup.',
          );
      });
    return () => {
      abort.abort();
      controller.current?.abort();
      window.removeEventListener('storage', changed);
      window.removeEventListener(STAGED_EVIDENCE_CHANGED, changed);
    };
  }, [tenantId, actorId]);
  async function locked(action: (signal: AbortSignal) => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    const pending = new AbortController();
    controller.current = pending;
    const original = { tenantId, actorId };
    try {
      if (!navigator.locks)
        throw new Error(
          'Use a browser that supports safe request locking before submitting evidence.',
        );
      await navigator.locks.request(
        stagedEvidenceJournalKey(tenantId, actorId),
        { ifAvailable: true },
        async (lock) => {
          if (!lock)
            throw new Error('Another tab is using this retained request. Wait for it to finish.');
          if (
            context.current.tenantId !== original.tenantId ||
            context.current.actorId !== original.actorId
          )
            throw new Error('The active session changed.');
          await action(AbortSignal.any([pending.signal, AbortSignal.timeout(30000)]));
        },
      );
    } catch (cause) {
      if (!pending.signal.aborted)
        setError(
          cause instanceof Error
            ? cause.message
            : 'Evidence acceptance is unconfirmed. Preserve the retained request.',
        );
    } finally {
      if (controller.current === pending) controller.current = null;
      busyRef.current = false;
      if (!pending.signal.aborted) setBusy(false);
    }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget),
      selected = file;
    void locked(async (signal) => {
      if (!selected || !options?.enabled || !options.retention || !acknowledged)
        throw new Error(
          'Select a file and explicitly acknowledge the displayed retention before submitting.',
        );
      if (readStagedEvidenceJournal(localStorage, tenantId, actorId))
        throw new Error('Check the retained request before preparing another.');
      const next = await prepareStagedEvidenceJournal(
        tenantId,
        actorId,
        crypto.randomUUID(),
        {
          filename: selected.name,
          contentType: selected.type || 'application/octet-stream',
          evidenceType: String(data.get('evidenceType')),
          description: String(data.get('description')),
          controlIds: String(data.get('controlIds') ?? '')
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean),
          engagementId: String(data.get('engagementId') ?? '').trim() || null,
        },
        { ...options.retention, acknowledgesImmutableRetention: true },
        selected,
      );
      if (
        signal.aborted ||
        context.current.tenantId !== tenantId ||
        context.current.actorId !== actorId
      )
        throw new Error('The active session changed.');
      retainStagedEvidenceJournal(localStorage, next);
      setJournal(next);
      const result = await submitStagedEvidence(
        localStorage,
        next,
        selected,
        () => context.current,
        signal,
      );
      setAccepted(result);
      setFile(null);
      setAcknowledged(false);
    });
  }
  function recover() {
    void locked(async (signal) => {
      const saved = readStagedEvidenceJournal(localStorage, tenantId, actorId);
      if (!saved) throw new Error('No retained request is available.');
      const result = await readAcceptedStagedResult(
        localStorage,
        saved,
        () => context.current,
        signal,
      );
      setJournal(saved);
      setAccepted(result);
      setUnconfirmed(null);
    });
  }
  function archive() {
    void locked(async (signal) => {
      const saved = readStagedEvidenceJournal(localStorage, tenantId, actorId);
      if (!saved || !accepted) throw new Error('Check the retained result before archiving.');
      await archiveAcceptedStagedRequest(
        localStorage,
        saved,
        accepted,
        () => context.current,
        signal,
      );
      setJournal(null);
      setAccepted(accepted);
    });
  }
  function inspect(expire = false) {
    void locked(async (signal) => {
      const saved = readStagedEvidenceJournal(localStorage, tenantId, actorId);
      if (!saved || (expire && !preservationAcknowledged))
        throw new Error('Acknowledge preservation of the unconfirmed attempt before closing it.');
      const status = await readUnconfirmedStagedStatus(
        localStorage,
        saved,
        () => context.current,
        signal,
        expire,
      );
      setCheckedAt(Date.now());
      setUnconfirmed(status);
      setAccepted(null);
      setPreservationAcknowledged(false);
    });
  }
  function archiveExpired() {
    void locked(async (signal) => {
      const saved = readStagedEvidenceJournal(localStorage, tenantId, actorId);
      if (!saved || !unconfirmed) throw new Error('Inspect the retained expired attempt first.');
      await archiveExpiredStagedRequest(
        localStorage,
        saved,
        unconfirmed,
        () => context.current,
        signal,
      );
      setJournal(null);
      setCheckedAt(Date.now());
      setUnconfirmed(unconfirmed);
      setFile(null);
      setAcknowledged(false);
    });
  }
  return (
    <section
      aria-labelledby="staged-evidence-title"
      className="min-w-0 space-y-4 rounded-xl border border-slate-200 bg-white p-5"
    >
      <div>
        <h2 id="staged-evidence-title" className="text-lg font-semibold">
          Collect evidence with Saakshi
        </h2>
        <p className="text-sm text-slate-600">
          Approve one local file for agent collection into the configured retention vault.
          Acceptance requires storage readback and linked runtime receipts; it does not establish
          compliance.
        </p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      {!options && !error && <p role="status">Checking evidence collection availability…</p>}
      {options && !options.enabled && (
        <p role="status">
          Evidence collection is unavailable. Ask your administrator to complete the environment
          setup.
        </p>
      )}
      {journal ? (
        <div className="space-y-3">
          <p className="text-sm">
            Retained request for <strong>{journal.metadata.filename}</strong> ({journal.byteSize}{' '}
            bytes). Uploaded bytes are not retained in your browser. An unconfirmed attempt must not
            be replaced or uploaded again.
          </p>
          <p className="break-all text-xs">Request: {journal.operationKey}</p>
          <button type="button" className={button} disabled={busy} onClick={recover}>
            Check retained evidence result
          </button>
          <button type="button" className={button} disabled={busy} onClick={() => inspect()}>
            Inspect original collection attempt
          </button>
        </div>
      ) : (
        options?.enabled &&
        options.retention && (
          <form onSubmit={submit} className="space-y-3">
            <fieldset disabled={busy} className="grid gap-3 md:grid-cols-2">
              <label className="text-sm">
                Local file (up to 8 MiB)
                <input
                  type="file"
                  className={field}
                  required
                  onChange={(event) => {
                    setFile(event.target.files?.[0] ?? null);
                    setAcknowledged(false);
                  }}
                />
              </label>
              <label className="text-sm">
                Evidence type
                <select name="evidenceType" className={field} defaultValue={EvidenceType.DOCUMENT}>
                  {Object.values(EvidenceType).map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-sm md:col-span-2">
                Description
                <textarea name="description" required maxLength={2000} className={field} />
              </label>
              <label className="text-sm">
                Engagement ID (optional)
                <input name="engagementId" className={field} />
              </label>
              <label className="text-sm">
                Control IDs (optional, comma separated)
                <input name="controlIds" className={field} />
              </label>
            </fieldset>
            <p className="break-words text-sm">
              Destination: {options.retention.provider} / {options.retention.bucket}. Object Lock
              mode: COMPLIANCE. Retention: seven years. Encryption: {options.retention.encryption}.
              Legal hold: {options.retention.legalHold ? 'enabled' : 'disabled'}.
            </p>
            <p className="text-sm">
              The temporary upload is encrypted and expires after fifteen minutes. Expiry does not
              delete an object that may already have reached the retention vault.
            </p>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={acknowledged}
                disabled={busy}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
              I approve this file for the displayed destination and retention. I understand retained
              object versions cannot be shortened or deleted before retention expires, and an
              enabled legal hold may extend preservation.
            </label>
            <button type="submit" className={button} disabled={busy || !file || !acknowledged}>
              Approve and collect file
            </button>
          </form>
        )
      )}
      {accepted && (
        <div
          role="status"
          className="space-y-2 rounded border border-emerald-200 bg-emerald-50 p-3 text-sm"
        >
          <p>Evidence accepted with matching storage and runtime receipts.</p>
          <p className="break-all">Evidence: {accepted.evidenceId}</p>
          <p className="break-all">Evidence version record: {accepted.objectVersionId}</p>
          <p className="break-all">Storage version: {accepted.storageVersionId}</p>
          <p className="break-all">Receipts: {Object.values(accepted.receipts).join(' → ')}</p>
          {journal && (
            <button type="button" className={button} disabled={busy} onClick={archive}>
              Confirm result and clear retained request
            </button>
          )}
        </div>
      )}
      {unconfirmed && (
        <div className="space-y-3 rounded border border-amber-200 bg-amber-50 p-3 text-sm">
          <p>
            Collection remains unaccepted. Runtime outcome:{' '}
            {unconfirmed.runtimeOutcome === 'runtime_reported_failure'
              ? 'reported failure'
              : 'unconfirmed'}
            .
          </p>
          <p className="break-all">
            Original destination: {unconfirmed.source.provider} / {unconfirmed.source.bucket} /{' '}
            {unconfirmed.source.object_key}
          </p>
          <p>
            Storage observation:{' '}
            {unconfirmed.providerObservation === 'not_attempted'
              ? 'upload lease not consumed'
              : unconfirmed.providerObservation === 'outcome_unknown'
                ? 'outcome unknown; an object may exist'
                : 'version observed but not accepted'}
            .
          </p>
          {unconfirmed.observedVersion && (
            <p className="break-all">Unaccepted observed version: {unconfirmed.observedVersion}</p>
          )}
          {unconfirmed.payloadExpiresAt && (
            <p>
              Temporary upload expires: {new Date(unconfirmed.payloadExpiresAt).toLocaleString()}.
            </p>
          )}
          {journal &&
            !unconfirmed.terminalReason &&
            unconfirmed.payloadExpiresAt &&
            Date.parse(unconfirmed.payloadExpiresAt) <= checkedAt && (
              <>
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={preservationAcknowledged}
                    disabled={busy}
                    onChange={(event) => setPreservationAcknowledged(event.target.checked)}
                  />
                  I understand any retained object remains unaccepted and its original target and
                  observed version will be preserved.
                </label>
                <button
                  type="button"
                  className={button}
                  disabled={busy || !preservationAcknowledged}
                  onClick={() => inspect(true)}
                >
                  Close expired collection attempt
                </button>
              </>
            )}
          {journal && unconfirmed.newApprovedKeyAllowed && (
            <>
              <p>
                The expired reference must be preserved before a different, explicitly approved
                request can be prepared. The original upload lease will not be reused.
              </p>
              <button type="button" className={button} disabled={busy} onClick={archiveExpired}>
                Preserve expired reference and prepare new approval
              </button>
            </>
          )}
        </div>
      )}
      {busy && <p role="status">Checking the approved request…</p>}
    </section>
  );
}
