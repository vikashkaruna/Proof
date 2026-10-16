'use client';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { z } from 'zod';
import {
  parsePublicWebsiteAssetSnapshotText,
  publicControlReviewAssociationRefSchema,
  type PublicWebsiteAssetTargetRow,
  type PublicWebsiteAssetAssociationRow,
  type PublicWebsiteAssetSelectionPage,
} from '@axiom/types';
import { readWebsiteAssetSelection } from '../connectors/public-website-asset-client';
export type AssetReviewHint = { targetId?: string; associationId?: string };
export type ConfirmedReviewAssociation = z.infer<typeof publicControlReviewAssociationRefSchema>;
const systemSchema = z.object({
  id: z.uuid(),
  tenant_id: z.uuid(),
  estate_id: z.uuid(),
  name: z.string().min(1),
  status: z.enum(['active', 'archived']),
  version: z.number().int().positive(),
});
const estateSchema = z.object({
  data: z.object({
    id: z.uuid(),
    tenant_id: z.uuid(),
    name: z.string().min(1),
    status: z.enum(['active', 'archived']),
    version: z.number().int().positive(),
    systems: z.array(systemSchema).max(2000),
  }),
});
type Estate = z.infer<typeof estateSchema>['data'];
export function verifyReviewAssociation(
  target: PublicWebsiteAssetTargetRow,
  association: PublicWebsiteAssetAssociationRow,
  scope: {
    tenantId: string;
    estateId: string;
    systemId: string;
    estateVersion: number;
    systemVersion: number;
    checkId: string;
    payloadSha256: string;
  },
) {
  const t = parsePublicWebsiteAssetSnapshotText(target.snapshotText),
    a = parsePublicWebsiteAssetSnapshotText(association.snapshotText);
  if (
    target.withdrawn ||
    !target.inventoryCurrent ||
    association.withdrawn ||
    t.kind !== 'target' ||
    a.kind !== 'association' ||
    t.id !== target.id ||
    a.id !== association.id ||
    t.tenantId !== scope.tenantId ||
    a.tenantId !== scope.tenantId ||
    t.estateId !== scope.estateId ||
    t.systemId !== scope.systemId ||
    t.estateVersion !== scope.estateVersion ||
    t.systemVersion !== scope.systemVersion ||
    a.targetId !== t.id ||
    a.targetSha256 !== target.snapshotSha256 ||
    a.checkId !== scope.checkId ||
    a.payloadSha256 !== scope.payloadSha256 ||
    association.operation.snapshotText !== association.snapshotText ||
    association.operation.snapshotSha256 !== association.snapshotSha256
  )
    throw Error('Association does not match the current estate, system and displayed check.');
  return publicControlReviewAssociationRefSchema.parse({
    targetId: t.id,
    targetSha256: target.snapshotSha256,
    associationId: a.id,
    associationSha256: association.snapshotSha256,
    associationReceipt: association.operation.receipt,
  });
}
type Props = {
  tenantId: string;
  actorId: string;
  estateId: string;
  checkId: string;
  payloadSha256: string;
  hint?: AssetReviewHint;
  disabled?: boolean;
  onConfirmed: (value: ConfirmedReviewAssociation | null) => void;
  selectionTransport?: typeof readWebsiteAssetSelection;
};
export function PublicControlAssetSelection(props: Props) {
  return (
    <Selection
      key={[props.tenantId, props.actorId, props.estateId, props.checkId, props.payloadSha256].join(
        '/',
      )}
      {...props}
    />
  );
}
function Selection({
  tenantId,
  actorId,
  estateId,
  checkId,
  payloadSha256,
  hint,
  disabled = false,
  onConfirmed,
  selectionTransport = readWebsiteAssetSelection,
}: Props) {
  const [estate, setEstate] = useState<Estate | null>(null),
    [systemId, setSystem] = useState(''),
    [targetId, setTarget] = useState(''),
    [associationId, setAssociation] = useState('');
  const [targets, setTargets] = useState<Extract<
      PublicWebsiteAssetSelectionPage,
      { kind: 'targets' }
    > | null>(null),
    [associations, setAssociations] = useState<Extract<
      PublicWebsiteAssetSelectionPage,
      { kind: 'associations' }
    > | null>(null);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [confirmed, setConfirmed] = useState(false),
    [revision, setRevision] = useState(0);
  const alive = useRef(false),
    epoch = useRef(0),
    controller = useRef<AbortController | null>(null);
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      controller.current?.abort();
    };
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    void fetch('/api/bff/v1/estates/' + estateId, {
      headers: { 'X-Tenant-Id': tenantId },
      cache: 'no-store',
      signal: abort.signal,
    })
      .then(async (r) => {
        if (!r.ok) throw Error();
        const e = estateSchema.parse(await r.json()).data;
        if (
          e.id !== estateId ||
          e.tenant_id !== tenantId ||
          e.systems.some((s) => s.tenant_id !== tenantId || s.estate_id !== estateId) ||
          new Set(e.systems.map((s) => s.id)).size !== e.systems.length
        )
          throw Error();
        if (!abort.signal.aborted) setEstate(e);
      })
      .catch(() => {
        if (!abort.signal.aborted)
          setError(
            'Saved estate/system context could not be verified. Retry this read before selecting an association.',
          );
      });
    return () => abort.abort();
  }, [tenantId, estateId, revision]);
  function reset() {
    epoch.current++;
    controller.current?.abort();
    setBusy(false);
    setConfirmed(false);
    onConfirmed(null);
    setError('');
  }
  async function load(kind: 'targets' | 'associations', next = false) {
    if (!estate || !systemId || (kind === 'associations' && !targetId) || busy) return;
    const generation = ++epoch.current;
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setError('');
    setConfirmed(false);
    onConfirmed(null);
    try {
      const page = await selectionTransport(
        tenantId,
        actorId,
        kind === 'targets'
          ? { kind, estateId, systemId, after: next ? (targets?.nextCursor ?? null) : null }
          : { kind, targetId, after: next ? (associations?.nextCursor ?? null) : null },
        abort.signal,
      );
      if (!alive.current || generation !== epoch.current || abort.signal.aborted) return;
      if (page.kind !== kind) throw Error();
      if (page.kind === 'targets') {
        setTargets(page);
        setTarget('');
        setAssociation('');
        setAssociations(null);
      } else if (page.kind === 'associations') {
        setAssociations(page);
        setAssociation('');
      }
    } catch {
      if (alive.current && generation === epoch.current && !abort.signal.aborted)
        setError(
          'Saved website selection could not be verified. Retry this read; no review was recorded.',
        );
    } finally {
      if (alive.current && generation === epoch.current) setBusy(false);
    }
  }
  const target = targets?.rows.find((r) => r.id === targetId),
    association = associations?.rows.find((r) => r.id === associationId),
    system = estate?.systems.find((s) => s.id === systemId);
  let reference: ConfirmedReviewAssociation | null = null;
  try {
    if (
      estate &&
      system &&
      target &&
      association &&
      estate.status === 'active' &&
      system.status === 'active'
    )
      reference = verifyReviewAssociation(target, association, {
        tenantId,
        estateId,
        systemId,
        estateVersion: estate.version,
        systemVersion: system.version,
        checkId,
        payloadSha256,
      });
  } catch {
    /* Keep mismatched/withdrawn history readable, never selectable as new authority. */
  }
  return (
    <section
      aria-label="Website association for human review"
      className="space-y-2 rounded border p-3"
    >
      <h4 className="font-semibold">Explicit saved website association</h4>
      <p>
        Choose a system in the assessment’s saved estate, then its registered target and matching
        capture. Selection does not run agents, verify website ownership or grant access.
      </p>
      {(hint?.targetId || hint?.associationId) && (
        <p>
          Incoming link suggests target {hint.targetId ?? 'unspecified'} and association{' '}
          {hint.associationId ?? 'unspecified'}. These are untrusted hints; select and confirm the
          verified saved records below.
        </p>
      )}
      {!estate && !error && <p role="status">Loading saved estate and systems…</p>}
      {error && <p role="alert">{error}</p>}
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          reset();
          setEstate(null);
          setSystem('');
          setTargets(null);
          setTarget('');
          setAssociations(null);
          setAssociation('');
          setRevision(revision + 1);
        }}
      >
        Refresh association inventory
      </button>
      {estate && (
        <>
          <p>
            Estate {estate.name} · version {estate.version} · {estate.status}
          </p>
          <label>
            Website review system
            <select
              value={systemId}
              disabled={disabled || busy || estate.status !== 'active'}
              onChange={(e) => {
                reset();
                setSystem(e.target.value);
                setTargets(null);
                setTarget('');
                setAssociations(null);
                setAssociation('');
              }}
            >
              <option value="">Choose a saved system</option>
              {estate.systems.map((s) => (
                <option key={s.id} value={s.id} disabled={s.status !== 'active'}>
                  {s.name} · version {s.version} · {s.status}
                </option>
              ))}
            </select>
          </label>
          <button type="button" disabled={busy || !systemId} onClick={() => void load('targets')}>
            Load registered review targets
          </button>
          {targets && (
            <>
              <label>
                Registered review target
                <select
                  value={targetId}
                  disabled={disabled || busy}
                  onChange={(e) => {
                    reset();
                    setTarget(e.target.value);
                    setAssociations(null);
                    setAssociation('');
                  }}
                >
                  <option value="">Choose a retained target</option>
                  {targets.rows.map((t) => {
                    const s = parsePublicWebsiteAssetSnapshotText(t.snapshotText);
                    return (
                      <option key={t.id} value={t.id}>
                        {s.kind === 'target' ? s.url : t.id}
                        {t.withdrawn
                          ? ' · withdrawn'
                          : !t.inventoryCurrent
                            ? ' · inventory changed'
                            : ''}
                      </option>
                    );
                  })}
                </select>
              </label>
              {targets.rows.length === 0 && <p>No saved targets on this page.</p>}
              {targets.nextCursor && (
                <button type="button" disabled={busy} onClick={() => void load('targets', true)}>
                  Next review target page
                </button>
              )}
            </>
          )}
          <button
            type="button"
            disabled={busy || !targetId}
            onClick={() => void load('associations')}
          >
            Load saved review associations
          </button>
          {associations && (
            <>
              <label>
                Saved review association
                <select
                  value={associationId}
                  disabled={disabled || busy}
                  onChange={(e) => {
                    reset();
                    setAssociation(e.target.value);
                  }}
                >
                  <option value="">Choose a retained association</option>
                  {associations.rows.map((a) => {
                    const s = parsePublicWebsiteAssetSnapshotText(a.snapshotText);
                    return (
                      <option key={a.id} value={a.id}>
                        {a.id}
                        {s.kind === 'association' ? ' · check ' + s.checkId : ''}
                        {a.withdrawn ? ' · withdrawn' : ''}
                      </option>
                    );
                  })}
                </select>
              </label>
              {associations.rows.length === 0 && <p>No saved associations on this page.</p>}
              {associations.nextCursor && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void load('associations', true)}
                >
                  Next review association page
                </button>
              )}
            </>
          )}
          {target && association && !reference && (
            <p role="alert">
              This association is withdrawn, stale or does not match the selected estate/system and
              displayed check. Choose a current matching record; history remains unchanged.
            </p>
          )}
          {reference && (
            <label>
              <input
                type="checkbox"
                checked={confirmed}
                disabled={disabled || busy}
                onChange={(e) => {
                  setConfirmed(e.target.checked);
                  onConfirmed(e.target.checked ? reference : null);
                }}
              />
              I confirm this exact saved target, check and association for a new human review.
            </label>
          )}
        </>
      )}
      {busy && <p role="status">Loading saved website selection…</p>}
    </section>
  );
}
