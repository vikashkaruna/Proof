'use client';

import React, { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ModuleBarFor } from '@/lib/module-bar';
import {
  actionBody,
  availableActions,
  deadlineLabel,
  intakeBody,
  postDsar,
  type DsarAction,
  type DsarRow,
} from './dsar-workflow';

const LABELS: Record<DsarAction, string> = {
  verify: 'Record identity verification',
  in_fulfilment: 'Start fulfilment',
  completed: 'Complete with evidence',
  rejected: 'Reject request',
  escalated: 'Escalate request',
};
const fieldClass = 'mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm';
const buttonClass =
  'rounded-md bg-[#1E2A4A] px-3 py-2 text-sm font-medium text-white disabled:opacity-50';
const date = (value: string) =>
  new Date(value).toISOString().replace('T', ' ').replace('.000Z', ' UTC');

export function DsarClient({
  tenantId,
  rows,
  canManage,
  loadError,
  hasMore,
  asOf,
}: {
  tenantId: string;
  rows: DsarRow[];
  canManage: boolean;
  loadError: string | null;
  hasMore: boolean;
  asOf: number;
}) {
  const router = useRouter();
  const lock = useRef(false);
  // Keep uncertain attempts stable in memory, never persist principal data in browser storage.
  const attempts = useRef(new Map<string, string>());
  const [busy, setBusy] = useState(false);
  const [refreshing, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [intakeOpen, setIntakeOpen] = useState(false);
  const [editor, setEditor] = useState<{ id: string; action: DsarAction } | null>(null);
  const disabled = busy || refreshing;

  async function submit(path: string, build: () => unknown) {
    if (!canManage || lock.current || refreshing) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const body = build();
      const fingerprint = JSON.stringify([path, body]);
      const key = attempts.current.get(fingerprint) ?? crypto.randomUUID();
      attempts.current.set(fingerprint, key);
      const result = await postDsar(tenantId, path, body, key);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      attempts.current.delete(fingerprint);
      setEditor(null);
      setIntakeOpen(false);
      setMessage('Action recorded. Refreshing the saved state.');
      startTransition(() => router.refresh());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The action could not be submitted.');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-[#1E2A4A]">Data subject requests</h1>
          <p className="text-sm text-slate-600">
            Recorded identity checks, fulfilment and deadlines for this tenant.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className={buttonClass}
            disabled={disabled}
            onClick={() => startTransition(() => router.refresh())}
          >
            Refresh records
          </button>
          {canManage && (
            <button
              type="button"
              className={buttonClass}
              disabled={disabled}
              onClick={() => {
                setIntakeOpen(!intakeOpen);
                setEditor(null);
                setError(null);
              }}
            >
              {' '}
              {intakeOpen ? 'Close intake' : 'Record request'}
            </button>
          )}
        </div>
      </header>
      <ModuleBarFor module="dsar" />
      {!canManage && !loadError && (
        <p className="text-sm text-slate-600">
          Read-only access. Managing requests requires estate.manage permission.
        </p>
      )}
      {loadError && (
        <p role="alert" className="text-[#D9534F]">
          {loadError}
        </p>
      )}
      {error && (
        <p role="alert" className="rounded border border-[#D9534F] p-3 text-[#D9534F]">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="text-sm text-slate-600">
          {message}
        </p>
      )}
      {intakeOpen && canManage && (
        <form
          className="space-y-3 rounded-lg border bg-white p-5"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            void submit('', () => intakeBody(form));
          }}
        >
          <h2 className="font-semibold">Record a rights request</h2>
          <p className="text-sm text-slate-600">
            The server starts a 30-day workflow deadline when this request is recorded. Provide an
            email or phone. Keep identity documents and other sensitive evidence out of the notes.
          </p>
          <fieldset disabled={disabled} className="space-y-3">
            <label className="block text-sm">
              Request type
              <select name="kind" className={fieldClass}>
                <option value="access">Access</option>
                <option value="correction">Correction</option>
                <option value="erasure">Erasure</option>
                <option value="nominate">Nomination</option>
                <option value="portability">Portability</option>
              </select>
            </label>
            <label className="block text-sm">
              Principal name (optional)
              <input
                name="principalName"
                maxLength={200}
                autoComplete="off"
                className={fieldClass}
              />
            </label>
            <label className="block text-sm">
              Principal email
              <input
                name="principalEmail"
                type="email"
                maxLength={320}
                autoComplete="off"
                className={fieldClass}
              />
            </label>
            <label className="block text-sm">
              Principal phone
              <input
                name="principalPhone"
                type="tel"
                minLength={6}
                maxLength={20}
                autoComplete="off"
                className={fieldClass}
              />
            </label>
            <label className="block text-sm">
              Intake notes (optional)
              <textarea name="notes" maxLength={2000} className={fieldClass} />
            </label>
            <button type="submit" className={buttonClass}>
              Record and start deadline
            </button>
          </fieldset>
        </form>
      )}
      {!loadError && rows.length === 0 && (
        <p className="rounded-lg border border-dashed p-6 text-slate-600">
          No rights requests recorded.
        </p>
      )}
      {!loadError && hasMore && (
        <p role="status" className="text-sm text-slate-600">
          Showing the first 200 requests by deadline. More requests exist; these counts are not
          tenant totals.
        </p>
      )}
      {!loadError &&
        rows.map((row) => (
          <section
            key={row.id}
            className="space-y-3 rounded-lg border border-slate-200 bg-white p-5"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-lg font-semibold text-[#1E2A4A]">{row.kind} request</h2>
              <span className="rounded bg-slate-100 px-2 py-1 text-sm">
                {row.status.replaceAll('_', ' ')}
              </span>
            </div>
            <p className="break-all font-mono text-xs text-slate-500">{row.id}</p>
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-slate-500">Principal</dt>
                <dd>{row.data_principal_name ?? 'Name not recorded'}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Identity</dt>
                <dd>
                  {row.identity_verified
                    ? `Verified: ${row.identity_verification_method ?? 'method not recorded'}`
                    : 'Not verified'}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">Received</dt>
                <dd>{date(row.received_at)}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Server deadline</dt>
                <dd>
                  {date(row.due_by)} ·{' '}
                  <span
                    className={
                      deadlineLabel(row, asOf) === 'Overdue' ? 'font-semibold text-[#D9534F]' : ''
                    }
                  >
                    {deadlineLabel(row, asOf)}
                  </span>
                </dd>
              </div>
              {row.completed_at && (
                <div>
                  <dt className="text-slate-500">Completed</dt>
                  <dd>{date(row.completed_at)}</dd>
                </div>
              )}
            </dl>
            <details>
              <summary className="cursor-pointer text-sm text-slate-600">
                Contact and request notes
              </summary>
              <div className="mt-2 space-y-1 break-words text-sm">
                <p>{row.data_principal_email ?? 'Email not recorded'}</p>
                <p>{row.data_principal_phone ?? 'Phone not recorded'}</p>
                <p>{row.notes ?? 'No intake notes'}</p>
              </div>
            </details>
            {row.rejection_reason && (
              <p className="text-sm">Rejection reason: {row.rejection_reason}</p>
            )}
            {row.status === 'escalated' && (
              <p className="text-sm text-slate-600">
                Escalated for review. No further status transition is currently supported.
              </p>
            )}
            {canManage && (
              <div className="flex flex-wrap gap-2">
                {availableActions(row).map((action) => (
                  <button
                    key={action}
                    type="button"
                    className={buttonClass}
                    disabled={disabled}
                    onClick={() => {
                      setEditor({ id: row.id, action });
                      setIntakeOpen(false);
                      setError(null);
                    }}
                  >
                    {LABELS[action]}
                  </button>
                ))}
              </div>
            )}
            {canManage &&
              editor?.id === row.id &&
              availableActions(row).includes(editor.action) && (
                <form
                  key={`${row.id}-${editor.action}`}
                  className="space-y-3 border-t pt-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const form = new FormData(event.currentTarget);
                    const action = editor.action;
                    void submit(`/${row.id}/${action === 'verify' ? 'verify' : 'advance'}`, () =>
                      actionBody(action, form),
                    );
                  }}
                >
                  <h3 className="font-medium">{LABELS[editor.action]}</h3>
                  <fieldset disabled={disabled} className="space-y-3">
                    {editor.action === 'verify' ? (
                      <>
                        <p className="text-sm text-slate-600">
                          Record a check you have already performed. This action does not verify
                          identity automatically. Describe the method without identity document
                          numbers or copies.
                        </p>
                        <label className="block text-sm">
                          Verification method
                          <input name="method" required maxLength={120} className={fieldClass} />
                        </label>
                      </>
                    ) : (
                      <>
                        {editor.action === 'in_fulfilment' && (
                          <p className="text-sm text-slate-600">
                            Start tracking fulfilment for this verified principal. This does not
                            execute data changes or send a response.
                          </p>
                        )}
                        {editor.action === 'completed' && (
                          <>
                            <p className="text-sm text-slate-600">
                              Complete only after fulfilling the request. Reference the saved
                              evidence for fulfilment and response delivery. This action does not
                              send a response.
                            </p>
                            <label className="block text-sm">
                              Fulfilment evidence UUID
                              <input name="fulfilmentEvidenceId" required className={fieldClass} />
                            </label>
                          </>
                        )}
                        <label className="block text-sm">
                          {editor.action === 'rejected'
                            ? 'Rejection reason (required)'
                            : 'Decision note (optional)'}
                          <textarea
                            name="note"
                            required={editor.action === 'rejected'}
                            maxLength={2000}
                            className={fieldClass}
                          />
                        </label>
                      </>
                    )}
                    <div className="flex gap-2">
                      <button type="submit" className={buttonClass}>
                        Confirm {LABELS[editor.action].toLowerCase()}
                      </button>
                      <button
                        type="button"
                        className="px-3 py-2 text-sm"
                        onClick={() => setEditor(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </fieldset>
                </form>
              )}
          </section>
        ))}
      {!loadError && rows.length > 0 && (
        <p className="text-xs text-slate-500">
          Deadlines shown as of {date(new Date(asOf).toISOString())}. Refresh records for current
          state.
        </p>
      )}
    </div>
  );
}
