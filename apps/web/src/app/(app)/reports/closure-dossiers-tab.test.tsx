// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ClosureDossiersTab } from './closure-dossiers-tab';
import { readReleasedArchive, reportRequest } from './report-request';

vi.mock('./report-request', () => ({ reportRequest: vi.fn(), readReleasedArchive: vi.fn() }));
const request = vi.mocked(reportRequest);
const readArchive = vi.mocked(readReleasedArchive);
const tenant = '11111111-1111-4111-8111-111111111111';
const hex = 'a'.repeat(64);
const engagement = '33333333-3333-4333-8333-333333333333';
const rid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const report = (n: number, kind: string, engagementId: string | null, title = `Report ${n}`) => ({
  id: rid(n),
  kind,
  title,
  engagementId,
  libraryVersion: 'v1',
  status: 'published',
  generatedAt: '2026-01-01T00:00:00.000Z',
  generatedByAgent: 'agent',
  createdBy: null,
  contentHash: hex,
  reviewedContentHash: hex,
  review: null,
  publishedAt: '2026-01-02T00:00:00.000Z',
  releasedBy: null,
  releasedArchiveHash: null,
  assurance: 'digest_bound',
  pack: null,
});
const list = (data: unknown[], hasMore = false) =>
  Response.json({ data, meta: { total: data.length, limit: 100, offset: 0, hasMore } });
const dossier = (over: Record<string, unknown> = {}) => ({
  id: rid(900),
  tenantId: tenant,
  engagementId: engagement,
  reportId: rid(1),
  dossierType: 'board_executive',
  title: 'Recorded dossier',
  status: 'draft',
  merkleRoot: hex,
  manifestHash: hex,
  archiveHash: 'b'.repeat(64),
  archiveBytes: 12,
  proofSealHash: 'c'.repeat(64),
  metadata: {},
  createdAt: '2026-01-02T03:04:05.000Z',
  updatedAt: '2026-01-02T03:04:05.000Z',
  sourceBound: true,
  archiveStatus: 'settled',
  archiveVersionId: 'ver-1',
  operationKey: rid(777),
  ...over,
});

type Route = (path: string, init?: { body?: unknown }) => Response | Promise<Response>;
function routes(map: Record<string, Route>) {
  request.mockImplementation(async (_tenant, path, init) => {
    const key = Object.keys(map).find((k) => path.startsWith(k));
    if (!key) throw new Error(`unrouted ${path}`);
    return map[key]!(path, init as { body?: unknown });
  });
}

beforeEach(() => {
  request.mockReset();
  readArchive.mockReset();
});
afterEach(cleanup);

it('loads nothing and claims nothing for a role that can neither generate nor release', async () => {
  render(<ClosureDossiersTab tenantId={tenant} canGenerate={false} canRelease={false} />);
  await screen.findByText('No dossier records are visible.');
  expect(request).not.toHaveBeenCalled();
  expect(screen.queryByText('Prepare source-bound dossier')).toBeNull();
});

it('shows a failed load as an error, never as an empty list', async () => {
  routes({
    '/dossiers?': () => {
      throw new Error('upstream refused');
    },
  });
  render(<ClosureDossiersTab tenantId={tenant} canGenerate={false} canRelease />);
  expect((await screen.findByRole('alert')).textContent).toBe('upstream refused');
  expect(screen.queryByText('No dossier records are visible.')).toBeNull();
});

