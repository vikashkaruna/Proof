'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * W8.2 — breach operations, the real surface.
 *
 * The clocks on these cards are the database's own (dpb_notification_due_by,
 * written by record_breach from clock_timestamp()); the state machine only
 * moves through the BFF routes whose RPCs enforce the closed transition map;
 * and a notification is only "sent" when a second human has reviewed a draft
 * and a hand other than the drafter's records the dispatch. Refusals are
 * shown verbatim — the codes are the contract, not an embarrassment to hide.
 */

export interface BreachRow {
  id: string;
  title: string;
  description: string;
  severity: string;
  status: string;
  occurred_at: string | null;
  detected_at: string;
  dpb_notification_due_by: string;
  affected_count: number | null;
  data_categories: string[] | null;
  dpb_notified_at: string | null;
  principals_notified_at: string | null;
}

export interface NotificationRow {
  id: string;
  breach_id: string;
  kind: 'dpb' | 'affected_principal';
  status: 'draft' | 'reviewed' | 'sent' | 'superseded';
  language: 'en' | 'hi';
  subject: string;
  body: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  sent_by: string | null;
  sent_at: string | null;
  delivery_outcome: string | null;
  delivery_attempts: number;
  created_at: string;
}

const NEXT_STATUS: Record<string, string> = {
  detected: 'triaging',
  triaging: 'contained',
  contained: 'notifying_dpb',
  notifying_dpb: 'notifying_principals',
  notifying_principals: 'post_mortem',
  post_mortem: 'closed',
};

const SEVERITY_COLOR: Record<string, string> = {
  low: '#64748B',
  medium: '#C9A227',
  high: '#D9534F',
  critical: '#D9534F',
};

const KIND_LABEL: Record<string, string> = {
  dpb: 'DPB (§8(6))',
  affected_principal: 'Affected principals',
};

