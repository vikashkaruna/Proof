'use client';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { generateUUID } from '@axiom/ui';
import { canonicalJson } from '@axiom/ledger';
import {
  encodePublicWebsiteAssetRequest,
  parsePublicWebsiteAssetRequestText,
  parsePublicWebsiteAssetSnapshotText,
  publicWebsiteAssetInventorySchema,
  publicWebsiteAssetTargetRowSchema,
  publicWebsiteAssetCaptureRowSchema,
  publicWebsiteAssetAssociationRowSchema,
  type PublicWebsiteAssetAssociationRow,
  type PublicWebsiteAssetSelection,
  type PublicWebsiteAssetSelectionPage,
  type PublicWebsiteAssetInventory,
  type PublicWebsiteAssetTargetRow,
  type PublicWebsiteAssetCaptureRow,
  type PublicWebsiteAssetResolution,
} from '@axiom/types';
import {
  readWebsiteAssetIntents,
  retainWebsiteAssetIntent,
  retainWebsiteAssetCancellation,
  clearConfirmedWebsiteAssetIntent,
  type WebsiteAssetIntent,
  type WebsiteAssetCancellationIntent,
} from './public-website-asset-journal';
import {
  sendWebsiteAssetIntent,
  readWebsiteAssetIntent,
  cancelWebsiteAssetIntent,
  validateWebsiteAssetResolution,
  readWebsiteAssetSelection,
} from './public-website-asset-client';
type Entry = ReturnType<typeof readWebsiteAssetIntents>[number];
type Positive = Exclude<PublicWebsiteAssetResolution, { state: 'not_found' }>;
export interface WebsiteAssetConsoleProps {
  tenantId: string;
  actorId: string;
  canManage: boolean;
  canOpenDiscovery?: boolean;
  inventory: PublicWebsiteAssetInventory;
  targets: PublicWebsiteAssetTargetRow[];
  captures: PublicWebsiteAssetCaptureRow[];
  associations?: PublicWebsiteAssetAssociationRow[];
  selectionTransport?: typeof readWebsiteAssetSelection;
  onConfirmed?: (result: Positive) => void;
  transport?: {
    send: typeof sendWebsiteAssetIntent;
    read: typeof readWebsiteAssetIntent;
    cancel: typeof cancelWebsiteAssetIntent;
  };
}
function PendingCard({
  entry,
  active,
  busy,
  canManage,
  onRead,
  onRetry,
  onCancel,
}: {
  entry: Entry;
  active: boolean;
  busy: boolean;
  canManage: boolean;
  onRead: () => void;
  onRetry: () => void;
  onCancel: (reason: string) => void;
}) {
  const [retry, setRetry] = useState(false),
    [reason, setReason] = useState(''),
    [confirmCancel, setConfirmCancel] = useState(false);
  const request = parsePublicWebsiteAssetRequestText(entry.intent.requestText),
    savedReason = entry.cancellation?.reason;
  return (
    <article
      className="space-y-2 rounded border p-3"
      aria-label={`Retained website operation ${request.operationKey}`}
    >
      <h3 className="font-semibold">Retained {request.kind.replaceAll('_', ' ')} request</h3>
      <p>
        Organisation reference: {entry.intent.tenantId}. Operation: {request.operationKey}.
      </p>
      <pre className="overflow-x-auto whitespace-pre-wrap break-all text-xs">
        {entry.intent.requestText}
      </pre>
      <p>
        This exact request remains unconfirmed. A missing record or later refusal does not authorize
        a new request key.
      </p>
      {!active && <p>Return to the original organisation to reconcile this request.</p>}
      <button
        className="mb-2 mr-2 rounded-lg border border-slate-300 px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        type="button"
        disabled={!active || busy}
        onClick={onRead}
      >
        Check retained operation
      </button>
      {!entry.cancellation && (
        <>
          <label className="block">
            <input
              className="rounded border border-slate-300 focus-visible:outline focus-visible:outline-2 disabled:opacity-50"
              type="checkbox"
              checked={retry}
              onChange={(e) => setRetry(e.target.checked)}
              disabled={!active || !canManage || busy}
            />{' '}
            I reviewed this exact retained request and authorize its retry.
          </label>
          <button
            className="mb-2 mr-2 rounded-lg border border-slate-300 px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            type="button"
            disabled={!active || !canManage || busy || !retry}
            onClick={() => {
              setRetry(false);
              onRetry();
            }}
          >
            Retry exact retained request
          </button>
        </>
      )}
      <label className="block">
        Cancellation reason
        <input
          className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 disabled:opacity-50"
          value={savedReason ?? reason}
          maxLength={2000}
          disabled={Boolean(savedReason) || !active || !canManage || busy}
          onChange={(e) => {
            setReason(e.target.value);
            setConfirmCancel(false);
          }}
        />
      </label>
      {savedReason && (
        <p>
          The original cancellation reason is frozen. Its outcome remains unconfirmed until a
          positive receipt is read.
        </p>
      )}
      <label className="block">
        <input
          className="rounded border border-slate-300 focus-visible:outline focus-visible:outline-2 disabled:opacity-50"
          type="checkbox"
          checked={confirmCancel}
          disabled={!active || !canManage || busy}
          onChange={(e) => setConfirmCancel(e.target.checked)}
        />{' '}
        I confirm cancellation of this exact request with this reason.
      </label>
      <button
        className="mb-2 mr-2 rounded-lg border border-slate-300 px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        type="button"
        disabled={
          !active || !canManage || busy || !confirmCancel || !(savedReason ?? reason).trim()
        }
        onClick={() => {
          setConfirmCancel(false);
          onCancel(savedReason ?? reason);
        }}
      >
        {savedReason ? 'Retry exact cancellation' : 'Cancel retained intent'}
      </button>
      {!canManage && (
        <p>
          Your current role can check a retained result but cannot retry, cancel, register or
          associate website evidence.
        </p>
      )}
    </article>
  );
}
/** Retained website operations remain subject to server authority and provenance checks. */
function WebsiteAssetConsoleView(props: WebsiteAssetConsoleProps) {
  const { tenantId, actorId, canManage } = props,
    scope = tenantId.toLowerCase() + ':' + actorId.toLowerCase();
  const [estateId, setEstate] = useState(''),
    [systemId, setSystem] = useState(''),
    [url, setUrl] = useState(''),
    [mode, setMode] = useState<'register_target' | 'capture' | 'associate_capture' | 'withdraw'>(
      'register_target',
    ),
    [targetId, setTarget] = useState(''),
    [captureId, setCapture] = useState(''),
    [associationId, setAssociation] = useState(''),
    [withdrawSubject, setWithdrawSubject] = useState<'target' | 'association'>('target'),
    [reason, setReason] = useState(''),
    [confirmation, setConfirmation] = useState('');
  const [loaded, setLoaded] = useState<{ scope: string; entries: Entry[]; ready: boolean } | null>(
      null,
    ),
    [feedback, setFeedback] = useState<{ scope: string; text: string; known?: Positive } | null>(
      null,
    ),
    [busyScope, setBusyScope] = useState<string | null>(null);
  const [pages, setPages] = useState<
    Partial<
      Record<
        PublicWebsiteAssetSelection['kind'],
        { key: string; page?: PublicWebsiteAssetSelectionPage; loading: boolean; error: boolean }
      >
    >
  >({});
  const confirmed = useRef(new Map<string, Positive>());
  const active = useRef<{ scope: string; canManage: boolean } | null>(null),
    busy = useRef(new Set<string>()),
    observed = useRef(new Map<string, string>()),
    callback = useRef(props.onConfirmed);
  useLayoutEffect(() => {
    active.current = { scope, canManage };
    callback.current = props.onConfirmed;
    return () => {
      active.current = null;
    };
  }, [scope, canManage, props.onConfirmed]);
  const current = () => active.current?.scope === scope;
  const remember = useCallback((entries: Entry[]) => {
    for (const e of entries) {
      const request = parsePublicWebsiteAssetRequestText(e.intent.requestText),
        key = e.intent.actorId + ':' + e.intent.tenantId + ':' + request.operationKey,
        text = canonicalJson(e.intent),
        old = observed.current.get(key);
      if (old !== undefined && old !== text)
        throw Error(
          'Retained website intent changed. Preserve and reconcile its original context.',
        );
      observed.current.set(key, text);
    }
    return entries;
  }, []);
  useEffect(() => {
    let mounted = true;
    const load = () => {
      if (!mounted) return;
      try {
        setLoaded({
          scope,
          entries: remember(readWebsiteAssetIntents(localStorage, tenantId, actorId)),
          ready: true,
        });
      } catch {
        setLoaded({ scope, entries: [], ready: false });
        setFeedback({
          scope,
          text: 'Browser website request storage cannot be verified. Preserve retained requests and restore access before continuing.',
        });
      }
    };
    void Promise.resolve().then(load);
    window.addEventListener('storage', load);
    return () => {
      mounted = false;
      window.removeEventListener('storage', load);
    };
  }, [scope, tenantId, actorId, remember]);
  const options = useMemo(() => {
    try {
      const inventory = publicWebsiteAssetInventorySchema.parse(props.inventory),
        targetPage = pages.targets?.page,
        associationPage = pages.associations?.page,
        capturePage = pages.captures?.page,
        targetRows =
          targetPage?.kind === 'targets' &&
          targetPage.estateId === estateId &&
          targetPage.systemId === systemId
            ? targetPage.rows
            : props.targets,
        captureRows =
          capturePage?.kind === 'captures' && capturePage.targetId === targetId
            ? capturePage.rows
            : props.captures,
        associationRows =
          associationPage?.kind === 'associations' && associationPage.targetId === targetId
            ? associationPage.rows
            : (props.associations ?? []),
        targets = targetRows.map((row) => {
          const value = publicWebsiteAssetTargetRowSchema.parse(row),
            snapshot = parsePublicWebsiteAssetSnapshotText(value.snapshotText);
          if (
            snapshot.kind !== 'target' ||
            snapshot.id !== value.id ||
            snapshot.tenantId !== tenantId.toLowerCase()
          )
            throw Error();
          return { ...value, snapshot };
        }),
        captures = captureRows.map((row) => publicWebsiteAssetCaptureRowSchema.parse(row)),
        associations = associationRows.map((row) => {
          const value = publicWebsiteAssetAssociationRowSchema.parse(row),
            snapshot = parsePublicWebsiteAssetSnapshotText(value.snapshotText);
          if (
            snapshot.kind !== 'association' ||
            snapshot.id !== value.id ||
            snapshot.tenantId !== tenantId.toLowerCase() ||
            value.operation.snapshotText !== value.snapshotText ||
            value.operation.snapshotSha256 !== value.snapshotSha256
          )
            throw Error();
          validateWebsiteAssetResolution(
            { data: value.operation },
            {
              version: 1,
              tenantId: tenantId.toLowerCase(),
              actorId: value.operation.actorId,
              requestText: value.operation.requestText,
            },
          );
          return { ...value, snapshot };
        });
      if (
        inventory.estates.some((v) => v.tenantId !== tenantId.toLowerCase()) ||
        inventory.systems.some(
          (v) =>
            v.tenantId !== tenantId.toLowerCase() ||
            !inventory.estates.some((e) => e.id === v.estateId),
        ) ||
        captures.some((v) => v.tenantId !== tenantId.toLowerCase()) ||
        new Set(inventory.estates.map((v) => v.id)).size !== inventory.estates.length ||
        new Set(inventory.systems.map((v) => v.id)).size !== inventory.systems.length ||
        new Set(targets.map((v) => v.id)).size !== targets.length ||
        new Set(captures.map((v) => v.checkId)).size !== captures.length
      )
        throw Error();
      return { inventory, targets, captures, associations };
    } catch {
      return null;
    }
  }, [
    props.inventory,
    props.targets,
    props.captures,
    props.associations,
    tenantId,
    pages,
    estateId,
    systemId,
    targetId,
  ]);
  const entries = loaded?.scope === scope ? loaded.entries : [],
    ready = loaded?.scope === scope && loaded.ready,
    isBusy = busyScope === scope;
  const estate = options?.inventory.estates.find((v) => v.id === estateId),
    system = options?.inventory.systems.find((v) => v.id === systemId && v.estateId === estateId),
    target = options?.targets.find(
      (v) =>
        v.id === targetId && v.snapshot.estateId === estateId && v.snapshot.systemId === systemId,
    ),
    capture = options?.captures.find(
      (v) => v.checkId === captureId && v.requestedUrl === target?.snapshot.url,
    );
  const association = options?.associations.find(
    (a) => a.id === associationId && a.snapshot.targetId === targetId,
  );
  const token = canonicalJson({
    scope,
    mode,
    estateId,
    systemId,
    url,
    targetId,
    captureId,
    associationId,
    withdrawSubject,
    associationSha: association?.snapshotSha256 ?? null,
    reason,
    estateVersion: estate?.version ?? null,
    systemVersion: system?.version ?? null,
    targetSha: target?.snapshotSha256 ?? null,
    captureSha: capture?.payloadSha256 ?? null,
  });
  const reload = () =>
    setLoaded({
      scope,
      entries: remember(readWebsiteAssetIntents(localStorage, tenantId, actorId)),
      ready: true,
    });
  async function operate(entry: Entry, action: 'send' | 'read' | 'cancel', cancelReason?: string) {
    if (
      !current() ||
      busy.current.has(scope) ||
      entry.intent.tenantId !== tenantId.toLowerCase() ||
      entry.intent.actorId !== actorId.toLowerCase() ||
      (action !== 'read' && !active.current?.canManage)
    )
      return;
    busy.current.add(scope);
    setBusyScope(scope);
    const operationKey = parsePublicWebsiteAssetRequestText(entry.intent.requestText).operationKey;
    const priorKnown = confirmed.current.get(operationKey);
    setFeedback(
      priorKnown
        ? {
            scope,
            text: 'The exact operation already has a confirmed receipt. Checking browser cleanup.',
            known: priorKnown,
          }
        : null,
    );
    try {
      let result: PublicWebsiteAssetResolution;
      const ports = props.transport ?? {
        send: sendWebsiteAssetIntent,
        read: readWebsiteAssetIntent,
        cancel: cancelWebsiteAssetIntent,
      };
      let cancellation: WebsiteAssetCancellationIntent | null = entry.cancellation;
      if (action === 'cancel') {
        cancellation = retainWebsiteAssetCancellation(
          localStorage,
          entry.intent,
          cancelReason ?? '',
        );
        reload();
        result = await ports.cancel(localStorage, entry.intent, cancellation);
      } else if (action === 'read') result = await ports.read(entry.intent);
      else result = await ports.send(localStorage, entry.intent);
      result = validateWebsiteAssetResolution(
        { data: result },
        entry.intent,
        action === 'cancel' ? cancellation?.reason : undefined,
      );
      if (!current()) return;
      if (result.state === 'not_found') {
        if (priorKnown) {
          setFeedback({
            scope,
            text: 'The earlier positive receipt remains confirmed; a later missing read cannot reverse it. Preserve the retained entry for reconciliation.',
            known: priorKnown,
          });
          return;
        }
        setFeedback({
          scope,
          text: 'No positive receipt was found. The original operation remains retained and unconfirmed.',
        });
        return;
      }
      confirmed.current.set(operationKey, result);
      setFeedback({
        scope,
        text:
          result.state === 'cancelled'
            ? 'The exact retained intent has an authenticated cancellation receipt.'
            : 'The exact website operation is recorded. This does not verify ownership or grant connector access.',
        known: result,
      });
      try {
        clearConfirmedWebsiteAssetIntent(localStorage, entry.intent, cancellation);
        reload();
      } catch {
        setFeedback({
          scope,
          text: 'The outcome is confirmed, but this browser could not clear its exact retained entry. Reconcile it again; do not create another request.',
          known: result,
        });
      }
      try {
        callback.current?.(result);
      } catch {
        setFeedback({
          scope,
          text: 'The outcome is confirmed. Reload the saved inventory to see its latest records.',
          known: result,
        });
      }
    } catch {
      if (current())
        setFeedback({
          scope,
          text: priorKnown
            ? 'The earlier positive receipt remains confirmed. Browser reconciliation is still needed.'
            : 'The operation could not be confirmed. Preserve the original request and check its recorded outcome before continuing.',
          ...(priorKnown ? { known: priorKnown } : {}),
        });
    } finally {
      busy.current.delete(scope);
      if (current()) setBusyScope(null);
    }
  }
  function selection(
    kind: PublicWebsiteAssetSelection['kind'],
    after: string | null = null,
  ): PublicWebsiteAssetSelection | null {
    if (kind === 'targets')
      return estateId && systemId ? { kind, estateId, systemId, after } : null;
    return targetId ? { kind, targetId, after } : null;
  }
  async function loadSelection(kind: PublicWebsiteAssetSelection['kind'], next = false) {
    const base = selection(kind);
    if (!base || !current()) return;
    const key = canonicalJson({ ...base, after: null }),
      old = pages[kind];
    if (old?.loading) return;
    const query = {
      ...base,
      after: next && old?.key === key ? (old.page?.nextCursor ?? null) : null,
    };
    setPages((p) => ({
      ...p,
      [kind]: { key, page: old?.key === key ? old.page : undefined, loading: true, error: false },
    }));
    try {
      const page = await (props.selectionTransport ?? readWebsiteAssetSelection)(
        tenantId,
        actorId,
        query,
      );
      if (!current()) return;
      // The real client validates strict scope and byte custody; injected test ports
      // must not fabricate a page in a different selector context.
      if (
        page.kind !== base.kind ||
        page.tenantId !== tenantId.toLowerCase() ||
        page.actorId !== actorId.toLowerCase() ||
        (page.kind === 'targets' &&
          base.kind === 'targets' &&
          (page.estateId !== base.estateId || page.systemId !== base.systemId)) ||
        (page.kind !== 'targets' && base.kind !== 'targets' && page.targetId !== base.targetId)
      )
        throw Error();
      setPages((p) => ({ ...p, [kind]: { key, page, loading: false, error: false } }));
      setConfirmation('');
    } catch {
      if (current())
        setPages((p) => ({
          ...p,
          [kind]: {
            key,
            page: old?.key === key ? old.page : undefined,
            loading: false,
            error: true,
          },
        }));
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (
      !current() ||
      !active.current?.canManage ||
      !ready ||
      entries.length ||
      busy.current.has(scope) ||
      confirmation !== token ||
      !options
    )
      return;
    try {
      let value: Record<string, unknown>;
      if (mode === 'register_target') {
        if (!estate || !system || estate.status !== 'active' || system.status !== 'active')
          throw Error();
        value = {
          estateId: estate.id,
          systemId: system.id,
          expectedEstateVersion: estate.version,
          expectedSystemVersion: system.version,
          url,
        };
      } else {
        if (!target) throw Error();
        if (mode === 'withdraw')
          value = {
            subjectType: withdrawSubject,
            subjectId: withdrawSubject === 'association' ? association?.id : target.id,
            expectedSubjectSha256:
              withdrawSubject === 'association'
                ? association?.snapshotSha256
                : target.snapshotSha256,
            reason,
          };
        else {
          if (
            target.withdrawn ||
            !target.inventoryCurrent ||
            !estate ||
            !system ||
            estate.status !== 'active' ||
            system.status !== 'active' ||
            target.snapshot.estateVersion !== estate.version ||
            target.snapshot.systemVersion !== system.version
          )
            throw Error();
          value = { targetId: target.id, expectedTargetSha256: target.snapshotSha256 };
          if (mode === 'associate_capture') {
            if (!capture) throw Error();
            value = {
              ...value,
              checkId: capture.checkId,
              expectedPayloadSha256: capture.payloadSha256,
              expectedCaptureReceipt: capture.captureReceipt.id,
            };
          }
        }
      }
      const intent: WebsiteAssetIntent = {
        version: 1,
        tenantId: tenantId.toLowerCase(),
        actorId: actorId.toLowerCase(),
        requestText: encodePublicWebsiteAssetRequest({
          ...value,
          version: 1,
          kind: mode,
          operationKey: generateUUID(),
          confirmed: true,
        }),
      };
      retainWebsiteAssetIntent(localStorage, intent);
      reload();
      setConfirmation('');
      void operate({ intent, cancellation: null }, 'send');
    } catch {
      setFeedback({
        scope,
        text: 'Request not sent. Check the selected estate, system, reference and confirmation; secure browser randomness and durable storage must be available.',
      });
    }
  }
  if (!options)
    return (
      <section aria-label="Registered public website targets">
        <p role="alert">
          Website asset context could not be verified. Reload the saved inventory before continuing.
        </p>
      </section>
    );
  return (
    <section
      aria-label="Registered public website targets"
      className="space-y-4 rounded border p-4"
    >
      <h3 className="font-semibold">Registered website operations</h3>
      <p>
        A public URL is a human-declared reference. It does not verify domain ownership, activate a
        private connector or authorize agent writes.
      </p>
      {!canManage && (
        <p>
          Only a current founder, owner or admin can register, capture, associate or withdraw these
          references.
        </p>
      )}
      {feedback?.scope === scope && (
        <p role={feedback.known ? 'status' : 'alert'}>{feedback.text}</p>
      )}
      {feedback?.scope === scope &&
        feedback.known?.state === 'recorded' &&
        props.canOpenDiscovery &&
        (() => {
          const snapshot = parsePublicWebsiteAssetSnapshotText(feedback.known.snapshotText);
          return snapshot.kind === 'association' ? (
            <p>
              Saved association {snapshot.id} for target {snapshot.targetId}.{' '}
              <a
                href={
                  '/discovery?' +
                  new URLSearchParams({
                    checkId: snapshot.checkId,
                    associationId: snapshot.id,
                    targetId: snapshot.targetId,
                  }).toString()
                }
              >
                Continue this saved check in Discovery
              </a>
              . Select the matching engagement and confirm the association there; no agent has been
              run.
            </p>
          ) : null;
        })()}
      {entries.map((entry) => (
        <PendingCard
          key={
            entry.intent.tenantId +
            ':' +
            parsePublicWebsiteAssetRequestText(entry.intent.requestText).operationKey
          }
          entry={entry}
          active={entry.intent.tenantId === tenantId.toLowerCase()}
          canManage={canManage}
          busy={isBusy}
          onRead={() => void operate(entry, 'read')}
          onRetry={() => void operate(entry, 'send')}
          onCancel={(value) => void operate(entry, 'cancel', value)}
        />
      ))}
      <div aria-label="Saved website selection pages" className="flex flex-wrap items-start gap-3">
        {(['targets', 'associations', 'captures'] as const).map((kind) => {
          const q = selection(kind),
            key = q ? canonicalJson({ ...q, after: null }) : '',
            state = pages[kind],
            same = state?.key === key;
          return (
            <div key={kind}>
              <button
                className="mb-2 mr-2 rounded-lg border border-slate-300 px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                type="button"
                disabled={!q || (same && state.loading)}
                onClick={() => void loadSelection(kind)}
              >
                Load saved {kind}
              </button>
              {same && state.loading && <p role="status">Loading saved {kind}…</p>}
              {same && state.error && (
                <p role="alert">
                  Saved {kind} could not be loaded. Retry this read; no operation was sent.
                </p>
              )}
              {same && state.page && !state.loading && state.page.rows.length === 0 && (
                <p>No saved {kind} in this selected context.</p>
              )}
              {same && state.page?.nextCursor && (
                <button
                  className="mb-2 mr-2 rounded-lg border border-slate-300 px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                  type="button"
                  disabled={state.loading}
                  onClick={() => void loadSelection(kind, true)}
                >
                  Next saved {kind} page
                </button>
              )}
            </div>
          );
        })}
      </div>
      <form onSubmit={submit} className="space-y-3">
        <label className="block">
          Estate
          <select
            className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 disabled:opacity-50"
            value={estateId}
            onChange={(e) => {
              setEstate(e.target.value);
              setSystem('');
              setTarget('');
              setCapture('');
              setConfirmation('');
            }}
          >
            <option value="">Choose estate</option>
            {options.inventory.estates.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
                {e.status === 'archived' ? ' (archived)' : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          System
          <select
            className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 disabled:opacity-50"
            value={systemId}
            onChange={(e) => {
              setSystem(e.target.value);
              setTarget('');
              setCapture('');
              setConfirmation('');
            }}
          >
            <option value="">Choose system</option>
            {options.inventory.systems
              .filter((s) => s.estateId === estateId)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.status === 'archived' ? ' (archived)' : ''}
                </option>
              ))}
          </select>
        </label>
        <label className="block">
          Operation
          <select
            className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 disabled:opacity-50"
            value={mode}
            onChange={(e) => {
              setMode(e.target.value as typeof mode);
              setConfirmation('');
            }}
          >
            <option value="register_target">Register public website reference</option>
            <option value="capture">Capture fresh public website evidence</option>
            <option value="associate_capture">Reuse retained public website evidence</option>
            <option value="withdraw">Withdraw registered reference</option>
          </select>
        </label>
        {mode === 'register_target' ? (
          <label className="block">
            Public HTTPS website URL
            <input
              type="url"
              className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 disabled:opacity-50"
              value={url}
              maxLength={2048}
              onChange={(e) => {
                setUrl(e.target.value);
                setConfirmation('');
              }}
            />
            <span>No credentials, query parameters, fragment or custom port.</span>
          </label>
        ) : (
          <label className="block">
            Registered public target
            <select
              className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 disabled:opacity-50"
              value={targetId}
              onChange={(e) => {
                setTarget(e.target.value);
                setCapture('');
                setConfirmation('');
              }}
            >
              <option value="">Choose registered target</option>
              {options.targets
                .filter((t) => t.snapshot.estateId === estateId && t.snapshot.systemId === systemId)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.snapshot.url}
                    {t.withdrawn
                      ? ' (withdrawn)'
                      : !t.inventoryCurrent
                        ? ' (inventory changed)'
                        : ''}
                  </option>
                ))}
            </select>
          </label>
        )}
        {mode === 'associate_capture' && (
          <label className="block">
            Retained richer capture
            <select
              className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 disabled:opacity-50"
              value={captureId}
              onChange={(e) => {
                setCapture(e.target.value);
                setConfirmation('');
              }}
            >
              <option value="">Choose retained capture</option>
              {options.captures
                .filter((c) => c.requestedUrl === target?.snapshot.url)
                .map((c) => (
                  <option key={c.checkId} value={c.checkId}>
                    {c.checkedAt} · {c.checkId}
                  </option>
                ))}
            </select>
            <span>
              Reuses these exact retained bytes without fetching the website again. Hash-only legacy
              checks need explicit recapture.
            </span>
          </label>
        )}
        {mode === 'withdraw' && (
          <>
            <label>
              Withdraw scope
              <select
                className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 disabled:opacity-50"
                value={withdrawSubject}
                onChange={(e) => {
                  setWithdrawSubject(e.target.value as typeof withdrawSubject);
                  setAssociation('');
                  setConfirmation('');
                }}
              >
                <option value="target">Whole registered target</option>
                <option value="association">One capture association</option>
              </select>
            </label>
            {withdrawSubject === 'association' && (
              <label>
                Retained association
                <select
                  className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 disabled:opacity-50"
                  value={associationId}
                  onChange={(e) => {
                    setAssociation(e.target.value);
                    setConfirmation('');
                  }}
                >
                  <option value="">Choose retained association</option>
                  {options.associations
                    .filter((a) => a.snapshot.targetId === targetId)
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.snapshot.checkId} · {a.id}
                        {a.withdrawn ? ' (withdrawn)' : ''}
                      </option>
                    ))}
                </select>
                <span>
                  Withdrawal blocks new use of this association only. Its capture, target and audit
                  history remain retained.
                </span>
              </label>
            )}
          </>
        )}
        {mode === 'withdraw' && (
          <label className="block">
            Withdrawal reason
            <input
              className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 disabled:opacity-50"
              value={reason}
              maxLength={2000}
              onChange={(e) => {
                setReason(e.target.value);
                setConfirmation('');
              }}
            />
          </label>
        )}
        <label className="block">
          <input
            className="rounded border border-slate-300 focus-visible:outline focus-visible:outline-2 disabled:opacity-50"
            type="checkbox"
            checked={confirmation === token}
            onChange={(e) => setConfirmation(e.target.checked ? token : '')}
          />{' '}
          I reviewed this selected context and authorize this exact metadata operation.
        </label>
        <button
          className="mb-2 mr-2 rounded-lg border border-slate-300 px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          type="submit"
          disabled={!canManage || !ready || isBusy || entries.length > 0 || confirmation !== token}
        >
          Record selected website operation
        </button>
        {!ready && (
          <p>
            Waiting for verified browser request storage. Nothing will be sent until it is
            available.
          </p>
        )}
        {entries.length > 0 && (
          <p>Resolve the retained request before creating another operation.</p>
        )}
      </form>
    </section>
  );
}

export function PublicWebsiteAssetConsole(props: WebsiteAssetConsoleProps) {
  return (
    <WebsiteAssetConsoleView
      key={props.tenantId.toLowerCase() + ':' + props.actorId.toLowerCase()}
      {...props}
    />
  );
}