it('labels each dossier type honestly and treats a malformed list as empty', async () => {
  routes({
    '/dossiers?': () =>
      Response.json({
        dossiers: [
          dossier({ id: rid(1), dossierType: 'auditor_assurance', title: 'A' }),
          dossier({ id: rid(2), dossierType: 'technical_register', title: 'T' }),
          dossier({ id: rid(3), dossierType: 'dpb_statutory', title: 'D' }),
          dossier({ id: rid(4), dossierType: 'full_closure', title: 'F' }),
        ],
      }),
  });
  const { unmount } = render(
    <ClosureDossiersTab tenantId={tenant} canGenerate={false} canRelease />,
  );
  await screen.findByText('A');
  expect(screen.getByText(/Assessment-derived auditor dossier/)).toBeTruthy();
  expect(screen.getByText(/Recorded-plan technical dossier/)).toBeTruthy();
  expect(screen.getByText(/Recorded breach and DPB notification dossier/)).toBeTruthy();
  expect(screen.getByText(/full closure/)).toBeTruthy();
  unmount();
  routes({ '/dossiers?': () => Response.json({ dossiers: 'nope' }) });
  render(<ClosureDossiersTab tenantId={tenant} canGenerate={false} canRelease />);
  await screen.findByText('No dossier records are visible.');
});

it('prepares a dossier against the report kind and engagement, with a fresh operation key', async () => {
  const posted: Array<{ path: string; body: unknown }> = [];
  routes({
    '/dossiers/mine': () => Response.json({ builds: [] }),
    '/reports?': () =>
      list([
        report(1, 'board', engagement, 'Board one'),
        report(2, 'auditor', engagement, 'Auditor one'),
        report(3, 'technical', engagement, 'Tech one'),
        report(4, 'dpb', null, 'Breach one'),
        report(5, 'dpb', engagement, 'DPB with engagement is not eligible'),
        report(6, 'board', null, 'Board without engagement is not eligible'),
        report(7, 'consent', engagement, 'Other kind is not eligible'),
      ]),
    '/closure/pramaan/dpb': (path, init) => {
      posted.push({ path, body: init?.body });
      return Response.json({});
    },
    [`/engagements/${engagement}/closure/pramaan`]: (path, init) => {
      posted.push({ path, body: init?.body });
      return Response.json({});
    },
  });
  render(<ClosureDossiersTab tenantId={tenant} canGenerate canRelease={false} />);
  await screen.findByRole('option', { name: /Board report · Board one/ });
  const options = screen.getAllByRole('option').map((o) => o.textContent);
  expect(options).toHaveLength(5);
  expect(options.join('|')).not.toMatch(/not eligible/);
  const select = screen.getByLabelText(/Released board, auditor/);
  const submit = screen.getByRole('button', {
    name: 'Prepare dossier archive',
  }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);

  for (const [id, type, path] of [
    [rid(1), 'board_executive', `/engagements/${engagement}/closure/pramaan`],
    [rid(2), 'auditor_assurance', `/engagements/${engagement}/closure/pramaan`],
    [rid(3), 'technical_register', `/engagements/${engagement}/closure/pramaan`],
    [rid(4), 'dpb_statutory', '/closure/pramaan/dpb'],
  ] as const) {
    fireEvent.change(select, { target: { value: id } });
    fireEvent.click(screen.getByRole('button', { name: 'Prepare dossier archive' }));
    await waitFor(() => expect(posted.at(-1)?.path).toBe(path));
    const body = posted.at(-1)!.body as Record<string, string>;
    expect(body.dossierType).toBe(type);
    expect(body.reportId).toBe(id);
    expect(body.title).toMatch(/ — closure dossier$/);
    expect(body.operationKey).toMatch(/^[0-9a-f-]{36}$/);
    await waitFor(() => expect(submit.disabled).toBe(false));
  }
  const keys = posted.map((p) => (p.body as { operationKey: string }).operationKey);
  expect(new Set(keys).size).toBe(4);
});

