'use client';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import {
  publicWebsiteAssetInventorySchema,
  type PublicWebsiteAssetInventory as WebsiteInventory,
} from '@axiom/types';
import { PublicWebsiteAssetConsole } from './public-website-asset-console';
const row = z.object({
  id: z.uuid(),
  tenant_id: z.uuid(),
  name: z.string().min(1).max(200),
  status: z.enum(['active', 'archived']),
  version: z.number().int().positive(),
});
const estateList = z.object({ data: z.array(row).max(1000) });
const detail = z.object({
  data: row.extend({ systems: z.array(row.extend({ estate_id: z.uuid() })).max(2000) }),
});
const pageSize = 10;
/** Read the existing authenticated inventory API; missing or malformed data is never an empty estate. */
export async function loadWebsiteAssetInventory(
  tenantId: string,
  page: number,
  signal: AbortSignal,
) {
  const tenant = z.uuid().parse(tenantId).toLowerCase();
  async function read(path: string): Promise<unknown> {
    signal.throwIfAborted();
    const response = await fetch('/api/bff/v1' + path, {
      headers: { 'X-Tenant-Id': tenant },
      cache: 'no-store',
      signal,
    });
    if (!response.ok) throw Error('Inventory unavailable');
    const value: unknown = await response.json();
    signal.throwIfAborted();
    return value;
  }
  const estates = estateList.parse(await read('/estates')).data;
  if (
    new Set(estates.map((e) => e.id)).size !== estates.length ||
    estates.some((e) => e.tenant_id.toLowerCase() !== tenant)
  )
    throw Error('Inventory scope mismatch');
  const pages = Math.max(1, Math.ceil(estates.length / pageSize));
  if (page < 0 || page >= pages) throw Error('Inventory page changed');
  const selected = estates.slice(page * pageSize, (page + 1) * pageSize);
  const details = await Promise.all(
    selected.map(async (e) => {
      const value = detail.parse(await read('/estates/' + e.id)).data;
      if (
        value.id !== e.id ||
        value.tenant_id.toLowerCase() !== tenant ||
        value.version !== e.version ||
        value.status !== e.status ||
        value.name !== e.name ||
        value.systems.some((s) => s.tenant_id.toLowerCase() !== tenant || s.estate_id !== e.id)
      )
        throw Error('Inventory changed or scope mismatch');
      return value;
    }),
  );
  const inventory = publicWebsiteAssetInventorySchema.parse({
    estates: details.map((e) => ({
      id: e.id,
      tenantId: e.tenant_id,
      name: e.name,
      status: e.status,
      version: e.version,
    })),
    systems: details.flatMap((e) =>
      e.systems.map((s) => ({
        id: s.id,
        tenantId: s.tenant_id,
        estateId: s.estate_id,
        name: s.name,
        status: s.status,
        version: s.version,
      })),
    ),
  });
  if (new Set(inventory.systems.map((s) => s.id)).size !== inventory.systems.length)
    throw Error('Duplicate system');
  return { inventory, pages, total: estates.length };
}
export function PublicWebsiteAssetInventory({
  tenantId,
  actorId,
  canManage = false,
  canOpenDiscovery = false,
}: {
  tenantId: string;
  actorId: string;
  canManage?: boolean;
  canOpenDiscovery?: boolean;
}) {
  const scope = tenantId + ':' + actorId;
  const [page, setPage] = useState(0),
    [refresh, setRefresh] = useState(0);
  const requestKey = scope + ':' + page + ':' + refresh;
  const [state, setState] = useState<{
    key: string;
    scope: string;
    page: number;
    inventory: WebsiteInventory;
    pages: number;
    total: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void loadWebsiteAssetInventory(tenantId, page, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setState({ ...value, key: requestKey, scope, page });
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(requestKey);
      });
    return () => controller.abort();
  }, [tenantId, scope, page, requestKey]);
  const current = state?.key === requestKey ? state : null;
  return (
    <section
      aria-label="Public website estate inventory"
      className="space-y-4 [&>button]:mr-2 [&>button]:mb-2"
    >
      <h2 className="font-semibold">Public websites for saved estate systems</h2>
      {error === requestKey ? (
        <p role="alert">
          Saved estate and system inventory could not be verified. No website operation is
          available.
        </p>
      ) : !current ? (
        <p role="status">Loading saved estates and systems…</p>
      ) : (
        <>
          <p>
            Estate selection page {page + 1} of {current.pages} ({current.total} saved estates).
            Website targets are human-declared metadata; registration does not verify ownership or
            grant access.
          </p>
          {current.total === 0 && (
            <p>No saved estates. Create an estate and system before registering a website.</p>
          )}
          <button
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            type="button"
            disabled={page === 0}
            onClick={() => setPage(page - 1)}
          >
            Previous estate page
          </button>
          <button
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            type="button"
            disabled={page + 1 >= current.pages}
            onClick={() => setPage(page + 1)}
          >
            Next estate page
          </button>
          <PublicWebsiteAssetConsole
            key={scope + ':' + page + ':' + refresh}
            tenantId={tenantId}
            actorId={actorId}
            canManage={canManage}
            canOpenDiscovery={canOpenDiscovery}
            inventory={current.inventory}
            targets={[]}
            captures={[]}
          />
        </>
      )}
      <button
        className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        type="button"
        onClick={() => {
          setPage(0);
          setRefresh(refresh + 1);
        }}
      >
        Refresh saved estate inventory
      </button>
    </section>
  );
}
