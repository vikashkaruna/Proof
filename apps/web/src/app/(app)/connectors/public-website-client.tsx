'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { z } from 'zod';

const checkSchema = z.object({
  id: z.uuid(),
  requestedUrl: z.string(),
  finalUrl: z.string(),
  checkedAt: z.string(),
  status: z.string().min(1).max(40),
  bytes: z.number().int().nonnegative(),
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  title: z.string().nullable(),
  headings: z.array(z.string()),
  publicLinks: z.array(z.object({ label: z.string(), url: z.string() })),
});
type WebsiteCheck = z.infer<typeof checkSchema>;

function CheckResult({ check }: { check: WebsiteCheck }) {
  return (
    <article className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <strong className="text-indigo-900">{check.title || 'Untitled public page'}</strong>
        <span className="rounded-full bg-teal-50 px-2 py-0.5 text-teal-800">{check.status}</span>
      </div>
      <p className="break-all text-slate-700">{check.finalUrl}</p>
      <p className="text-slate-600">
        Fetched <time dateTime={check.checkedAt}>{check.checkedAt}</time> · {check.bytes} bytes
      </p>
      <div>
        <h4 className="font-medium text-indigo-900">Headings found</h4>
        {check.headings.length ? (
          <ul className="list-inside list-disc">
            {check.headings.map((heading, index) => (
              <li key={index}>{heading}</li>
            ))}
          </ul>
        ) : (
          <p>None found in the retrieved HTML.</p>
        )}
      </div>
      <div>
        <h4 className="font-medium text-indigo-900">Privacy and contact links found</h4>
        {check.publicLinks.length ? (
          <ul className="list-inside list-disc">
            {check.publicLinks.map((link, index) => (
              <li key={index} className="break-all">
                {link.label ? `${link.label}: ` : ''}
                {link.url}
              </li>
            ))}
          </ul>
        ) : (
          <p>No relevant public links found.</p>
        )}
      </div>
      <p className="break-all text-xs text-slate-600">
        Content SHA-256: <code>{check.contentSha256}</code>
      </p>
    </article>
  );
}

const errorText: Record<string, string> = {
  invalid_url: 'Enter a valid public HTTP or HTTPS URL.',
  url_refused: 'That URL is not an allowed public website address.',
  address_refused: 'That address does not resolve to a permitted public website.',
  redirect_refused: 'The website redirected to an address that cannot be checked.',
  fetch_failed: 'The public website could not be retrieved. Check the address and try again.',
  timeout: 'The website did not respond within the check time limit.',
  response_too_large: 'The page exceeds the check size limit.',
  unsupported_content_type: 'The URL did not return supported HTML content.',
};

/** Public-content inventory only. No browser-side target fetch or credential input. */
export function PublicWebsiteClient({
  tenantId,
  canManage,
}: {
  tenantId: string;
  canManage: boolean;
}) {
  const [history, setHistory] = useState<WebsiteCheck[]>([]);
  const [loading, setLoading] = useState(true);
  const [historyError, setHistoryError] = useState(false);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [message, setMessage] = useState('');
  const pending = useRef<{ key: string; body: string } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setLoading(true);
      try {
        const response = await fetch('/api/bff/v1/public-website-checks', {
          headers: { 'X-Tenant-Id': tenantId },
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('History unavailable');
        const payload: unknown = await response.json();
        const records = z.object({ data: checkSchema.array() }).parse(payload).data;
        if (!controller.signal.aborted) {
          setHistory(records);
          setHistoryError(false);
        }
      } catch {
        if (!controller.signal.aborted) setHistoryError(true);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [tenantId, historyRevision]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (!pending.current) {
      const form = new FormData(event.currentTarget);
      pending.current = {
        key: crypto.randomUUID(),
        body: JSON.stringify({ url: String(form.get('url') ?? '').trim() }),
      };
    }
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch('/api/bff/v1/public-website-checks', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-Id': tenantId,
          'Idempotency-Key': pending.current.key,
        },
        body: pending.current.body,
      });
      const payload: unknown = await response.json();
      if (!response.ok) {
        const code = z.object({ error: z.object({ code: z.string() }) }).safeParse(payload);
        const name = code.success ? code.data.error.code : '';
        setUncertain(response.status >= 500);
        if (response.status < 500) pending.current = null;
        const detail =
          errorText[name] ??
          'The website check could not be completed. Review the URL and try again.';
        setMessage(
          response.status >= 500
            ? `The result is uncertain. Retry the same request. ${detail}`
            : detail,
        );
        return;
      }
      const check = z.object({ data: checkSchema }).parse(payload).data;
      pending.current = null;
      setUncertain(false);
      setHistory((existing) =>
        [check, ...existing.filter((row) => row.id !== check.id)].slice(0, 20),
      );
      setHistoryError(false);
      setLoading(false);
      setMessage('Public content retrieved and recorded.');
    } catch {
      setUncertain(true);
      setMessage(
        'The check result is unknown. Retry the same request before starting another check.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-label="Public website content check"
      className="space-y-4 rounded-lg border border-slate-200 bg-white p-5"
    >
      <div>
        <h2 className="text-lg font-semibold text-indigo-900">Public website content check</h2>
        <p className="text-sm text-slate-700">
          Fetch a publicly available HTML page and record its title, headings, relevant public links
          and content hash. This inventories static content; it does not crawl the whole site,
          verify privacy practices or certify compliance.
        </p>
      </div>
      {canManage ? (
        <form onSubmit={(event) => void submit(event)} className="space-y-3">
          <label htmlFor="public-website-url" className="block text-sm font-medium text-indigo-900">
            Public page URL
          </label>
          <input
            id="public-website-url"
            name="url"
            type="url"
            required
            placeholder="https://example.com/privacy"
            disabled={busy || uncertain}
            className="block w-full rounded-md border border-slate-300 p-2 text-sm"
          />
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-teal-700 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-800 disabled:opacity-50"
          >
            {busy
              ? 'Checking public content…'
              : uncertain
                ? 'Retry same check'
                : 'Check public content'}
          </button>
          <p className="text-xs text-slate-600">
            Only a server-side public-page fetch is performed. Do not enter private addresses,
            credentials or URLs containing tokens.
          </p>
          {message && (
            <p role={uncertain ? 'alert' : 'status'} className="text-sm">
              {message}
            </p>
          )}
        </form>
      ) : (
        <p className="text-sm text-slate-600">
          Owners and admins can run a public website check. Your role can review recorded checks.
        </p>
      )}
      <div className="space-y-2">
        <h3 className="font-semibold text-indigo-900">Recent checks</h3>
        {loading && <p role="status">Loading recent public website checks…</p>}
        {historyError && (
          <div>
            <p role="alert">Recent checks could not be loaded.</p>
            <button
              type="button"
              className="text-sm text-teal-700 underline"
              onClick={() => setHistoryRevision((value) => value + 1)}
            >
              Retry loading checks
            </button>
          </div>
        )}
        {!loading && !historyError && history.length === 0 && (
          <p className="text-sm text-slate-600">
            No public website checks recorded for this organization.
          </p>
        )}
        {!loading && !historyError && history.length > 0 && (
          <ol className="space-y-2">
            {history.map((check) => (
              <li key={check.id}>
                <CheckResult check={check} />
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
