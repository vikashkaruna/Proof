'use client';

import { useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { z } from 'zod';

const createdSchema = z.object({ id: z.uuid() });
const errorSchema = z.object({
  error: z.object({ code: z.string().optional(), message: z.string() }),
});

interface Attempt {
  requestKey: string;
  title: string;
  estateId: string;
}
const subscribeHydration = () => () => {};
const hydratedSnapshot = () => true;
const serverSnapshot = () => false;

export function CreateAssessmentForm({
  tenantId,
  libraryVersion,
  estates,
}: {
  tenantId: string;
  libraryVersion: string;
  estates: Array<{ id: string; name: string }>;
}) {
  const hydrated = useSyncExternalStore(subscribeHydration, hydratedSnapshot, serverSnapshot);
  const [title, setTitle] = useState('');
  const [estateId, setEstateId] = useState('');
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [message, setMessage] = useState('');
  const [createdId, setCreatedId] = useState<string | null>(null);
  const inFlight = useRef(false);
  const attempt = useRef<Attempt | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    const name = title.trim();
    if (!uncertain && (name.length < 3 || name.length > 200)) {
      setMessage('Enter an assessment title between 3 and 200 characters.');
      return;
    }
    const current =
      uncertain && attempt.current
        ? attempt.current
        : { requestKey: crypto.randomUUID(), title: name, estateId };
    attempt.current = current;
    inFlight.current = true;
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch('/api/bff/v1/engagements', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-Id': tenantId,
          'Idempotency-Key': current.requestKey,
        },
        body: JSON.stringify({
          title: current.title,
          libraryVersion,
          ...(current.estateId ? { estateId: current.estateId } : {}),
          requestKey: current.requestKey,
        }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (response.ok) {
        const created = createdSchema.safeParse(body);
        if (!created.success) throw new Error('unconfirmed_response');
        setUncertain(false);
        setCreatedId(created.data.id);
        setMessage('Assessment created. Open its saved record to continue.');
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
      setUncertain(false);
      attempt.current = null;
      setMessage(
        parsed.success
          ? parsed.data.error.message
          : 'The assessment was not created. Review the details and try again.',
      );
    } catch {
      // A timeout, transport failure or server error may follow a committed
      // insert. Keep the exact intent and UUID for a replay-safe retry.
      setUncertain(true);
      setMessage(
        'The creation outcome is unconfirmed. Retry the same request to check its result.',
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
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
        disabled={busy || uncertain || Boolean(createdId)}
        className="grid gap-3 sm:grid-cols-2"
      >
        <label className="text-sm font-medium text-slate-700">
          Assessment title
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
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
            onChange={(event) => setEstateId(event.target.value)}
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
        disabled={!hydrated || busy || Boolean(createdId)}
        className="rounded-md bg-[#0FB5A5] px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
      >
        {busy ? 'Checking assessment…' : uncertain ? 'Retry same request' : 'Create assessment'}
      </button>
    </form>
  );
}
