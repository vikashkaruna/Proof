'use client';

import Link from 'next/link';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from 'react';
import { z } from 'zod';
import { publicFormMetadataSchema } from '@axiom/types';
import { generateUUID } from '@axiom/ui';
import {
  loadContextualCapture,
  retainContextualCapture,
  clearContextualCapture,
  type ContextualCaptureJournal,
} from './contextual-capture-journal';
import { PublicFormFacts } from './public-form-facts';

const checkSchema = z
  .object({
    id: z.uuid(),
    requestedUrl: z.string(),
    finalUrl: z.string(),
    checkedAt: z.string(),
    status: z.string().min(1).max(40),
    bytes: z.number().int().nonnegative(),
    contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
    formMetadata: publicFormMetadataSchema.optional(),
    title: z.string().nullable(),
    headings: z.array(z.string()),
    publicLinks: z.array(z.object({ label: z.string(), url: z.string() })),
    auditPages: z
      .array(
        z
          .object({
            kind: z.enum(['privacy', 'contact', 'terms']),
            requestedUrl: z.string(),
            status: z.enum(['checked', 'unavailable']),
            finalUrl: z.string().optional(),
            title: z.string().optional(),
            contentSha256: z.string().optional(),
            errorCode: z.string().optional(),
            formMetadata: publicFormMetadataSchema.optional(),
          })
          .refine(
            (page) =>
              !page.formMetadata ||
              (page.status === 'checked' && page.formMetadata.sourceSha256 === page.contentSha256),
          ),
      )
      .optional(),
    observations: z
      .array(
        z.object({
          kind: z.enum(['privacy', 'contact', 'terms']),
          status: z.enum(['retrieved', 'not_linked', 'unavailable']),
        }),
      )
      .optional(),
  })
  .refine(
    (check) =>
      !check.formMetadata ||
      (check.status === 'checked' && check.formMetadata.sourceSha256 === check.contentSha256),
  );
type WebsiteCheck = z.infer<typeof checkSchema>;
const subscribeHydration = () => () => {};
const hydratedSnapshot = () => true;
const serverSnapshot = () => false;

