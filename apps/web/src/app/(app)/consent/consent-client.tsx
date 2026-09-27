'use client';

import {
  cloneElement,
  useId,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import {
  consentRequest,
  grantBody,
  listSchema,
  purposeSchema,
  recordSchema,
  withdrawalSchema,
  versionSchema,
  type Purpose,
  type ConsentRecord,
  type Withdrawal,
  type NoticeVersion,
} from './consent-workflow';

const field = 'mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm';
const button =
  'rounded-md bg-[#1E2A4A] px-3 py-2 text-sm font-medium text-white disabled:opacity-50';
const panel = 'space-y-4 rounded-xl border border-slate-200 bg-white p-5';
function Field({ label, children }: { label: string; children: ReactElement<{ id?: string }> }) {
  const id = useId();
  return (
    <div className="block text-sm font-medium">
      <label htmlFor={id}>{label}</label>
      {cloneElement(children, { id })}
    </div>
  );
}
const value = (form: FormData, key: string) => String(form.get(key) ?? '').trim();

export function ConsentClient({ tenantId, canManage }: { tenantId: string; canManage: boolean }) {
  const [snapshot, setSnapshot] = useState<{
    purposes: Purpose[];
    records: ConsentRecord[];
    withdrawals: Withdrawal[];
    capped: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<'register' | 'grant' | string | null>(null);
  const [selectedPurpose, setSelectedPurpose] = useState('');
  const [language, setLanguage] = useState<'en' | 'hi'>('en');
  const [history, setHistory] = useState<{
    id: string;
    rows: NoticeVersion[];
    capped: boolean;
  } | null>(null);
  const lock = useRef(false);
  const attempts = useRef(new Map<string, string>());
  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const results = await Promise.all([
          consentRequest(tenantId, '/purposes', undefined, undefined, signal),
          consentRequest(tenantId, '/records', undefined, undefined, signal),
          consentRequest(tenantId, '/withdrawals', undefined, undefined, signal),
        ]);
        const purposes = listSchema(purposeSchema).parse(results[0]);
        const records = listSchema(recordSchema).parse(results[1]);
        const withdrawals = listSchema(withdrawalSchema).parse(results[2]);
        if (!signal?.aborted) {
          setSnapshot({
            purposes: purposes.data,
            records: records.data,
            withdrawals: withdrawals.data,
            capped: purposes.meta.hasMore || records.meta.hasMore || withdrawals.meta.hasMore,
          });
          setError(null);
        }
      } catch {
        if (!signal?.aborted) {
          setSnapshot(null);
          setError('Consent records could not be loaded. Refresh to retry.');
        }
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [tenantId],
  );
  useEffect(() => {
    const controller = new AbortController();
    // load changes state only after awaiting the BFF; initial loading is already true.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- asynchronous external data subscription
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function submit(path: string, build: () => unknown) {
    if (!canManage || lock.current || loading) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const body = build();
      const fingerprint = JSON.stringify([path, body]);
      const key = attempts.current.get(fingerprint) ?? crypto.randomUUID();
      attempts.current.set(fingerprint, key);
      await consentRequest(tenantId, path, body, key);
      attempts.current.delete(fingerprint);
      setEditor(null);
      setHistory(null);
      setMessage('Action recorded. Saved records have been requested again.');
      setLoading(true);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The action could not be submitted.');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function showHistory(id: string) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    setHistory(null);
    try {
      const result = listSchema(versionSchema).parse(
        await consentRequest(tenantId, `/purposes/${id}/versions`),
      );
      setHistory({ id, rows: result.data, capped: result.meta.hasMore });
    } catch {
      setError('Notice history could not be loaded.');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const disabled = loading || busy;
  const purpose = snapshot?.purposes.find((p) => p.id === selectedPurpose);
  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-[#1E2A4A]">Consent register</h1>
          <p className="text-sm text-slate-600">
            Reviewed notices, recorded consent and withdrawal follow-up for this tenant.
          </p>
        </div>
        <button
          className={button}
          disabled={disabled}
          onClick={() => {
            setHistory(null);
            setLoading(true);
            void load();
          }}
        >
          Refresh records
        </button>
      </header>
      {error && (
        <p role="alert" className="rounded-md border border-red-300 bg-red-50 p-3 text-red-800">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="rounded-md border border-teal-200 p-3">
          {message}
        </p>
      )}
      {loading && <p role="status">Loading consent records…</p>}
      {!canManage && <p>Read-only access. A tenant administrator manages consent records.</p>}
      {snapshot && (
        <>
          {snapshot.capped && (
            <p role="status">
              This bounded view shows at most 200 rows per list; it is not a tenant-wide total.
            </p>
          )}
          <section className={panel}>
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">Purposes and notices</h2>
              {canManage && (
                <button
                  className={button}
                  disabled={disabled}
                  onClick={() => setEditor(editor === 'register' ? null : 'register')}
                >
                  Register purpose
                </button>
              )}
            </div>
            {canManage && editor === 'register' && (
              <form
                className="space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  const form = new FormData(e.currentTarget);
                  void submit('/purposes', () => ({
                    purposeKey: value(form, 'purposeKey'),
                    nameEn: value(form, 'nameEn'),
                    nameHi: value(form, 'nameHi'),
                    lawfulBasis: value(form, 'lawfulBasis'),
                    noticeEn: value(form, 'noticeEn'),
                    noticeHi: value(form, 'noticeHi'),
                    reviewed: form.get('reviewed') === 'on',
                  }));
                }}
              >
                <fieldset disabled={disabled} className="space-y-3">
                  <Field label="Purpose key">
                    <input
                      className={field}
                      name="purposeKey"
                      required
                      pattern={'[a-z0-9_.\\-]{1,64}'}
                      maxLength={64}
                    />
                  </Field>
                  <Field label="English purpose name">
                    <input className={field} name="nameEn" required maxLength={160} />
                  </Field>
                  <Field label="Hindi purpose name">
                    <input className={field} name="nameHi" required maxLength={160} lang="hi" />
                  </Field>
                  <Field label="Lawful basis">
                    <select className={field} name="lawfulBasis">
                      <option value="consent">Consent</option>
                      <option value="legitimate_uses">Legitimate uses (catalog only)</option>
                    </select>
                  </Field>
                  <NoticeFields />
                  <button className={button} type="submit">
                    Save reviewed purpose
                  </button>
                </fieldset>
              </form>
            )}
            {snapshot.purposes.length === 0 && <p>No purposes recorded.</p>}
            {snapshot.purposes.map((p) => (
              <article key={p.id} className="space-y-3 border-t border-slate-200 pt-4">
                <h3 className="font-semibold">
                  {p.name_en} <span lang="hi">{p.name_hi}</span>
                </h3>
                <p className="text-sm">
                  {p.purpose_key} · Version {p.notice_version} ·{' '}
                  {p.is_active ? 'Active' : 'Inactive'} ·{' '}
                  {p.lawful_basis === 'consent'
                    ? 'Consent'
                    : 'Legitimate uses — consent capture unavailable'}
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    className={button}
                    disabled={disabled}
                    onClick={() => void showHistory(p.id)}
                  >
                    View notice history
                  </button>
                  {canManage && (
                    <>
                      <button
                        className={button}
                        disabled={disabled}
                        onClick={() => setEditor(editor === p.id ? null : p.id)}
                      >
                        Publish notice
                      </button>
                      <button
                        className={button}
                        disabled={disabled}
                        onClick={() =>
                          void submit(`/purposes/${p.id}/status`, () => ({ active: !p.is_active }))
                        }
                      >
                        {p.is_active ? 'Deactivate purpose' : 'Activate purpose'}
                      </button>
                    </>
                  )}
                </div>
                {canManage && editor === p.id && (
                  <form
                    className="space-y-3"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const form = new FormData(e.currentTarget);
                      void submit(`/purposes/${p.id}/versions`, () => ({
                        expectedNoticeVersion: p.notice_version,
                        noticeEn: value(form, 'noticeEn'),
                        noticeHi: value(form, 'noticeHi'),
                        reviewed: form.get('reviewed') === 'on',
                      }));
                    }}
                  >
                    <fieldset disabled={disabled} className="space-y-3">
                      <NoticeFields purpose={p} />
                      <button type="submit" className={button}>
                        Publish reviewed version
                      </button>
                    </fieldset>
                  </form>
                )}
                {history?.id === p.id && (
                  <div className="space-y-3">
                    {history.capped && <p>Showing the latest 200 notice versions.</p>}
                    {history.rows.length === 0 && (
                      <p>No retained notice snapshots are available.</p>
                    )}
                    {history.rows.map((v) => (
                      <details key={v.notice_version}>
                        <summary>
                          Version {v.notice_version} ·{' '}
                          {v.provenance === 'legacy_current'
                            ? 'Legacy current snapshot — original capture text unproven'
                            : 'Published reviewed snapshot'}
                        </summary>
                        <p className="whitespace-pre-wrap">{v.notice_en}</p>
                        <p lang="hi" className="whitespace-pre-wrap">
                          {v.notice_hi ?? 'Hindi notice unavailable'}
                        </p>
                        <p className="break-all text-xs">Snapshot SHA-256: {v.snapshot_sha256}</p>
                      </details>
                    ))}
                  </div>
                )}
              </article>
            ))}
          </section>
          <section className={panel}>
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">Consent records</h2>
              {canManage && (
                <button
                  className={button}
                  disabled={disabled}
                  onClick={() => setEditor(editor === 'grant' ? null : 'grant')}
                >
                  Record consent
                </button>
              )}
            </div>
            {canManage && editor === 'grant' && (
              <form
                className="space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  const form = new FormData(e.currentTarget);
                  void submit('/records', () => grantBody(form, purpose, language));
                }}
              >
                <fieldset disabled={disabled} className="space-y-3">
                  <Field label="Consent purpose">
                    <select
                      className={field}
                      value={selectedPurpose}
                      required
                      onChange={(e) => setSelectedPurpose(e.target.value)}
                    >
                      <option value="">Select purpose</option>
                      {snapshot.purposes
                        .filter((p) => p.is_active && p.lawful_basis === 'consent')
                        .map((p) => (
                          <option value={p.id} key={p.id}>
                            {p.name_en}
                          </option>
                        ))}
                    </select>
                  </Field>
                  <Field label="Notice language">
                    <select
                      className={field}
                      value={language}
                      onChange={(e) => setLanguage(e.target.value === 'hi' ? 'hi' : 'en')}
                    >
                      <option value="en">English</option>
                      <option value="hi">Hindi</option>
                    </select>
                  </Field>
                  {purpose && (
                    <div className="rounded-md bg-slate-50 p-3">
                      <p>Notice version {purpose.notice_version}</p>
                      <p lang={language} className="whitespace-pre-wrap">
                        {(language === 'hi' ? purpose.notice_hi : purpose.notice_en) ||
                          'No reviewed notice is available in this language.'}
                      </p>
                    </div>
                  )}
                  <Field label="Principal identifier type">
                    <select name="principalType" className={field}>
                      {['email', 'phone', 'cookie_id', 'user_id'].map((t) => (
                        <option key={t}>{t}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Principal identifier">
                    <input
                      name="principalRef"
                      className={field}
                      required
                      minLength={3}
                      maxLength={320}
                    />
                  </Field>
                  <Field label="Capture channel">
                    <select name="channel" className={field}>
                      {['form', 'cookie', 'api', 'offline'].map((t) => (
                        <option key={t}>{t}</option>
                      ))}
                    </select>
                  </Field>
                  <label className="flex gap-2">
                    <input
                      key={`${purpose?.id ?? 'none'}:${purpose?.notice_version ?? 0}:${language}`}
                      type="checkbox"
                      name="confirmed"
                      required
                    />
                    I confirm the principal received this notice version in the selected language
                    and gave consent.
                  </label>
                  <button className={button} type="submit">
                    Save consent record
                  </button>
                </fieldset>
              </form>
            )}
            {snapshot.records.length === 0 && <p>No consent records found.</p>}
            {snapshot.records.map((r) => (
              <article className="space-y-2 border-t pt-3" key={r.id}>
                <h3 className="font-medium break-all">{r.principal_ref}</h3>
                <ConsentRecordProof record={r} />
                <p className="text-sm">
                  {snapshot.purposes.find((p) => p.id === r.purpose_id)?.name_en ?? r.purpose_id} ·{' '}
                  Recorded status: {r.status} · Notice {r.notice_version} ({r.language}) ·{' '}
                  {r.legal_hold ? 'Legal hold active' : 'No legal hold'}
                </p>
                {canManage && (
                  <div className="flex flex-wrap gap-2">
                    {r.status === 'granted' && (
                      <button
                        className={button}
                        disabled={disabled}
                        onClick={() => setEditor(`withdraw:${r.id}`)}
                      >
                        Withdraw consent
                      </button>
                    )}
                    <button
                      className={button}
                      disabled={disabled}
                      onClick={() =>
                        void submit(`/records/${r.id}/legal-hold`, () => ({ hold: !r.legal_hold }))
                      }
                    >
                      {r.legal_hold ? 'Release legal hold' : 'Place legal hold'}
                    </button>
                  </div>
                )}
                {canManage && editor === `withdraw:${r.id}` && (
                  <form
                    className="space-y-3"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const form = new FormData(e.currentTarget);
                      void submit(`/records/${r.id}/withdraw`, () => ({
                        language: value(form, 'language'),
                        reason: value(form, 'reason') || null,
                      }));
                    }}
                  >
                    <fieldset disabled={disabled} className="space-y-3">
                      <Field label="Withdrawal language">
                        <select name="language" className={field} defaultValue={r.language}>
                          <option value="en">English</option>
                          <option value="hi">Hindi</option>
                        </select>
                      </Field>
                      <Field label="Withdrawal reason (optional)">
                        <textarea className={field} name="reason" maxLength={500} />
                      </Field>
                      <label className="flex gap-2">
                        <input type="checkbox" required />I confirm the principal requested this
                        withdrawal.
                      </label>
                      <button className={button} type="submit">
                        Confirm withdrawal
                      </button>
                    </fieldset>
                  </form>
                )}
              </article>
            ))}
          </section>
          <section className={panel}>
            <h2 className="text-lg font-semibold">Withdrawal follow-up</h2>
            <p className="text-sm text-slate-600">
              Completion records a human confirmation of downstream work. It does not run a
              connector or prove deletion, delivery or locked storage.
            </p>
            {snapshot.withdrawals.length === 0 && <p>No withdrawals recorded.</p>}
            {snapshot.withdrawals.map((w) => (
              <article key={w.id} className="space-y-3 border-t pt-3">
                <h3 className="font-medium break-all">{w.principal_ref}</h3>
                <p>
                  {w.downstream_completed_at
                    ? 'Downstream completion confirmed'
                    : 'Awaiting downstream confirmation'}
                </p>
                {canManage && !w.downstream_completed_at && (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void submit(`/withdrawals/${w.id}/complete`, () => ({}));
                    }}
                  >
                    <fieldset disabled={disabled} className="space-y-3">
                      <label className="flex gap-2">
                        <input type="checkbox" required />I have checked downstream processing has
                        stopped where this withdrawal applies.
                      </label>
                      <button type="submit" className={button}>
                        Confirm downstream completion
                      </button>
                    </fieldset>
                  </form>
                )}
              </article>
            ))}
          </section>
        </>
      )}
    </div>
  );
}

