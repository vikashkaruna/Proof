'use client';

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from 'react';
import { z } from 'zod';
import { generateUUID } from '@axiom/ui';

import {
  clearIntakeJournal,
  readIntakeJournal,
  retainIntakeJournal,
  type IntakeIntent,
} from './intake-journal';

const createdSchema = z.object({ id: z.uuid() });
const errorSchema = z.object({
  error: z.object({ code: z.string().optional(), message: z.string() }),
});

interface Attempt extends IntakeIntent {
  outcomeUnknown: boolean;
}
const subscribeHydration = () => () => {};
const hydratedSnapshot = () => true;
const serverSnapshot = () => false;

export function CreateAssessmentForm({
  tenantId,
  actorId,
  libraryVersion,
  estates,
}: {
  tenantId: string;
  actorId: string;
  libraryVersion: string;
  estates: Array<{ id: string; name: string }>;
}) {
  const hydrated = useSyncExternalStore(subscribeHydration, hydratedSnapshot, serverSnapshot);
  const [draft, setDraft] = useState({
    tenantId,
    actorId,
    libraryVersion,
    title: '',
    estateId: '',
  });
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [feedback, setFeedback] = useState({ tenantId, actorId, libraryVersion, message: '' });
  const [created, setCreated] = useState<{
    tenantId: string;
    actorId: string;
    libraryVersion: string;
    id: string;
  } | null>(null);
  const [journalActor, setJournalActor] = useState<string | null>(null);
  const journalReady = journalActor === actorId;
  const inFlight = useRef<Attempt | null>(null);
  const attempt = useRef<Attempt | null>(null);
  const [attemptScope, setAttemptScope] = useState<IntakeIntent | null>(null);
  const [recoveryConfirmation, setRecoveryConfirmation] = useState<string | null>(null);

  const currentScope = useRef({ tenantId, actorId, libraryVersion, active: true });
  useLayoutEffect(() => {
    currentScope.current = { tenantId, actorId, libraryVersion, active: true };
    return () => {
      currentScope.current.active = false;
    };
  }, [tenantId, actorId, libraryVersion]);
  const matches = (scope: { tenantId: string; actorId: string; libraryVersion: string }) =>
    scope.tenantId === tenantId &&
    scope.actorId === actorId &&
    scope.libraryVersion === libraryVersion;
  const title = matches(draft) ? draft.title : '';
  const estateId = matches(draft) ? draft.estateId : '';
  const blockedScope = attemptScope !== null && !matches(attemptScope);
  const recoveryAvailable =
    attemptScope !== null &&
    attemptScope.actorId === actorId &&
    attemptScope.tenantId === tenantId &&
    attemptScope.libraryVersion !== libraryVersion;
  const recoveryContext =
    recoveryAvailable && attemptScope
      ? `${actorId}:${tenantId}:${libraryVersion}:${attemptScope.libraryVersion}:${attemptScope.requestKey}`
      : null;
  const createdId = created && matches(created) ? created.id : null;
  const message = recoveryAvailable
    ? 'An earlier-library intake remains unconfirmed. Review its frozen context below before checking the same request.'
    : blockedScope
      ? 'Return to the original organisation and control library to check this assessment request.'
      : matches(feedback)
        ? feedback.message
        : '';
  const setMessage = (message: string) =>
    setFeedback({ tenantId, actorId, libraryVersion, message });

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      setJournalActor(null);
      setBusy(false);
      try {
        const retained = readIntakeJournal(localStorage, actorId);
        attempt.current = retained ? { ...retained, outcomeUnknown: true } : null;
        setAttemptScope(retained);
        setUncertain(Boolean(retained));
        if (retained)
          setDraft({
            tenantId: retained.tenantId,
            actorId: retained.actorId,
            libraryVersion: retained.libraryVersion,
            title: retained.title,
            estateId: retained.estateId,
          });
        if (retained)
          setFeedback({
            tenantId: retained.tenantId,
            actorId: retained.actorId,
            libraryVersion: retained.libraryVersion,
            message:
              'A previous creation outcome is unconfirmed. Retry the same retained request to check its result.',
          });
        setJournalActor(actorId);
      } catch {
        setFeedback({
          tenantId: currentScope.current.tenantId,
          actorId,
          libraryVersion: currentScope.current.libraryVersion,
          message:
            'The retained intake request could not be verified. Nothing will be sent. Restore browser storage access and refresh; do not create another assessment until the original request is resolved.',
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [actorId]);

  async function submit(event: Pick<FormEvent, 'preventDefault'>, frozenRecovery = false) {
    event.preventDefault();
    if (
      !journalReady ||
      (inFlight.current &&
        inFlight.current.actorId === actorId &&
        inFlight.current.tenantId === tenantId) ||
      (blockedScope &&
        !(frozenRecovery && recoveryAvailable && recoveryConfirmation === recoveryContext)) ||
      createdId
    )
      return;
    const name = title.trim();
    if (!uncertain && (name.length < 3 || name.length > 200)) {
      setMessage('Enter an assessment title between 3 and 200 characters.');
      return;
    }
    let current: Attempt;
    try {
      current =
        uncertain && attempt.current
          ? attempt.current
          : {
              requestKey: generateUUID(),
              actorId,
              title: name,
              estateId,
              tenantId,
              libraryVersion,
              outcomeUnknown: false,
            };
    } catch {
      setMessage('The assessment request could not be prepared. Nothing was sent.');
      return;
    }
    try {
      retainIntakeJournal(localStorage, {
        actorId: current.actorId,
        tenantId: current.tenantId,
        libraryVersion: current.libraryVersion,
        requestKey: current.requestKey,
        title: current.title,
        estateId: current.estateId,
      });
    } catch {
      setMessage(
        'The intake request could not be retained. Nothing was sent. Resolve any retained request and restore browser storage access.',
      );
      return;
    }
    attempt.current = current;
    setAttemptScope(current);
    if (frozenRecovery) setRecoveryConfirmation(null);
    inFlight.current = current;
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch('/api/bff/v1/engagements', {
        method: 'POST',
        signal: AbortSignal.timeout(20000),
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-Id': current.tenantId,
          'X-Expected-Actor-Id': current.actorId,
          'Idempotency-Key': current.requestKey,
        },
        body: JSON.stringify({
          title: current.title,
          libraryVersion: current.libraryVersion,
          ...(current.estateId ? { estateId: current.estateId } : {}),
          requestKey: current.requestKey,
        }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (response.ok) {
        const created = createdSchema.safeParse(body);
        if (!created.success || created.data.id.toLowerCase() !== current.requestKey.toLowerCase())
          throw new Error('unconfirmed_response');
        let storageWarning = '';
        try {
          clearIntakeJournal(localStorage, {
            actorId: current.actorId,
            tenantId: current.tenantId,
            libraryVersion: current.libraryVersion,
            requestKey: current.requestKey,
            title: current.title,
            estateId: current.estateId,
          });
        } catch {
          storageWarning =
            ' Browser recovery storage could not be cleared; this confirmed assessment remains saved. Refresh and reconcile the original request before creating another.';
        }
        if (attempt.current !== current) return;
        attempt.current = null;
        if (currentScope.current.active) {
          setUncertain(false);
          setAttemptScope(null);
          setCreated({
            tenantId: current.tenantId,
            actorId: current.actorId,
            libraryVersion: current.libraryVersion,
            id: created.data.id,
          });
          setFeedback({
            tenantId: current.tenantId,
            actorId: current.actorId,
            libraryVersion: current.libraryVersion,
            message: 'Assessment created. Open its saved record to continue.' + storageWarning,
          });
        }
        return;
      }
      const parsed = errorSchema.safeParse(body);
      if (
        response.status >= 500 &&
        (!parsed.success || parsed.data.error.code !== 'library_unavailable')
      ) {
        throw new Error('unconfirmed_response');
      }
      if (parsed.success && parsed.data.error.code === 'idempotency_in_progress') {
        throw new Error('unconfirmed_response');
      }
      if (current.outcomeUnknown) throw new Error('unconfirmed_replay');
      clearIntakeJournal(localStorage, {
        actorId: current.actorId,
        tenantId: current.tenantId,
        libraryVersion: current.libraryVersion,
        requestKey: current.requestKey,
        title: current.title,
        estateId: current.estateId,
      });
      if (attempt.current !== current) return;
      attempt.current = null;
      if (currentScope.current.active) {
        setUncertain(false);
        setAttemptScope(null);
        setFeedback({
          tenantId: current.tenantId,
          actorId: current.actorId,
          libraryVersion: current.libraryVersion,
          message: parsed.success
            ? parsed.data.error.message
            : 'The assessment was not created. Review the details and try again.',
        });
      }
    } catch {
      // A timeout, transport failure or server error may follow a committed
      // insert. Keep the exact intent and UUID for a replay-safe retry.
      const pending = { ...current, outcomeUnknown: true };
      if (currentScope.current.active && attempt.current === current) {
        attempt.current = pending;
        setUncertain(true);
        setFeedback({
          tenantId: current.tenantId,
          actorId: current.actorId,
          libraryVersion: current.libraryVersion,
          message:
            'The creation outcome is unconfirmed. Retry the same request to check its result.',
        });
      }
    } finally {
      if (inFlight.current === current) {
        inFlight.current = null;
        if (currentScope.current.active && currentScope.current.actorId === current.actorId)
          setBusy(false);
      }
    }
  }

  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="space-y-3 rounded-xl border border-slate-200 bg-white p-5"
      aria-label="Create assessment"
    >
      <div>
        <h2 className="font-heading text-base font-semibold text-[#1E2A4A]">Create assessment</h2>
        <p className="mt-1 text-xs text-slate-600">
          Start an intake using published control library {libraryVersion}. Select an estate when
          its assessment boundary is already declared.
        </p>
      </div>
      <fieldset
        disabled={busy || uncertain || blockedScope || Boolean(createdId)}
        className="grid gap-3 sm:grid-cols-2"
      >
        <label className="text-sm font-medium text-slate-700">
          Assessment title
          <input
            value={title}
            onChange={(event) =>
              setDraft({ tenantId, actorId, libraryVersion, title: event.target.value, estateId })
            }
            required
            minLength={3}
            maxLength={200}
            className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        </label>
        <label className="text-sm font-medium text-slate-700">
          Assessment estate (optional)
          <select
            value={estateId}
            onChange={(event) =>
              setDraft({ tenantId, actorId, libraryVersion, title, estateId: event.target.value })
            }
            className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          >
            <option value="">Assign an estate later</option>
            {estates.map((estate) => (
              <option key={estate.id} value={estate.id}>
                {estate.name}
              </option>
            ))}
          </select>
        </label>
      </fieldset>
      {message && (
        <p role={uncertain ? 'alert' : 'status'} className="text-sm text-slate-700">
          {message}
        </p>
      )}
      {recoveryAvailable && attemptScope && (
        <section
          aria-label="Retained intake recovery"
          className="space-y-3 rounded-lg border border-amber-300 p-4 text-sm"
        >
          <h3 className="font-semibold">Check the earlier-library request</h3>
          <p>
            This checks the original intent only. The current library remains {libraryVersion}; no
            new assessment intent is prepared here.
          </p>
          <dl>
            <dt>Retained title</dt>
            <dd>{attemptScope.title}</dd>
            <dt>Retained estate</dt>
            <dd>{attemptScope.estateId || 'Unassigned'}</dd>
            <dt>Retained library</dt>
            <dd>{attemptScope.libraryVersion}</dd>
            <dt>Retained request key</dt>
            <dd className="break-all font-mono">{attemptScope.requestKey}</dd>
          </dl>
          <label className="flex gap-2">
            <input
              type="checkbox"
              checked={recoveryConfirmation === recoveryContext}
              disabled={busy}
              onChange={(event) =>
                setRecoveryConfirmation(event.target.checked ? recoveryContext : null)
              }
            />
            I reviewed this retained intent and authorize checking the exact original request.
          </label>
          <button
            type="button"
            disabled={busy || !journalReady || recoveryConfirmation !== recoveryContext}
            onClick={(event) => void submit(event, true)}
            className="rounded border border-teal-700 px-4 py-2 disabled:opacity-60"
          >
            Check retained request
          </button>
        </section>
      )}
      {created &&
        created.tenantId === tenantId &&
        created.actorId === actorId &&
        created.libraryVersion !== libraryVersion && (
          <a
            href={`/assessment?engagement=${encodeURIComponent(created.id)}`}
            className="font-semibold text-teal-800 underline"
          >
            Open recovered assessment (library {created.libraryVersion})
          </a>
        )}
      {createdId && (
        <a
          href={`/assessment?engagement=${encodeURIComponent(createdId)}`}
          className="inline-flex rounded-md border border-teal-700 px-4 py-2 text-sm font-semibold text-teal-800 hover:bg-teal-50"
        >
          Open saved assessment
        </a>
      )}
      <button
        type="submit"
        disabled={!hydrated || !journalReady || busy || blockedScope || Boolean(createdId)}
        className="rounded-md bg-[#0FB5A5] px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
      >
        {busy ? 'Checking assessment…' : uncertain ? 'Retry same request' : 'Create assessment'}
      </button>
    </form>
  );
}
