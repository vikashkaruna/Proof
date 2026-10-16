// @vitest-environment jsdom
import React from 'react';
import { createHash } from 'node:crypto';
import { canonicalJson } from '@axiom/ledger';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  PublicControlAssetSelection,
  verifyReviewAssociation,
} from './public-control-asset-selection';
import { linkedReviewFixture, assetIds } from './control-review-v2-fixture.test-helper';
import { ids } from './control-review-fixture.test-helper';
import type { PublicWebsiteAssetSelectionPage } from '@axiom/types';
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function setup() {
  const f = linkedReviewFixture(),
    onConfirmed = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        data: {
          id: assetIds.estate,
          tenant_id: ids.tenant,
          name: 'Estate',
          status: 'active',
          version: 1,
          systems: [
            {
              id: assetIds.system,
              tenant_id: ids.tenant,
              estate_id: assetIds.estate,
              name: 'Website',
              status: 'active',
              version: 1,
            },
          ],
        },
      }),
    ),
  );
  const selectionTransport = vi.fn(async (_tenant: string, _actor: string, q: { kind: string }) =>
    q.kind === 'targets'
      ? {
          kind: 'targets',
          tenantId: ids.tenant,
          actorId: ids.actor,
          estateId: assetIds.estate,
          systemId: assetIds.system,
          rows: [f.targetRow],
          nextCursor: null,
        }
      : {
          kind: 'associations',
          tenantId: ids.tenant,
          actorId: ids.actor,
          targetId: assetIds.target,
          rows: [f.associationRow],
          nextCursor: null,
        },
  ) as unknown as typeof import('../connectors/public-website-asset-client').readWebsiteAssetSelection;
  const props = {
    tenantId: ids.tenant,
    actorId: ids.actor,
    estateId: assetIds.estate,
    checkId: ids.check,
    payloadSha256: f.assessment.source.projectionSha256,
    hint: { targetId: assetIds.target, associationId: assetIds.association },
    onConfirmed,
    selectionTransport,
  };
  return { ...f, props, onConfirmed, selectionTransport: vi.mocked(selectionTransport) };
}
async function choose() {
  await screen.findByText(/Estate Estate/);
  fireEvent.change(screen.getByLabelText('Website review system'), {
    target: { value: assetIds.system },
  });
  fireEvent.click(screen.getByText('Load registered review targets'));
  await screen.findByLabelText('Registered review target');
  fireEvent.change(screen.getByLabelText('Registered review target'), {
    target: { value: assetIds.target },
  });
  fireEvent.click(screen.getByText('Load saved review associations'));
  await screen.findByLabelText('Saved review association');
  fireEvent.change(screen.getByLabelText('Saved review association'), {
    target: { value: assetIds.association },
  });
}
it('untrusted hints do not choose or confirm records; explicit selection yields only the verified reference', async () => {
  const f = setup();
  render(<PublicControlAssetSelection {...f.props} />);
  await screen.findByText(/Estate Estate/);
  expect(f.selectionTransport).not.toHaveBeenCalled();
  expect(f.onConfirmed).not.toHaveBeenCalled();
  await choose();
  expect(f.onConfirmed.mock.calls.every((c) => c[0] === null)).toBe(true);
  fireEvent.click(screen.getByRole('checkbox'));
  expect(f.onConfirmed).toHaveBeenLastCalledWith(f.reference);
  fireEvent.change(screen.getByLabelText('Website review system'), { target: { value: '' } });
  expect(f.onConfirmed).toHaveBeenLastCalledWith(null);
});
it('refuses withdrawn, stale and wrong-check records even though their history remains readable', () => {
  const f = linkedReviewFixture();
  const scope = {
    tenantId: ids.tenant,
    estateId: assetIds.estate,
    systemId: assetIds.system,
    estateVersion: 1,
    systemVersion: 1,
    checkId: ids.check,
    payloadSha256: f.assessment.source.projectionSha256,
  };
  expect(verifyReviewAssociation(f.targetRow, f.associationRow, scope)).toEqual(f.reference);
  for (const [target, association, s] of [
    [{ ...f.targetRow, withdrawn: true }, f.associationRow, scope],
    [{ ...f.targetRow, inventoryCurrent: false }, f.associationRow, scope],
    [f.targetRow, { ...f.associationRow, withdrawn: true }, scope],
    [f.targetRow, f.associationRow, { ...scope, systemVersion: 2 }],
    [f.targetRow, f.associationRow, { ...scope, checkId: ids.actor }],
    [f.targetRow, f.associationRow, { ...scope, payloadSha256: 'f'.repeat(64) }],
  ] as const)
    expect(() => verifyReviewAssociation(target, association, s)).toThrow();
});
it('loads the next saved selection page explicitly with its exact cursor', async () => {
  const f = setup();
  const rows = Array.from({ length: 50 }, (_, i) => {
    const id = '99999999-9999-4999-8999-' + String(i + 1).padStart(12, '0');
    const snapshotText = canonicalJson({ ...f.targetSnapshot, id });
    return {
      ...f.targetRow,
      id,
      snapshotText,
      snapshotSha256: createHash('sha256').update(snapshotText).digest('hex'),
    };
  });
  const cursor = rows.at(-1)!.id;
  f.selectionTransport.mockResolvedValueOnce({
    kind: 'targets',
    tenantId: ids.tenant,
    actorId: ids.actor,
    estateId: assetIds.estate,
    systemId: assetIds.system,
    rows,
    nextCursor: cursor,
  } as PublicWebsiteAssetSelectionPage);
  render(<PublicControlAssetSelection {...f.props} />);
  await screen.findByText(/Estate Estate/);
  fireEvent.change(screen.getByLabelText('Website review system'), {
    target: { value: assetIds.system },
  });
  fireEvent.click(screen.getByText('Load registered review targets'));
  await screen.findByText('Next review target page');
  fireEvent.click(screen.getByText('Next review target page'));
  await waitFor(() => expect(f.selectionTransport).toHaveBeenCalledTimes(2));
  expect(f.selectionTransport.mock.calls[1]?.[2]).toEqual({
    kind: 'targets',
    estateId: assetIds.estate,
    systemId: assetIds.system,
    after: cursor,
  });
});
it('a late old-scope list response cannot supply authority after actor switch', async () => {
  const f = setup();
  let release: ((page: PublicWebsiteAssetSelectionPage) => void) | undefined;
  f.selectionTransport.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const view = render(<PublicControlAssetSelection {...f.props} />);
  await screen.findByText(/Estate Estate/);
  fireEvent.change(screen.getByLabelText('Website review system'), {
    target: { value: assetIds.system },
  });
  fireEvent.click(screen.getByText('Load registered review targets'));
  view.rerender(<PublicControlAssetSelection {...f.props} actorId={ids.review} />);
  release?.({
    kind: 'targets',
    tenantId: ids.tenant,
    actorId: ids.actor,
    estateId: assetIds.estate,
    systemId: assetIds.system,
    rows: [f.targetRow],
    nextCursor: null,
  });
  await screen.findByText(/Estate Estate/);
  expect(screen.queryByLabelText('Registered review target')).toBeNull();
  expect(f.onConfirmed.mock.calls.every((c) => c[0] === null)).toBe(true);
});