function NoticeFields({ purpose }: { purpose?: Purpose }) {
  return (
    <>
      <Field label="English notice">
        <textarea
          name="noticeEn"
          required
          maxLength={20000}
          rows={4}
          className={field}
          defaultValue={purpose?.notice_en}
        />
      </Field>
      <Field label="Hindi notice">
        <textarea
          name="noticeHi"
          lang="hi"
          required
          maxLength={20000}
          rows={4}
          className={field}
          defaultValue={purpose?.notice_hi ?? ''}
        />
      </Field>
      <label className="flex gap-2">
        <input type="checkbox" name="reviewed" required />I reviewed and approve both notice texts
        for publication.
      </label>
    </>
  );
}

/** A capture hash is evidence of the exact notice snapshot, not a WORM seal. */
export function ConsentRecordProof({ record }: { record: ConsentRecord }) {
  return (
    <div className="space-y-1 text-xs text-slate-600">
      <p className="break-all">Record ID: {record.id}</p>
      <p>
        Captured at <time dateTime={record.granted_at}>{record.granted_at}</time> · Channel:{' '}
        {record.channel}
      </p>
      <p className="break-all">Recorded by: {record.granted_by}</p>
      {record.expires_at ? (
        <p>
          Expires at <time dateTime={record.expires_at}>{record.expires_at}</time>. Do not rely on
          this grant after that time; its recorded status does not change automatically at expiry.
        </p>
      ) : (
        <p>
          No expiry recorded. A recorded grant alone does not establish current consent validity.
        </p>
      )}
      {record.notice_snapshot_sha256 ? (
        <p className="break-all">Notice snapshot SHA-256: {record.notice_snapshot_sha256}</p>
      ) : (
        <p>Legacy record: exact notice snapshot at capture is unproven.</p>
      )}
    </div>
  );
}