async function bridgePost(
  path: string,
  body: unknown,
): Promise<{ ok: boolean; code?: string; data?: Record<string, unknown> }> {
  const res = await fetch(`/api/bff/v1${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const payload = (await res.json().catch(() => ({}))) as {
    error?: { code?: string };
    data?: Record<string, unknown>;
  };
  if (!res.ok || payload.error) {
    return { ok: false, code: payload.error?.code ?? `http_${res.status}` };
  }
  return { ok: true, data: payload.data };
}

export function BreachWorkflowClient({
  breaches,
  notifications,
}: {
  breaches: BreachRow[];
  notifications: NotificationRow[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [intakeOpen, setIntakeOpen] = useState(false);
  const [draftFor, setDraftFor] = useState<string | null>(null);

  async function act(path: string, body: unknown) {
    setBusy(true);
    setError(null);
    const result = await bridgePost(path, body);
    setBusy(false);
    if (!result.ok) {
      setError(result.code ?? 'refused');
      return;
    }
    router.refresh();
  }

  async function intake(form: FormData) {
    const categories = String(form.get('dataCategories') ?? '')
      .split(',')
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    await act('/breaches', {
      title: String(form.get('title') ?? ''),
      description: String(form.get('description') ?? ''),
      severity: String(form.get('severity') ?? 'medium'),
      dataCategories: categories,
      affectedCount: form.get('affectedCount') ? Number(form.get('affectedCount')) : undefined,
    });
    setIntakeOpen(false);
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold" style={{ color: '#1E2A4A' }}>
            Breach operations
          </h1>
          <p className="text-sm text-slate-500">
            72-hour Data Protection Board clock starts when the incident is recorded — server-owned,
            never editable.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setIntakeOpen((v) => !v)}
          className="rounded-md px-4 py-2 text-sm font-medium text-white"
          style={{ backgroundColor: '#1E2A4A' }}
        >
          {intakeOpen ? 'Close' : 'Record incident'}
        </button>
      </div>

      {error ? (
        <div
          className="rounded-md border px-4 py-3 text-sm"
          style={{ borderColor: '#D9534F', color: '#D9534F' }}
          role="alert"
        >
          {error}
        </div>
      ) : null}

      {intakeOpen ? (
        <form className="space-y-3 rounded-lg border border-slate-200 bg-white p-4" action={intake}>
          <input
            name="title"
            required
            maxLength={300}
            placeholder="Incident title"
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          <textarea
            name="description"
            required
            maxLength={5000}
            rows={3}
            placeholder="What happened, in plain terms"
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          <div className="flex gap-3">
            <select
              name="severity"
              defaultValue="medium"
              className="rounded-md border border-slate-300 px-3 py-2 text-sm"
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
            <input
              name="dataCategories"
              placeholder="Data categories, comma separated"
              className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
            <input
              name="affectedCount"
              type="number"
              min={0}
              placeholder="Affected count"
              className="w-40 rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          <button
            type="submit"
            disabled={busy}
            className="rounded-md px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            style={{ backgroundColor: '#0FB5A5' }}
          >
            Record and start the 72-hour clock
          </button>
        </form>
      ) : null}

      {breaches.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
          No incidents recorded.
        </p>
      ) : null}

      {breaches.map((breach) => {
        const next = NEXT_STATUS[breach.status];
        const overdue =
          !breach.dpb_notified_at && new Date(breach.dpb_notification_due_by) < new Date();
        const mine = notifications.filter((n) => n.breach_id === breach.id);
        const live = mine.find((n) => n.status === 'draft' || n.status === 'reviewed');
        return (
          <section
            key={breach.id}
            className="space-y-4 rounded-lg border border-slate-200 bg-white p-5"
          >
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="text-lg font-semibold" style={{ color: '#1E2A4A' }}>
                {breach.title}
              </h2>
              <span
                className="rounded-full px-2 py-0.5 text-xs font-medium text-white"
                style={{ backgroundColor: SEVERITY_COLOR[breach.severity] ?? '#64748B' }}
              >
                {breach.severity}
              </span>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                {breach.status}
              </span>
              {overdue ? (
                <span
                  className="rounded-full px-2 py-0.5 text-xs font-semibold text-white"
                  style={{ backgroundColor: '#D9534F' }}
                >
                  DPB notification overdue
                </span>
              ) : null}
            </div>

            <p className="text-sm text-slate-600">{breach.description}</p>

            <dl className="grid grid-cols-2 gap-2 text-sm text-slate-600 sm:grid-cols-4">
              <div>
                <dt className="text-slate-400">Detected</dt>
                <dd>{new Date(breach.detected_at).toLocaleString()}</dd>
              </div>
              <div>
                <dt className="text-slate-400">DPB deadline</dt>
                <dd
                  className={overdue ? 'font-semibold' : ''}
                  style={overdue ? { color: '#D9534F' } : {}}
                >
                  {new Date(breach.dpb_notification_due_by).toLocaleString()}
                </dd>
              </div>
              <div>
                <dt className="text-slate-400">DPB notified</dt>
                <dd>
                  {breach.dpb_notified_at ? new Date(breach.dpb_notified_at).toLocaleString() : '—'}
                </dd>
              </div>
              <div>
                <dt className="text-slate-400">Principals notified</dt>
                <dd>
                  {breach.principals_notified_at
                    ? new Date(breach.principals_notified_at).toLocaleString()
                    : '—'}
                </dd>
              </div>
            </dl>

            {breach.affected_count != null || (breach.data_categories?.length ?? 0) > 0 ? (
              <p className="text-xs text-slate-500">
                {breach.affected_count != null
                  ? `${breach.affected_count} affected principals`
                  : null}
                {breach.affected_count != null && (breach.data_categories?.length ?? 0) > 0
                  ? ' · '
                  : null}
                {(breach.data_categories ?? []).join(', ')}
              </p>
            ) : null}

            {next ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => act(`/breaches/${breach.id}/advance`, { toStatus: next })}
                className="rounded-md px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                style={{ backgroundColor: '#0FB5A5' }}
              >
                Advance to {next}
              </button>
            ) : (
              <span className="text-xs text-slate-400">Closed — the record stands.</span>
            )}

            <div className="space-y-2 border-t border-slate-100 pt-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold" style={{ color: '#1E2A4A' }}>
                  Notifications
                </h3>
                {breach.status !== 'closed' ? (
                  <button
                    type="button"
                    onClick={() => setDraftFor(draftFor === breach.id ? null : breach.id)}
                    className="text-xs font-medium"
                    style={{ color: '#0FB5A5' }}
                  >
                    {draftFor === breach.id ? 'Cancel draft' : 'Draft a notification'}
                  </button>
                ) : null}
              </div>

              {draftFor === breach.id ? (
                <form
                  className="space-y-2 rounded-md bg-slate-50 p-3"
                  action={(form: FormData) =>
                    act(`/breaches/${breach.id}/notifications`, {
                      kind: String(form.get('kind') ?? 'dpb'),
                      language: String(form.get('language') ?? 'en'),
                      subject: String(form.get('subject') ?? ''),
                      body: String(form.get('body') ?? ''),
                    }).then(() => setDraftFor(null))
                  }
                >
                  <div className="flex gap-2">
                    <select
                      name="kind"
                      className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                    >
                      <option value="dpb">DPB</option>
                      <option value="affected_principal">Affected principals</option>
                    </select>
                    <select
                      name="language"
                      className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                    >
                      <option value="en">English</option>
                      <option value="hi">हिन्दी</option>
                    </select>
                    <input
                      name="subject"
                      required
                      maxLength={300}
                      placeholder="Subject"
                      className="flex-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                    />
                  </div>
                  <textarea
                    name="body"
                    required
                    maxLength={20000}
                    rows={4}
                    placeholder="Notification body"
                    className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                  />
                  <button
                    type="submit"
                    disabled={busy}
                    className="rounded-md px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                    style={{ backgroundColor: '#1E2A4A' }}
                  >
                    Save draft
                  </button>
                </form>
              ) : null}

              {mine.length === 0 ? (
                <p className="text-xs text-slate-400">No notification drafts yet.</p>
              ) : null}
              {mine.map((n) => (
                <div key={n.id} className="rounded-md border border-slate-200 p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium" style={{ color: '#1E2A4A' }}>
                      {KIND_LABEL[n.kind] ?? n.kind}
                    </span>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs">
                      {n.status}
                    </span>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs">
                      {n.language === 'hi' ? 'हिन्दी' : 'English'}
                    </span>
                    {n.delivery_attempts > 0 ? (
                      <span className="text-xs text-slate-500">
                        {n.delivery_attempts} delivery attempt(s)
                        {n.delivery_outcome ? ` · last ${n.delivery_outcome}` : ''}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-slate-700">{n.subject}</p>
                  {n.status === 'reviewed' ? (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <span className="text-xs text-slate-500">
                        Reviewed — record your own-channel dispatch:
                      </span>
                      {(['delivered', 'failed', 'deferred'] as const).map((outcome) => (
                        <button
                          key={outcome}
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            act(`/breach-notifications/${n.id}/send`, {
                              outcome,
                              detail: {},
                            })
                          }
                          className="rounded border px-2 py-1 text-xs font-medium disabled:opacity-50"
                          style={{
                            borderColor: outcome === 'delivered' ? '#0FB5A5' : '#94A3B8',
                            color: outcome === 'delivered' ? '#0FB5A5' : '#475569',
                          }}
                        >
                          {outcome}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {n.status === 'draft' ? (
                    <div className="mt-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => act(`/breach-notifications/${n.id}/review`, {})}
                        className="rounded border px-2 py-1 text-xs font-medium disabled:opacity-50"
                        style={{ borderColor: '#0FB5A5', color: '#0FB5A5' }}
                      >
                        Approve this draft (second-person review)
                      </button>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