it('surfaces a failed prepare as an alert and still re-reads recorded state', async () => {
  let dossierReads = 0;
  routes({
    '/dossiers?': () => {
      dossierReads += 1;
      return Response.json({ dossiers: [] });
    },
    '/reports?': () => list([report(1, 'board', engagement)]),
    [`/engagements/${engagement}/closure/pramaan`]: () => {
      throw new Error('prepare rejected');
    },
  });
  render(<ClosureDossiersTab tenantId={tenant} canGenerate canRelease />);
  await screen.findByRole('option', { name: /Board report/ });
  fireEvent.change(screen.getByLabelText(/Released board, auditor/), { target: { value: rid(1) } });
  fireEvent.change(screen.getByLabelText('Dossier title'), { target: { value: '   ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Prepare dossier archive' }));
  // A blank title must not reach the server.
  expect(request.mock.calls.some(([, p]) => p.includes('closure/pramaan'))).toBe(false);
  fireEvent.change(screen.getByLabelText('Dossier title'), { target: { value: 'Real title' } });
  fireEvent.click(screen.getByRole('button', { name: 'Prepare dossier archive' }));
  expect((await screen.findByText('prepare rejected')).getAttribute('role')).toBe('alert');
  await waitFor(() => expect(dossierReads).toBeGreaterThanOrEqual(2));
});

it('pages released reports forward by 100 without dropping earlier choices', async () => {
  const seen: string[] = [];
  routes({
    '/dossiers/mine': () => Response.json({ builds: [] }),
    '/reports?': (path) => {
      seen.push(path);
      return path.includes('offset=0')
        ? list([report(1, 'board', engagement, 'First page')], true)
        : list([report(2, 'board', engagement, 'Second page')]);
    },
  });
  render(<ClosureDossiersTab tenantId={tenant} canGenerate canRelease={false} />);
  await screen.findByRole('option', { name: /First page/ });
  fireEvent.click(screen.getByRole('button', { name: 'Load more reports' }));
  await screen.findByRole('option', { name: /Second page/ });
  expect(screen.getByRole('option', { name: /First page/ })).toBeTruthy();
  expect(seen[1]).toContain('offset=100');
  expect(screen.queryByRole('button', { name: 'Load more reports' })).toBeNull();
});

