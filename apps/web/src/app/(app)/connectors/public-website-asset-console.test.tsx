// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { webcrypto, createHash } from 'node:crypto';
import { canonicalJson } from '@axiom/ledger';
import {
  encodePublicWebsiteAssetRequest,
  parsePublicWebsiteAssetRequestText,
  PUBLIC_WEBSITE_ASSET_REQUEST_CODEC,
  PUBLIC_WEBSITE_ASSET_SNAPSHOT_CODEC,
  type PublicWebsiteAssetOperation,
} from '@axiom/types';
import {
  PublicWebsiteAssetConsole,
  type WebsiteAssetConsoleProps,
} from './public-website-asset-console';
import {
  readWebsiteAssetIntents,
  retainWebsiteAssetIntent,
  type WebsiteAssetIntent,
} from './public-website-asset-journal';
const tenant = '11111111-1111-4111-8111-111111111111',
  actor = '22222222-2222-4222-8222-222222222222',
  estate = '33333333-3333-4333-8333-333333333333',
  system = '44444444-4444-4444-8444-444444444444',
  target = '55555555-5555-4555-8555-555555555555',
  association = '66666666-6666-4666-8666-666666666666',
  other = '77777777-7777-4777-8777-777777777777';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const snap = canonicalJson({
  version: 1,
  kind: 'target',
  id: target,
  tenantId: tenant,
  actorId: actor,
  ownershipVerified: false,
  connectorAccessGranted: false,
  estateId: estate,
  systemId: system,
  estateVersion: 1,
  systemVersion: 1,
  targetVersion: 1,
  estateName: 'Estate',
  systemName: 'Website',
  url: 'https://public.org/',
});
function props(t = tenant): WebsiteAssetConsoleProps {
  return {
    tenantId: t,
    actorId: actor,
    canManage: true,
    inventory: {
      estates: [{ id: estate, tenantId: t, name: 'Estate', status: 'active', version: 1 }],
      systems: [
        {
          id: system,
          tenantId: t,
          estateId: estate,
          name: 'Website',
          status: 'active',
          version: 1,
        },
      ],
    },
    targets:
      t === tenant
        ? [
            {
              id: target,
              snapshotText: snap,
              snapshotSha256: hash(snap),
              withdrawn: false,
              inventoryCurrent: true,
            },
          ]
        : [],
    captures: [],
  };
}
function retained(t = tenant, key = other): WebsiteAssetIntent {
  return {
    version: 1,
    tenantId: t,
    actorId: actor,
    requestText: encodePublicWebsiteAssetRequest({
      version: 1,
      kind: 'register_target',
      confirmed: true,
      operationKey: key,
      estateId: estate,
      systemId: system,
      expectedEstateVersion: 1,
      expectedSystemVersion: 1,
      url: 'https://public.org/',
    }),
  };
}
function positive(intent: WebsiteAssetIntent): PublicWebsiteAssetOperation {
  const r = parsePublicWebsiteAssetRequestText(intent.requestText);
  return {
    state: 'recorded',
    tenantId: intent.tenantId,
    actorId: intent.actorId,
    operationKey: r.operationKey,
    kind: 'register_target',
    requestCodec: PUBLIC_WEBSITE_ASSET_REQUEST_CODEC,
    requestText: intent.requestText,
    requestSha256: hash(intent.requestText),
    snapshotCodec: PUBLIC_WEBSITE_ASSET_SNAPSHOT_CODEC,
    snapshotText: snap,
    snapshotSha256: hash(snap),
    receipt: { id: '10', entryHash: 'a'.repeat(64) },
    replayed: false,
  };
}
function ports() {
  return {
    send: vi.fn().mockRejectedValue(Error('lost response')),
    read: vi.fn().mockResolvedValue({ state: 'not_found' }),
    cancel: vi.fn().mockRejectedValue(Error('lost cancel')),
  };
}
async function ready() {
  await waitFor(() => expect(screen.queryByText(/Waiting for verified browser/)).toBeNull());
}
function choose() {
  fireEvent.change(screen.getByLabelText('Estate'), { target: { value: estate } });
  fireEvent.change(screen.getByLabelText('System'), { target: { value: system } });
}
function confirm() {
  fireEvent.click(screen.getByLabelText(/I reviewed this selected context/));
}
function submit() {
  fireEvent.click(screen.getByRole('button', { name: 'Record selected website operation' }));
}
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('crypto', webcrypto);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it('registers only explicit parent inventory and freezes unknown intent through edits and reload', async () => {
  const transport = ports(),
    p = { ...props(), transport };
  const view = render(<PublicWebsiteAssetConsole {...p} />);
  await ready();
  choose();
  fireEvent.change(screen.getByLabelText(/Public HTTPS website URL/), {
    target: { value: 'https://public.org/' },
  });
  confirm();
  submit();
  await waitFor(() => expect(transport.send).toHaveBeenCalledTimes(1));
  const intent = transport.send.mock.calls[0]![1] as WebsiteAssetIntent;
  expect(parsePublicWebsiteAssetRequestText(intent.requestText)).toMatchObject({
    estateId: estate,
    systemId: system,
    expectedEstateVersion: 1,
    expectedSystemVersion: 1,
  });
  fireEvent.change(screen.getByLabelText(/Public HTTPS website URL/), {
    target: { value: 'https://changed.org/' },
  });
  view.unmount();
  render(<PublicWebsiteAssetConsole {...p} />);
  await screen.findByText(/Retained register target request/);
  fireEvent.click(screen.getByLabelText(/authorize its retry/));
  fireEvent.click(screen.getByRole('button', { name: 'Retry exact retained request' }));
  await waitFor(() => expect(transport.send).toHaveBeenCalledTimes(2));
  expect(transport.send.mock.calls[1]![1]).toEqual(intent);
  expect(readWebsiteAssetIntents(localStorage, tenant, actor)).toHaveLength(1);
});
it('not_found and later refusal never clear an unknown retained intent', async () => {
  const transport = ports(),
    intent = retained();
  retainWebsiteAssetIntent(localStorage, intent);
  render(<PublicWebsiteAssetConsole {...props()} transport={transport} />);
  await screen.findByText(/Retained register target request/);
  fireEvent.click(screen.getByRole('button', { name: 'Check retained operation' }));
  await screen.findByText(/No positive receipt was found/);
  expect(readWebsiteAssetIntents(localStorage, tenant, actor)[0]?.intent).toEqual(intent);
  transport.read.mockRejectedValue(Error());
  fireEvent.click(screen.getByRole('button', { name: 'Check retained operation' }));
  await screen.findByText(/operation could not be confirmed/);
  expect(readWebsiteAssetIntents(localStorage, tenant, actor)).toHaveLength(1);
});
it('missing all secure RNG sends nothing and keeps an editable form', async () => {
  vi.stubGlobal('crypto', {});
  const transport = ports();
  render(<PublicWebsiteAssetConsole {...props()} transport={transport} />);
  await ready();
  choose();
  fireEvent.change(screen.getByLabelText(/Public HTTPS website URL/), {
    target: { value: 'https://public.org/' },
  });
  confirm();
  submit();
  await screen.findByText(/Request not sent/);
  expect(transport.send).not.toHaveBeenCalled();
  expect(localStorage.length).toBe(0);
});
it('secure getRandomValues fallback works when randomUUID is absent', async () => {
  vi.stubGlobal('crypto', { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) });
  const transport = ports();
  render(<PublicWebsiteAssetConsole {...props()} transport={transport} />);
  await ready();
  choose();
  fireEvent.change(screen.getByLabelText(/Public HTTPS website URL/), {
    target: { value: 'https://public.org/' },
  });
  confirm();
  submit();
  await waitFor(() => expect(transport.send).toHaveBeenCalledTimes(1));
  expect(
    parsePublicWebsiteAssetRequestText(
      (transport.send.mock.calls[0]![1] as WebsiteAssetIntent).requestText,
    ).operationKey,
  ).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
});
it('role can reconcile but cannot retry or cancel; dirty input invalidates confirmation', async () => {
  retainWebsiteAssetIntent(localStorage, retained());
  render(<PublicWebsiteAssetConsole {...props()} canManage={false} transport={ports()} />);
  await screen.findByText(/Retained register target request/);
  expect(
    (screen.getByRole('button', { name: 'Retry exact retained request' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    (screen.getByRole('button', { name: 'Cancel retained intent' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(
    (screen.getByRole('button', { name: 'Check retained operation' }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});
it('cancel reason and confirmation belong to one exact retained operation and become immutable after an unknown outcome', async () => {
  const transport = ports();
  retainWebsiteAssetIntent(localStorage, retained());
  render(<PublicWebsiteAssetConsole {...props()} transport={transport} />);
  await screen.findByText(/Retained register target request/);
  fireEvent.change(screen.getByLabelText('Cancellation reason'), {
    target: { value: 'Mistaken intent' },
  });
  fireEvent.click(screen.getByLabelText(/I confirm cancellation/));
  fireEvent.change(screen.getByLabelText('Cancellation reason'), {
    target: { value: 'Corrected reason' },
  });
  expect(
    (screen.getByRole('button', { name: 'Cancel retained intent' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByLabelText(/I confirm cancellation/));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel retained intent' }));
  await waitFor(() => expect(transport.cancel).toHaveBeenCalledTimes(1));
  expect(readWebsiteAssetIntents(localStorage, tenant, actor)[0]?.cancellation?.reason).toBe(
    'Corrected reason',
  );
  expect(screen.queryByRole('button', { name: 'Retry exact retained request' })).toBeNull();
  expect((screen.getByLabelText('Cancellation reason') as HTMLInputElement).disabled).toBe(true);
  expect(
    (screen.getByRole('button', { name: 'Retry exact cancellation' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});
it('tenant A unknown does not block B; switching back preserves A with no automatic send', async () => {
  const transport = ports();
  retainWebsiteAssetIntent(localStorage, retained());
  const v = render(<PublicWebsiteAssetConsole {...props()} transport={transport} />);
  await screen.findByText(/Retained register target request/);
  v.rerender(<PublicWebsiteAssetConsole {...props(other)} transport={transport} />);
  await ready();
  expect(screen.queryByText(/Retained register target request/)).toBeNull();
  choose();
  fireEvent.change(screen.getByLabelText(/Public HTTPS website URL/), {
    target: { value: 'https://public.org/' },
  });
  confirm();
  expect(
    (screen.getByRole('button', { name: 'Record selected website operation' }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  expect(transport.send).not.toHaveBeenCalled();
  v.rerender(<PublicWebsiteAssetConsole {...props()} transport={transport} />);
  await screen.findByText(/Retained register target request/);
  expect(readWebsiteAssetIntents(localStorage, tenant, actor)).toHaveLength(1);
});
it('late positive after tenant switch/unmount cannot clear old intent or notify the new view', async () => {
  let resolve!: (x: PublicWebsiteAssetOperation) => void;
  const transport = ports(),
    onConfirmed = vi.fn(),
    intent = retained();
  transport.read.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  retainWebsiteAssetIntent(localStorage, intent);
  const v = render(
    <PublicWebsiteAssetConsole {...props()} transport={transport} onConfirmed={onConfirmed} />,
  );
  await screen.findByText(/Retained register target request/);
  fireEvent.click(screen.getByRole('button', { name: 'Check retained operation' }));
  v.rerender(
    <PublicWebsiteAssetConsole {...props(other)} transport={transport} onConfirmed={onConfirmed} />,
  );
  resolve(positive(intent));
  await ready();
  expect(onConfirmed).not.toHaveBeenCalled();
  expect(readWebsiteAssetIntents(localStorage, tenant, actor)).toHaveLength(1);
  v.unmount();
});
it('confirmed callback failure cannot become an unknown retry', async () => {
  const intent = retained(),
    transport = ports();
  transport.read.mockResolvedValue(positive(intent));
  retainWebsiteAssetIntent(localStorage, intent);
  render(
    <PublicWebsiteAssetConsole
      {...props()}
      transport={transport}
      onConfirmed={() => {
        throw Error();
      }}
    />,
  );
  await screen.findByText(/Retained register target request/);
  fireEvent.click(screen.getByRole('button', { name: 'Check retained operation' }));
  await screen.findByText(/outcome is confirmed. Reload/);
  expect(readWebsiteAssetIntents(localStorage, tenant, actor)).toHaveLength(0);
  expect(transport.send).not.toHaveBeenCalled();
});
it('selector reads expose loading, empty, failure and explicit pagination without mutation', async () => {
  const load = vi.fn().mockResolvedValue({
      kind: 'targets',
      tenantId: tenant,
      actorId: actor,
      estateId: estate,
      systemId: system,
      rows: [],
      nextCursor: null,
    }),
    transport = ports();
  render(
    <PublicWebsiteAssetConsole {...props()} transport={transport} selectionTransport={load} />,
  );
  await ready();
  choose();
  fireEvent.click(screen.getByRole('button', { name: 'Load saved targets' }));
  await screen.findByText(/No saved targets/);
  expect(load).toHaveBeenCalledWith(tenant, actor, {
    kind: 'targets',
    estateId: estate,
    systemId: system,
    after: null,
  });
  load.mockRejectedValue(Error());
  fireEvent.click(screen.getByRole('button', { name: 'Load saved targets' }));
  await screen.findByText(/Saved targets could not be loaded/);
  expect(transport.send).not.toHaveBeenCalled();
});
it('association-only withdrawal uses the retained association digest, not whole target withdrawal', async () => {
  const requestText = encodePublicWebsiteAssetRequest({
      version: 1,
      kind: 'capture',
      confirmed: true,
      operationKey: other,
      targetId: target,
      expectedTargetSha256: hash(snap),
    }),
    snapshotText = canonicalJson({
      version: 1,
      kind: 'association',
      id: association,
      tenantId: tenant,
      actorId: actor,
      ownershipVerified: false,
      connectorAccessGranted: false,
      targetId: target,
      targetSha256: hash(snap),
      checkId: other,
      payloadSha256: 'b'.repeat(64),
      captureReceipt: { id: '9', entryHash: 'c'.repeat(64) },
      requestedUrl: 'https://public.org/',
      finalUrl: 'https://public.org/',
      checkedAt: '2026-10-16T00:00:00Z',
    }),
    operation: PublicWebsiteAssetOperation = {
      ...positive(retained()),
      kind: 'capture',
      operationKey: other,
      requestText,
      requestSha256: hash(requestText),
      snapshotText,
      snapshotSha256: hash(snapshotText),
    },
    transport = ports();
  render(
    <PublicWebsiteAssetConsole
      {...props()}
      transport={transport}
      associations={[
        {
          id: association,
          snapshotText,
          snapshotSha256: hash(snapshotText),
          operation,
          withdrawn: false,
        },
      ]}
    />,
  );
  await ready();
  choose();
  fireEvent.change(screen.getByLabelText('Operation'), { target: { value: 'withdraw' } });
  fireEvent.change(screen.getByLabelText('Registered public target'), {
    target: { value: target },
  });
  fireEvent.change(screen.getByLabelText('Withdraw scope'), { target: { value: 'association' } });
  fireEvent.change(screen.getByLabelText(/Retained association/), {
    target: { value: association },
  });
  fireEvent.change(screen.getByLabelText('Withdrawal reason'), {
    target: { value: 'Wrong capture binding' },
  });
  confirm();
  submit();
  await waitFor(() => expect(transport.send).toHaveBeenCalledTimes(1));
  expect(
    parsePublicWebsiteAssetRequestText(
      (transport.send.mock.calls[0]![1] as WebsiteAssetIntent).requestText,
    ),
  ).toMatchObject({
    kind: 'withdraw',
    subjectType: 'association',
    subjectId: association,
    expectedSubjectSha256: hash(snapshotText),
  });
});

it('a retained positive receipt survives cleanup failure followed by later not_found', async () => {
  const intent = retained(),
    transport = ports();
  retainWebsiteAssetIntent(localStorage, intent);
  transport.read
    .mockResolvedValueOnce(positive(intent))
    .mockResolvedValueOnce({ state: 'not_found' });
  const remove = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
    throw Error('storage unavailable');
  });
  render(<PublicWebsiteAssetConsole {...props()} transport={transport} />);
  await screen.findByText(/Retained register target request/);
  fireEvent.click(screen.getByRole('button', { name: 'Check retained operation' }));
  await screen.findByText(/outcome is confirmed, but this browser/);
  fireEvent.click(screen.getByRole('button', { name: 'Check retained operation' }));
  await screen.findByText(/earlier positive receipt remains confirmed; a later missing read/);
  expect(readWebsiteAssetIntents(localStorage, tenant, actor)).toHaveLength(1);
  expect(transport.send).not.toHaveBeenCalled();
  remove.mockRestore();
});
it('explicit selector pagination retains its exact context and hides late replies after unmount', async () => {
  let resolve!: (
    v: Awaited<ReturnType<NonNullable<WebsiteAssetConsoleProps['selectionTransport']>>>,
  ) => void;
  const rows = Array.from({ length: 50 }, (_, i) => {
    const id = i === 49 ? other : '50000000-0000-4000-8000-' + String(i + 1).padStart(12, '0');
    const snapshotText = snap.replace('"id":"' + target + '"', '"id":"' + id + '"');
    return {
      id,
      snapshotText,
      snapshotSha256: hash(snapshotText),
      withdrawn: false,
      inventoryCurrent: true,
    };
  });
  const load = vi
    .fn()
    .mockResolvedValueOnce({
      kind: 'targets',
      tenantId: tenant,
      actorId: actor,
      estateId: estate,
      systemId: system,
      rows,
      nextCursor: other,
    })
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
  const v = render(<PublicWebsiteAssetConsole {...props()} selectionTransport={load} />);
  await ready();
  choose();
  fireEvent.click(screen.getByRole('button', { name: 'Load saved targets' }));
  await screen.findByRole('button', { name: 'Next saved targets page' });
  fireEvent.click(screen.getByRole('button', { name: 'Next saved targets page' }));
  expect(load.mock.calls[1]?.[2]).toMatchObject({
    kind: 'targets',
    estateId: estate,
    systemId: system,
    after: other,
  });
  await screen.findByText(/Loading saved targets/);
  v.unmount();
  resolve({
    kind: 'targets',
    tenantId: tenant,
    actorId: actor,
    estateId: estate,
    systemId: system,
    rows: [],
    nextCursor: null,
  });
});

it('fresh capture and retained reuse take their exact target and source commitments from saved rows', async () => {
  for (const mode of ['capture', 'associate_capture']) {
    const transport = ports(),
      capture = {
        tenantId: tenant,
        checkId: other,
        payloadSha256: 'a'.repeat(64),
        captureReceipt: { id: '90', entryHash: 'b'.repeat(64) },
        requestedUrl: 'https://public.org/',
        finalUrl: 'https://public.org/',
        checkedAt: '2026-10-16T00:00:00Z',
      };
    render(<PublicWebsiteAssetConsole {...props()} captures={[capture]} transport={transport} />);
    await ready();
    choose();
    fireEvent.change(screen.getByLabelText('Operation'), { target: { value: mode } });
    fireEvent.change(screen.getByLabelText('Registered public target'), {
      target: { value: target },
    });
    if (mode === 'associate_capture')
      fireEvent.change(screen.getByLabelText(/Retained richer capture/), {
        target: { value: other },
      });
    confirm();
    submit();
    await waitFor(() => expect(transport.send).toHaveBeenCalledTimes(1));
    const r = parsePublicWebsiteAssetRequestText(
      (transport.send.mock.calls[0]![1] as WebsiteAssetIntent).requestText,
    );
    expect(r).toMatchObject({ kind: mode, targetId: target, expectedTargetSha256: hash(snap) });
    if (mode === 'associate_capture')
      expect(r).toMatchObject({
        checkId: other,
        expectedPayloadSha256: capture.payloadSha256,
        expectedCaptureReceipt: '90',
      });
    cleanup();
    localStorage.clear();
  }
});
it('invalid inventory and changed fields refuse a new request without transport', async () => {
  const transport = ports();
  const v = render(<PublicWebsiteAssetConsole {...props()} transport={transport} />);
  await ready();
  choose();
  fireEvent.change(screen.getByLabelText(/Public HTTPS website URL/), {
    target: { value: 'https://public.org/' },
  });
  confirm();
  fireEvent.change(screen.getByLabelText(/Public HTTPS website URL/), {
    target: { value: 'https://changed.org/' },
  });
  expect(
    (screen.getByRole('button', { name: 'Record selected website operation' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  v.rerender(
    <PublicWebsiteAssetConsole
      {...props()}
      inventory={{
        ...props().inventory,
        systems: [{ ...props().inventory.systems[0]!, tenantId: other }],
      }}
      transport={transport}
    />,
  );
  await screen.findByText(/Website asset context could not be verified/);
  expect(transport.send).not.toHaveBeenCalled();
});

it('offers an explicit Discovery check link only after a matching association receipt, without running agents', async () => {
  const intent: WebsiteAssetIntent = {
    ...retained(),
    requestText: encodePublicWebsiteAssetRequest({
      version: 1,
      kind: 'capture',
      confirmed: true,
      operationKey: other,
      targetId: target,
      expectedTargetSha256: hash(snap),
    }),
  };
  const snapshotText = canonicalJson({
    version: 1,
    kind: 'association',
    id: association,
    tenantId: tenant,
    actorId: actor,
    ownershipVerified: false,
    connectorAccessGranted: false,
    targetId: target,
    targetSha256: hash(snap),
    checkId: other,
    payloadSha256: 'a'.repeat(64),
    captureReceipt: { id: '90', entryHash: 'b'.repeat(64) },
    requestedUrl: 'https://public.org/',
    finalUrl: 'https://public.org/',
    checkedAt: '2026-10-16T00:00:00Z',
  });
  const result = {
    ...positive(intent),
    kind: 'capture' as const,
    snapshotText,
    snapshotSha256: hash(snapshotText),
  };
  const transport = ports();
  transport.read.mockResolvedValue(result);
  retainWebsiteAssetIntent(localStorage, intent);
  render(<PublicWebsiteAssetConsole {...props()} canOpenDiscovery transport={transport} />);
  expect(screen.queryByText('Continue this saved check in Discovery')).toBeNull();
  await screen.findByText(/Retained capture request/);
  fireEvent.click(screen.getByRole('button', { name: 'Check retained operation' }));
  const link = await screen.findByRole('link', { name: 'Continue this saved check in Discovery' });
  expect(link.getAttribute('href')).toContain('checkId=' + other);
  expect(link.getAttribute('href')).toContain('associationId=' + association);
  expect(link.getAttribute('href')).toContain('targetId=' + target);
  expect(transport.send).not.toHaveBeenCalled();
});