function CheckResult({
  check,
  canOpenDiscovery,
}: {
  check: WebsiteCheck;
  canOpenDiscovery: boolean;
}) {
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
      {canOpenDiscovery && (
        <Link
          href={`/discovery?checkId=${check.id}`}
          className="inline-block font-medium text-teal-700 underline"
        >
          Review this saved website evidence
        </Link>
      )}
      <PublicFormFacts metadata={check.formMetadata} pageLabel="Starting page" />
      {check.observations && (
        <div>
          <h4 className="font-medium text-indigo-900">Public notice observations</h4>
          <ul className="list-inside list-disc">
            {check.observations.map((observation) => (
              <li key={observation.kind}>
                <span className="capitalize">{observation.kind}</span>:{' '}
                {observation.status === 'retrieved'
                  ? 'retrieved from this site'
                  : observation.status === 'not_linked'
                    ? 'no eligible same-site link found on the starting page'
                    : 'linked page could not be retrieved'}
              </li>
            ))}
          </ul>
        </div>
      )}
      {check.auditPages && check.auditPages.length > 0 && (
        <div>
          <h4 className="font-medium text-indigo-900">Linked pages checked</h4>
          <ul className="space-y-2">
            {check.auditPages.map((page) => (
              <li
                key={`${page.kind}:${page.requestedUrl}`}
                className="break-all rounded-md border border-slate-200 bg-white p-2"
              >
                <span className="font-medium capitalize text-indigo-900">{page.kind}</span> ·{' '}
                {page.status === 'checked' ? page.title || 'Untitled page' : 'Unavailable'}
                <span className="block text-slate-700">{page.finalUrl ?? page.requestedUrl}</span>
                {page.contentSha256 && (
                  <span className="block text-xs text-slate-600">
                    SHA-256: <code>{page.contentSha256}</code>
                  </span>
                )}
                {page.errorCode && (
                  <span className="block text-xs text-amber-800">Reason: {page.errorCode}</span>
                )}
                <PublicFormFacts
                  metadata={page.formMetadata}
                  pageLabel={page.kind}
                  unavailable={page.status === 'unavailable'}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
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
        <h4 className="font-medium text-indigo-900">Relevant public links found</h4>
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
  non_public_target: 'That address does not resolve to a permitted public website.',
  dns_unavailable: 'The public website address could not be resolved. Try again later.',
  redirect_refused: 'The website redirected to an address that cannot be checked.',
  unreachable: 'The public website could not be retrieved. Check the address and try again.',
  http_status: 'The public website did not return a successful page response.',
  timeout: 'The website did not respond within the check time limit.',
  response_too_large: 'The page exceeds the check size limit.',
  unsupported_content_type: 'The URL did not return supported HTML content.',
  unsupported_content_encoding: 'The website returned an unsupported compressed response.',
  idempotency_in_progress: 'The previous check may still be running. Retry this same request.',
  idempotency_expired: 'The earlier request expired. Review recent checks before starting another.',
  rate_limited: 'Too many website checks. Wait before trying again.',
  rate_limit_unavailable: 'The check limit could not be verified. Try again later.',
  website_check_invalid_result: 'The retrieved result could not be validated. Try again later.',
};
const completedCheckErrors = new Set([
  'invalid_url',
  'non_public_target',
  'dns_unavailable',
  'redirect_refused',
  'unreachable',
  'http_status',
  'timeout',
  'response_too_large',
  'unsupported_content_type',
  'unsupported_content_encoding',
  'rate_limit_unavailable',
  'website_check_invalid_result',
  'idempotency_unavailable',
]);

/** Bounded public audit only. No browser-side target fetch or credential input. */
export function PublicWebsiteClient({
  tenantId,
  canManage,
  canOpenDiscovery = canManage,
  context,
  disabledReason,
  onRecorded,
  onOperationStateChange,
}: {
  tenantId: string;
  canManage: boolean;
  canOpenDiscovery?: boolean;
  context?: {
    id: string;
    actorId: string;
    url: string;
    engagementTitle: string;
    estateName: string | null;
  };
  disabledReason?: string;
  onRecorded?: (check: WebsiteCheck) => void;
  onOperationStateChange?: (blocked: boolean) => void;
}) {
  const hydrated = useSyncExternalStore(subscribeHydration, hydratedSnapshot, serverSnapshot);
  const [history, setHistory] = useState<{ tenantId: string; checks: WebsiteCheck[] }>({
    tenantId,
    checks: [],
  });
  const visibleHistory = history.tenantId === tenantId ? history.checks : [];
  const scopeIdentity = context ? `${context.actorId}/${context.id}` : null;
  const currentScope = useRef<string | null>(scopeIdentity);
  useLayoutEffect(() => {
    currentScope.current = scopeIdentity;
    return () => {
      currentScope.current = null;
    };
  }, [scopeIdentity]);
  const currentTenant = useRef<string | null>(tenantId);
  useLayoutEffect(() => {
    currentTenant.current = tenantId;
    return () => {
      currentTenant.current = null;
    };
  }, [tenantId]);
  const [loading, setLoading] = useState(true);
  const [historyError, setHistoryError] = useState(false);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [message, setMessage] = useState('');
  const [journalReady, setJournalReady] = useState(!context);
  const [journalError, setJournalError] = useState(false);
  const [retainedContext, setRetainedContext] = useState<ContextualCaptureJournal | null>(null);
  const [savedAwaitingCleanup, setSavedAwaitingCleanup] = useState<{
    check: WebsiteCheck;
    journal: ContextualCaptureJournal;
  } | null>(null);
  useEffect(() => {
    onOperationStateChange?.(busy || uncertain || journalError || Boolean(savedAwaitingCleanup));
  }, [busy, uncertain, journalError, savedAwaitingCleanup, onOperationStateChange]);
  const pending = useRef<{
    key: string;
    body: string;
    tenantId: string;
    method: 'POST';
    contextId: string | null;
    journal?: ContextualCaptureJournal;
    outcomeUnknown: boolean;
  } | null>(null);

  function restorePending(stored: ContextualCaptureJournal) {
    pending.current = {
      key: stored.key,
      body: stored.body,
      tenantId: stored.tenantId,
      method: 'POST',
      contextId: `${stored.actorId}/${stored.contextId}`,
      journal: stored,
      outcomeUnknown: true,
    };
    setRetainedContext(stored);
    setUncertain(true);
    setMessage(
      'A retained website capture may have been sent. Return to its original engagement and saved check, then retry this exact request.',
    );
  }
  useEffect(() => {
    if (!context) return;
    let disposed = false;
    void Promise.resolve().then(() => {
      if (disposed) return;
      try {
        const stored = loadContextualCapture(localStorage, tenantId, context.actorId);
        if (stored && !pending.current) {
          restorePending(stored);
        }
        setJournalReady(true);
      } catch {
        setJournalError(true);
        setMessage(
          'Website capture storage is unavailable or contains an invalid retained request. Preserve it and restore storage before continuing.',
        );
      }
    });
    return () => {
      disposed = true;
    };
  }, [tenantId, context]);

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
          setHistory({ tenantId, checks: records });
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
    if (
      !canManage ||
      busy ||
      journalError ||
      !journalReady ||
      savedAwaitingCleanup ||
      (!pending.current && disabledReason)
    )
      return;
    if (!pending.current) {
      try {
        const form = new FormData(event.currentTarget);
        pending.current = {
          key: generateUUID(),
          body: JSON.stringify({ url: context?.url ?? String(form.get('url') ?? '').trim() }),
          contextId: scopeIdentity,
          tenantId,
          method: 'POST',
          outcomeUnknown: false,
        };
        if (context) {
          const journal = {
            tenantId,
            actorId: context.actorId,
            contextId: context.id,
            key: pending.current.key,
            url: context.url,
            body: pending.current.body,
          };
          retainContextualCapture(localStorage, journal);
          pending.current.journal = journal;
          setRetainedContext(journal);
        }
      } catch {
        pending.current = null;
        if (context) setJournalError(true);
        // A preparation error precedes transport: no uncertain operation exists.
        setUncertain(false);
        setMessage(
          'The website check could not be prepared. Nothing was sent. Check the form and try again.',
        );
        return;
      }
    }
    const attempt = pending.current;
    const sameScope = () =>
      currentTenant.current === attempt.tenantId && currentScope.current === attempt.contextId;
    const scopeMessage = context
      ? 'Return to the original organisation, engagement and saved check to resolve this same request.'
      : 'Return to the original organisation to resolve and retry this same public website check.';
    if (!sameScope()) {
      setUncertain(true);
      setMessage(scopeMessage);
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch('/api/bff/v1/public-website-checks', {
        method: attempt.method,
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-Id': attempt.tenantId,
          'Idempotency-Key': attempt.key,
        },
        body: attempt.body,
      });
      const payload: unknown = await response.json();
      if (!response.ok) {
        const code = z.object({ error: z.object({ code: z.string() }) }).safeParse(payload);
        const name = code.success ? code.data.error.code : '';
        const outcomeUncertain =
          attempt.outcomeUnknown ||
          name === 'idempotency_in_progress' ||
          name === 'idempotency_outcome_unknown' ||
          name === 'website_check_record_unavailable' ||
          (response.status >= 500 && !completedCheckErrors.has(name));
        attempt.outcomeUnknown = outcomeUncertain;
        setUncertain(outcomeUncertain);
        if (!outcomeUncertain) {
          if (attempt.journal) {
            try {
              clearContextualCapture(localStorage, attempt.journal);
            } catch {
              setJournalError(true);
              setMessage(
                'This capture was refused, but its retained request could not be cleared. Preserve the journal and restore storage before continuing.',
              );
              return;
            }
          }
          pending.current = null;
          setRetainedContext(null);
        }
        if (!sameScope()) {
          setMessage(
            outcomeUncertain
              ? scopeMessage
              : 'The public check in the original organisation was refused. Return there to review it.',
          );
          return;
        }
        const detail =
          errorText[name] ??
          'The website check could not be completed. Review the URL and try again.';
        setMessage(
          outcomeUncertain ? `The result is uncertain. Retry the same request. ${detail}` : detail,
        );
        return;
      }
      const check = z.object({ data: checkSchema }).parse(payload).data;
      if (attempt.journal && new URL(check.requestedUrl).href !== new URL(attempt.journal.url).href)
        throw new Error('capture_response_scope_refused');
      pending.current = null;
      setUncertain(false);
      if (attempt.journal) {
        try {
          clearContextualCapture(localStorage, attempt.journal);
          const remaining = loadContextualCapture(
            localStorage,
            attempt.journal.tenantId,
            attempt.journal.actorId,
          );
          if (remaining) {
            restorePending(remaining);
            return;
          }
        } catch {
          setSavedAwaitingCleanup({ check, journal: attempt.journal });
          setMessage(
            'Website capture saved. Its request journal could not be cleared. Reconcile saved capture storage; do not submit a new capture.',
          );
          return;
        }
      }
      setRetainedContext(null);
      if (!sameScope()) {
        setMessage(
          'The public check in the original organisation completed. Return there to review it.',
        );
        return;
      }
      setHistory((existing) => ({
        tenantId: attempt.tenantId,
        checks: [
          check,
          ...(existing.tenantId === attempt.tenantId ? existing.checks : []).filter(
            (row) => row.id !== check.id,
          ),
        ].slice(0, 20),
      }));
      setHistoryError(false);
      setLoading(false);
      setMessage('Public website audit recorded.');
      try {
        onRecorded?.(check);
      } catch {
        setMessage('Public website audit recorded. Refresh saved checks to review it.');
      }
    } catch {
      attempt.outcomeUnknown = true;
      setUncertain(true);
      setMessage(
        sameScope()
          ? 'The check result is unknown. Retry the same request before starting another check.'
          : scopeMessage,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      id="public-website-check"
      aria-label="Public website content audit"
      className="space-y-4 rounded-lg border border-slate-200 bg-white p-5"
    >
      <div>
        <h2 className="text-lg font-semibold text-indigo-900">Public website content audit</h2>
        <p className="text-sm text-slate-700">
          Check a public HTML page and up to four same-site linked notice pages: privacy, contact,
          terms and an optional consent page for richer evidence review (five pages maximum). Record
          retrievable pages and links that are missing or unavailable. This is a limited
          public-content audit, not a full crawl or a legal compliance verdict.
        </p>
      </div>
      {context && (
        <p className="text-sm">
          Engagement: {context.engagementTitle}. Estate: {context.estateName ?? 'Unassigned'}.
          Previous saved check remains unchanged. No system or registered connector association is
          recorded. Keep this form open until this request is resolved.
        </p>
      )}
      {(retainedContext || savedAwaitingCleanup) && (
        <p className="text-sm" aria-label="Original retained capture context">
          Original context identifier:{' '}
          {(retainedContext ?? savedAwaitingCleanup?.journal)?.contextId}. Frozen public URL:{' '}
          {(retainedContext ?? savedAwaitingCleanup?.journal)?.url}. Return to these original
          selections to reconcile this request.
        </p>
      )}
      {disabledReason && <p role="status">{disabledReason}</p>}
      {savedAwaitingCleanup && (
        <button
          type="button"
          onClick={() => {
            try {
              clearContextualCapture(localStorage, savedAwaitingCleanup.journal, true);
              const saved = savedAwaitingCleanup;
              setSavedAwaitingCleanup(null);
              const remaining = loadContextualCapture(
                localStorage,
                saved.journal.tenantId,
                saved.journal.actorId,
              );
              if (remaining) {
                restorePending(remaining);
                return;
              }
              setRetainedContext(null);
              setMessage('Saved capture storage reconciled.');
              if (
                currentTenant.current === saved.journal.tenantId &&
                currentScope.current === `${saved.journal.actorId}/${saved.journal.contextId}`
              )
                onRecorded?.(saved.check);
            } catch {
              setMessage(
                'Saved capture storage could not be reconciled. Preserve the journal; no new request was sent.',
              );
            }
          }}
        >
          Reconcile saved capture storage
        </button>
      )}
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
            value={context?.url}
            readOnly={Boolean(context)}
            placeholder="https://example.com/privacy"
            disabled={busy || uncertain}
            className="block w-full rounded-md border border-slate-300 p-2 text-sm"
          />
          <button
            type="submit"
            disabled={
              !hydrated ||
              busy ||
              !journalReady ||
              journalError ||
              Boolean(savedAwaitingCleanup) ||
              Boolean(disabledReason && !uncertain)
            }
            className="rounded-md bg-teal-700 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-800 disabled:opacity-50"
          >
            {busy
              ? 'Auditing public website…'
              : uncertain
                ? 'Retry same check'
                : 'Audit public website'}
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
        {!loading && !historyError && visibleHistory.length === 0 && (
          <p className="text-sm text-slate-600">
            No public website checks recorded for this organization.
          </p>
        )}
        {!loading && !historyError && visibleHistory.length > 0 && (
          <ol className="space-y-2">
            {visibleHistory.map((check) => (
              <li key={check.id}>
                <CheckResult check={check} canOpenDiscovery={canOpenDiscovery} />
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