it('lets a non-releasing preparer see its own pending builds and reconcile the exact operation key', async () => {
  const reconciled: unknown[] = [];
  routes({
    '/dossiers/mine': () =>
      Response.json({
        builds: [
          {
            dossierId: rid(900),
            reportId: rid(1),
            operationKey: rid(777),
            status: 'pending',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
          {
            dossierId: rid(901),
            reportId: rid(1),
            operationKey: rid(778),
            status: 'settled',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
    '/reports?': () => list([]),
    [`/dossiers/${rid(900)}/archive/reconcile`]: (_p, init) => {
      reconciled.push(init?.body);
      return Response.json({});
    },
  });
  render(<ClosureDossiersTab tenantId={tenant} canGenerate canRelease={false} />);
  await screen.findByText(`Dossier ${rid(900)}`);
  // Only the pending build offers a provider check.
  expect(screen.getAllByRole('button', { name: 'Check provider version' })).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Check provider version' }));
  await waitFor(() => expect(reconciled).toEqual([{ operationKey: rid(777) }]));
});

it('opens a record, seals it against the exact proof seal hash, and reports an unconfirmed seal', async () => {
  const sealBodies: unknown[] = [];
  let sealFails = false;
  routes({
    '/dossiers?': () => Response.json({ dossiers: [dossier()] }),
    [`/dossiers/${rid(900)}/seal`]: (_p, init) => {
      sealBodies.push(init?.body);
      if (sealFails) throw new Error('seal not confirmed by server');
      return Response.json({});
    },
    [`/dossiers/${rid(900)}`]: () => Response.json(dossier()),
  });
  render(<ClosureDossiersTab tenantId={tenant} canGenerate={false} canRelease />);
  fireEvent.click(await screen.findByRole('button', { name: 'View record' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Seal as founder' }));
  await waitFor(() => expect(sealBodies).toEqual([{ expectedProofSeal: 'c'.repeat(64) }]));
  sealFails = true;
  fireEvent.click(
    await within(await screen.findByRole('dialog')).findByRole('button', {
      name: 'Seal as founder',
    }),
  );
  expect((await screen.findByText('seal not confirmed by server')).getAttribute('role')).toBe(
    'alert',
  );
});

it('reconciles or retries a pending archive and then reloads the record it acted on', async () => {
  const hits: string[] = [];
  routes({
    '/dossiers?': () => Response.json({ dossiers: [dossier({ archiveStatus: 'pending' })] }),
    [`/dossiers/${rid(900)}/archive/`]: (path, init) => {
      hits.push(`${path}:${(init?.body as { operationKey: string }).operationKey}`);
      return Response.json({});
    },
    [`/dossiers/${rid(900)}`]: () => Response.json(dossier({ archiveStatus: 'pending' })),
  });
  render(<ClosureDossiersTab tenantId={tenant} canGenerate={false} canRelease />);
  fireEvent.click(await screen.findByRole('button', { name: 'View record' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Check exact provider version' }));
  await waitFor(() => expect(hits).toHaveLength(1));
  fireEvent.click(await screen.findByRole('button', { name: 'Retry only if missing' }));
  await waitFor(() => expect(hits).toHaveLength(2));
  expect(hits).toEqual([
    `/dossiers/${rid(900)}/archive/reconcile:${rid(777)}`,
    `/dossiers/${rid(900)}/archive/retry-missing:${rid(777)}`,
  ]);
});

it('downloads only through the receipt-verified reader and shows its refusal', async () => {
  const click = vi.fn();
  const createObjectURL = vi.fn(() => 'blob:fixture');
  Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
  const anchor = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(click);
  routes({
    '/dossiers?': () => Response.json({ dossiers: [dossier()] }),
    [`/dossiers/${rid(900)}/archive`]: () => new Response('x'),
    [`/dossiers/${rid(900)}`]: () => Response.json(dossier()),
  });
  readArchive.mockResolvedValueOnce(new Blob(['zip']));
  render(<ClosureDossiersTab tenantId={tenant} canGenerate={false} canRelease />);
  fireEvent.click(await screen.findByRole('button', { name: 'View record' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Download verified archive' }));
  await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
  expect(readArchive).toHaveBeenCalledWith(expect.any(Response), 12, 'b'.repeat(64));
  expect(createObjectURL).toHaveBeenCalledTimes(1);

  readArchive.mockRejectedValueOnce(new Error('Archive digest mismatch. No file was accepted.'));
  fireEvent.click(screen.getByRole('button', { name: 'Download verified archive' }));
  expect((await screen.findByRole('alert')).textContent).toContain('digest mismatch');
  expect(click).toHaveBeenCalledTimes(1);
  anchor.mockRestore();
});

it('never starts a download for a record without a recorded archive size and hash', async () => {
  routes({
    '/dossiers?': () =>
      Response.json({ dossiers: [dossier({ archiveBytes: null, archiveHash: null })] }),
    [`/dossiers/${rid(900)}`]: () =>
      Response.json(dossier({ archiveBytes: null, archiveHash: null })),
  });
  render(<ClosureDossiersTab tenantId={tenant} canGenerate={false} canRelease />);
  fireEvent.click(await screen.findByRole('button', { name: 'View record' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Download verified archive' }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(readArchive).not.toHaveBeenCalled();
  expect(request.mock.calls.some(([, p]) => p.endsWith('/archive'))).toBe(false);
});

it('shows an unreadable record as an alert and keeps the modal closed', async () => {
  routes({
    '/dossiers?': () => Response.json({ dossiers: [dossier()] }),
    [`/dossiers/${rid(900)}`]: () => {
      throw new Error('record unavailable');
    },
  });
  render(<ClosureDossiersTab tenantId={tenant} canGenerate={false} canRelease />);
  fireEvent.click(await screen.findByRole('button', { name: 'View record' }));
  expect((await screen.findByText('record unavailable')).getAttribute('role')).toBe('alert');
  expect(screen.queryByRole('dialog')).toBeNull();
});
