// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApprovalProofArchive } from './approval-proof-archive';

const tenant = '11111111-1111-4111-8111-111111111111';
const token = '22222222-2222-4222-8222-222222222222';
const archiveId = '33333333-3333-4333-8333-333333333333';
const sha = 'a'.repeat(64);
const status = (over: Record<string, unknown> = {}) => ({
  archiveId,
  tokenId: token,
  status: 'settled',
  sourceSha256: sha,
  versionId: 'ver-1',
  reviewed: false,
  retainUntil: '2036-01-01T00:00:00.000Z',
  ...over,
});
type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
const calls: Array<{ url: string; init?: RequestInit }> = [];
function serve(handlers: Record<string, Handler>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const key = Object.keys(handlers).find((k) => url.endsWith(k));
      if (!key) throw new Error(`unrouted ${url}`);
      return handlers[key]!(url, init);
    }),
  );
}
const mount = (canManage = true) =>
  render(<ApprovalProofArchive tenantId={tenant} tokenId={token} canManage={canManage} />);

beforeEach(() => {
  calls.length = 0;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('states that no proof is available on 404 and offers archiving only to a manager', async () => {
  serve({ [`/approvals/${token}/archive`]: () => new Response(null, { status: 404 }) });
  mount(true);
  expect(await screen.findByText(/No released proof is available/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Archive proof' })).toBeTruthy();
  cleanup();
  mount(false);
  await screen.findByText(/No released proof is available/);
  expect(screen.queryByRole('button', { name: 'Archive proof' })).toBeNull();
  expect(calls[0]!.init?.headers).toMatchObject({ 'X-Tenant-Id': tenant });
});

it('treats a 403 for a non-manager as no proof but a 500 or a foreign token as unconfirmed, never as released', async () => {
  serve({ [`/approvals/${token}/archive`]: () => new Response(null, { status: 403 }) });
  mount(false);
  await screen.findByText(/No released proof is available/);
  cleanup();
  serve({ [`/approvals/${token}/archive`]: () => new Response(null, { status: 500 }) });
  mount(true);
  expect((await screen.findByRole('alert')).textContent).toBe('Archive status is unavailable.');
  expect(screen.queryByRole('link', { name: 'Download exact version' })).toBeNull();
  cleanup();
  serve({
    [`/approvals/${token}/archive`]: () =>
      Response.json(
        status({ tokenId: '99999999-9999-4999-8999-999999999999', status: 'released' }),
      ),
  });
  mount(true);
  expect((await screen.findByRole('alert')).textContent).toBe('Archive status is unavailable.');
  expect(screen.queryByRole('link', { name: 'Download exact version' })).toBeNull();
});

it('archives with one stable operation key and shows the pending intent the server returns', async () => {
  const keys: unknown[] = [];
  serve({
    [`/approvals/${token}/archive`]: (_u, init) => {
      if (init?.method === 'POST') {
        keys.push(JSON.parse(String(init.body)));
        return Response.json(status({ status: 'pending', versionId: null }));
      }
      return new Response(null, { status: 404 });
    },
  });
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Archive proof' }));
  await screen.findByText(/Archive intent recorded/);
  expect(keys).toHaveLength(1);
  expect((keys[0] as { operationKey: string }).operationKey).toMatch(/^[0-9a-f-]{36}$/);
  expect(screen.getByRole('button', { name: 'Verify provider version' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Retry missing object' })).toBeTruthy();
  expect(screen.queryByText(/Provider version/)).toBeNull();
});

it('maps a refused action to its specific message and re-reads the recorded state', async () => {
  let reads = 0;
  serve({
    [`/approvals/${token}/archive`]: () => {
      reads += 1;
      return Response.json(status({ status: 'pending', versionId: null }));
    },
    [`/approval-archives/${archiveId}/reconcile`]: () =>
      Response.json(
        { error: { code: 'approval_archive_pending_reconciliation' } },
        { status: 409 },
      ),
    [`/approval-archives/${archiveId}/retry-missing`]: () =>
      Response.json({ error: { code: 'something_new' } }, { status: 500 }),
  });
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Verify provider version' }));
  expect((await screen.findByRole('alert')).textContent).toBe(
    'The provider result is uncertain. Use Verify provider version before retrying.',
  );
  expect(reads).toBe(2);
  fireEvent.click(await screen.findByRole('button', { name: 'Retry missing object' }));
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toBe(
      'Missing-object retry could not complete (something_new).',
    ),
  );
});

it('requires a preview bound to the exact version before founder review, then release, then download', async () => {
  let current = status();
  const posted: Array<[string, unknown]> = [];
  serve({
    [`/approvals/${token}/archive`]: () => Response.json(current),
    [`/approval-archives/${archiveId}/preview`]: () =>
      Response.json({ sourceText: '{"facts":[1]}', sourceSha256: sha, versionId: 'ver-1' }),
    [`/approval-archives/${archiveId}/review`]: (_u, init) => {
      posted.push(['review', JSON.parse(String(init?.body))]);
      current = status({ reviewed: true });
      return Response.json(current);
    },
    [`/approval-archives/${archiveId}/release`]: () => {
      posted.push(['release', null]);
      current = status({ reviewed: true, status: 'released' });
      return Response.json(current);
    },
  });
  mount();
  await screen.findByText(/Exact retained version verified/);
  expect(screen.queryByRole('button', { name: 'Record founder review' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Release reviewed proof' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Preview exact proof' }));
  await screen.findByText('Exact retained source for founder review');
  fireEvent.click(screen.getByRole('button', { name: 'Record founder review' }));
  await screen.findByRole('button', { name: 'Release reviewed proof' });
  expect(posted[0]).toEqual(['review', { sourceSha256: sha, versionId: 'ver-1' }]);
  fireEvent.click(screen.getByRole('button', { name: 'Release reviewed proof' }));
  const link = (await screen.findByRole('link', {
    name: 'Download exact version',
  })) as HTMLAnchorElement;
  expect(link.getAttribute('href')).toBe(`/api/bff/v1/approval-archives/${archiveId}/download`);
  expect(posted[1]).toEqual(['release', null]);
});

it('rejects a preview whose version or hash differs from the verified archive and shows no source', async () => {
  let preview: Record<string, unknown> = {
    sourceText: '{}',
    sourceSha256: 'b'.repeat(64),
    versionId: 'ver-1',
  };
  serve({
    [`/approvals/${token}/archive`]: () => Response.json(status()),
    [`/approval-archives/${archiveId}/preview`]: () => Response.json(preview),
  });
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Preview exact proof' }));
  expect((await screen.findByRole('alert')).textContent).toBe(
    'The retained version changed. Refresh and preview again.',
  );
  expect(screen.queryByText('Exact retained source for founder review')).toBeNull();
  preview = { sourceText: '{}', sourceSha256: sha, versionId: 'ver-2' };
  fireEvent.click(screen.getByRole('button', { name: 'Preview exact proof' }));
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toBe(
      'The retained version changed. Refresh and preview again.',
    ),
  );
  expect(screen.queryByRole('button', { name: 'Record founder review' })).toBeNull();
});

it('shows a failed preview request as an error and offers no review', async () => {
  serve({
    [`/approvals/${token}/archive`]: () => Response.json(status()),
    [`/approval-archives/${archiveId}/preview`]: () => new Response(null, { status: 503 }),
  });
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Preview exact proof' }));
  expect((await screen.findByRole('alert')).textContent).toBe(
    'The exact retained proof could not be previewed.',
  );
});

it('does not offer manager actions on a settled archive to a non-manager', async () => {
  serve({ [`/approvals/${token}/archive`]: () => Response.json(status()) });
  mount(false);
  await screen.findByText(/Exact retained version verified/);
  expect(screen.queryByRole('button', { name: 'Preview exact proof' })).toBeNull();
  expect(screen.getByText(`SHA-256 ${sha}`)).toBeTruthy();
});
