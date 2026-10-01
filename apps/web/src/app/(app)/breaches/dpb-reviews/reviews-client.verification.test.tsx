// @vitest-environment jsdom
import React from 'react';
import { createHash } from 'node:crypto';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DpbReviewsClient, type DpbNotification } from './reviews-client';
import { reportRequest } from '../../reports/report-request';

vi.mock('../../reports/report-request', () => ({ reportRequest: vi.fn() }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
const request = vi.mocked(reportRequest);
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const tenant = '11111111-1111-4111-8111-111111111111';
const breachId = '22222222-2222-4222-8222-222222222222';
const notificationId = '77777777-7777-4777-8777-777777777777';
const requestId = '33333333-3333-4333-8333-333333333333';
const reportId = '44444444-4444-4444-8444-444444444444';
const other = '99999999-9999-4999-8999-999999999999';

const notification = (over: Partial<DpbNotification> = {}): DpbNotification => ({
  id: notificationId,
  breach_id: breachId,
  kind: 'dpb',
  status: 'reviewed',
  subject: 'Initial notice',
  reviewed_at: '2026-01-03T00:00:00Z',
  delivery_outcome: null,
  ...over,
});
const breaches = [{ id: breachId, title: 'Breach one', detected_at: '2026-01-01' }];
const sourceText = JSON.stringify({ breach: breachId, note: 'frozen' });
const manifest = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    schema_version: 2,
    kind: 'dpb_notification_review_pack',
    request_id: requestId,
    tenant_id: tenant,
    source_sha256: sha(sourceText),
    title: 'Pack',
    generated_by: 'dpb-report-builder',
    ...over,
  });
const row = (over: Record<string, unknown> = {}) => ({
  requestId,
  breachId,
  notificationId,
  title: 'Pack ref',
  status: 'requested',
  reportId: null,
  reportStatus: null,
  contentHash: null,
  artifact: null,
  createdAt: '2026-01-02T00:00:00.000Z',
  ...over,
});
const artifact = (over: Record<string, unknown> = {}) => ({
  reportStatus: 'approved',
  status: 'not_started',
  operationKey: null,
  lastErrorCode: null,
  pdf: null,
  ...over,
});

type Route = (path: string, init?: { body?: unknown }) => Response | Promise<Response>;
function routes(map: Record<string, Route>) {
  request.mockImplementation(async (_t, path, init) => {
    const key = Object.keys(map).find((k) => path.startsWith(k));
    if (!key) throw new Error(`unrouted ${path}`);
    return map[key]!(path, init as { body?: unknown });
  });
}
const listing = (rows: unknown[]) => () => Response.json({ requests: rows, total: rows.length });
const mount = (
  over: Partial<{ canRequest: boolean; founder: boolean; notifications: DpbNotification[] }> = {},
) =>
  render(
    <DpbReviewsClient
      tenantId={tenant}
      breaches={breaches}
      notifications={over.notifications ?? [notification()]}
      canRequest={over.canRequest ?? false}
      founder={over.founder ?? true}
    />,
  );

beforeEach(() => {
  request.mockReset();
});
afterEach(cleanup);

it('offers only reviewed or sent DPB notifications that carry a second-human review time', async () => {
  routes({ '/reports/dpb/requests?': listing([]) });
  mount({
    canRequest: true,
    notifications: [
      notification({ id: 'a1', subject: 'Reviewed ok' }),
      notification({ id: 'a2', subject: 'Sent ok', status: 'sent', delivery_outcome: null }),
      notification({
        id: 'a3',
        subject: 'Sent confirmed',
        status: 'sent',
        delivery_outcome: 'delivered',
      }),
      notification({ id: 'b1', subject: 'Draft only', status: 'draft' }),
      notification({ id: 'b2', subject: 'Unreviewed', reviewed_at: null }),
      notification({ id: 'b3', subject: 'Other kind', kind: 'principal' }),
    ],
  });
  await screen.findByText('No DPB review pack requests are recorded.');
  const labels = screen.getAllByRole('option').map((o) => o.textContent ?? '');
  expect(labels).toHaveLength(4);
  expect(labels.join('|')).toContain('operator delivery: unrecorded');
  expect(labels.join('|')).toContain('operator delivery: delivered');
  expect(labels.join('|')).not.toMatch(/Draft only|Unreviewed|Other kind/);
});

it('freezes the chosen notification with its own breach id and a fresh operation key', async () => {
  const bodies: unknown[] = [];
  routes({
    '/reports/dpb/requests?': listing([]),
    '/reports/dpb/request': (_p, init) => {
      bodies.push(init?.body);
      return Response.json({});
    },
  });
  mount({ canRequest: true });
  const submit = (await screen.findByRole('button', {
    name: 'Freeze source',
  })) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Reviewed DPB notification'), {
    target: { value: notificationId },
  });
  fireEvent.change(screen.getByLabelText(/Internal reference title/), {
    target: { value: ' Ref ' },
  });
  fireEvent.click(submit);
  await waitFor(() => expect(bodies).toHaveLength(1));
  expect(bodies[0]).toMatchObject({ breachId, notificationId, title: 'Ref' });
  expect((bodies[0] as { operationKey: string }).operationKey).toMatch(/^[0-9a-f-]{36}$/);
});

it('shows a failed list as an error and withholds founder actions from a non-founder', async () => {
  routes({
    '/reports/dpb/requests?': () => {
      throw new Error('dpb list unavailable');
    },
  });
  mount();
  expect((await screen.findByRole('alert')).textContent).toBe('dpb list unavailable');
  cleanup();
  routes({ '/reports/dpb/requests?': listing([row()]) });
  mount({ founder: false });
  await screen.findByText(/Internal reference: Pack ref/);
  expect(screen.getByText(/Breach one/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Create deterministic draft' })).toBeNull();
});

function inspect(opts: {
  sourceSha?: string;
  draftText?: string;
  draftHash?: string;
  draftId?: string;
}) {
  const draftText = opts.draftText ?? manifest();
  routes({
    '/reports/dpb/requests?': listing([
      row({ reportId, reportStatus: 'draft', contentHash: sha(draftText) }),
    ]),
    [`/reports/dpb/requests/${requestId}/source`]: () =>
      Response.json({ sourceText, sourceSha256: opts.sourceSha ?? sha(sourceText) }),
    [`/reports/${reportId}`]: () =>
      Response.json({
        data: {
          id: opts.draftId ?? reportId,
          kind: 'dpb',
          contentText: draftText,
          contentHash: opts.draftHash ?? sha(draftText),
        },
      }),
  });
  return draftText;
}

it('previews a verified source and approves only the exact draft hash after confirmation', async () => {
  const draftText = inspect({});
  const reviews: unknown[] = [];
  const base = request.getMockImplementation()!;
  request.mockImplementation(async (t, p, init) => {
    if (p === `/reports/${reportId}/review`) {
      reviews.push((init as { body?: unknown }).body);
      return Response.json({});
    }
    return base(t, p, init);
  });
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Inspect frozen source' }));
  await screen.findByText('Frozen source, verified against its SHA-256');
  const approve = screen.getByRole('button', { name: 'Approve exact draft' }) as HTMLButtonElement;
  expect(approve.disabled).toBe(true);
  fireEvent.click(screen.getByLabelText(/I reviewed this source/));
  fireEvent.click(approve);
  await waitFor(() => expect(reviews).toHaveLength(1));
  expect(reviews[0]).toMatchObject({ decision: 'approved', expectedContentHash: sha(draftText) });
});

it.each([
  [
    'source bytes that differ from their digest',
    { sourceSha: 'f'.repeat(64) },
    /do not match their recorded digest/,
  ],
  [
    'a draft hash that differs from its content',
    { draftHash: 'e'.repeat(64) },
    /draft differs from the recorded content hash/,
  ],
  [
    'a draft for another report',
    { draftId: other },
    /draft differs from the recorded content hash/,
  ],
  [
    'a draft bound to another tenant',
    { draftText: manifest({ tenant_id: other }) },
    /does not bind to the frozen source/,
  ],
  [
    'a draft bound to another request',
    { draftText: manifest({ request_id: other }) },
    /does not bind to the frozen source/,
  ],
  [
    'a draft bound to another source digest',
    { draftText: manifest({ source_sha256: 'd'.repeat(64) }) },
    /does not bind to the frozen source/,
  ],
] as const)('refuses %s', async (_n, scenario, message) => {
  inspect(scenario);
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Inspect frozen source' }));
  expect((await screen.findByRole('alert')).textContent).toMatch(message);
  expect(screen.queryByRole('button', { name: 'Approve exact draft' })).toBeNull();
});

it('creates drafts, builds retained versions and releases only the exact reviewed and retained hashes', async () => {
  const pdfSha = 'b'.repeat(64);
  const posted: Array<[string, unknown]> = [];
  routes({
    '/reports/dpb/requests?': listing([
      row({ requestId, reportId: null }),
      row({
        requestId: other,
        reportId,
        reportStatus: 'approved',
        contentHash: 'a'.repeat(64),
        artifact: artifact({
          status: 'settled',
          pdf: { sha256: pdfSha, byteSize: 10, retainUntil: '2036-01-01' },
        }),
      }),
    ]),
    '/reports/dpb/requests/': (p, init) => {
      posted.push([p, init?.body]);
      return Response.json({});
    },
    [`/reports/dpb/${reportId}/release`]: (p, init) => {
      posted.push([p, init?.body]);
      return Response.json({});
    },
  });
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Create deterministic draft' }));
  await waitFor(() => expect(posted).toHaveLength(1));
  expect(posted[0]![0]).toBe(`/reports/dpb/requests/${requestId}/generate`);
  const release = screen.getByRole('button', { name: 'Release exact PDF' }) as HTMLButtonElement;
  expect(release.disabled).toBe(true);
  fireEvent.click(screen.getByLabelText(/I authorize release/));
  fireEvent.click(release);
  await waitFor(() => expect(posted).toHaveLength(2));
  expect(posted[1]).toEqual([
    `/reports/dpb/${reportId}/release`,
    { contentHash: 'a'.repeat(64), pdfHash: pdfSha },
  ]);
});

it('rejects a retained build response that belongs to a different report', async () => {
  routes({
    '/reports/dpb/requests?': listing([
      row({
        reportId,
        reportStatus: 'approved',
        contentHash: 'a'.repeat(64),
        artifact: artifact(),
      }),
    ]),
    [`/reports/dpb/${reportId}/artifacts`]: () =>
      Response.json({
        reportId: other,
        reportStatus: 'approved',
        status: 'settled',
        operationKey: null,
        lastErrorCode: null,
        pdf: null,
      }),
  });
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Build retained versions' }));
  expect((await screen.findByRole('alert')).textContent).toBe(
    'The retained build response does not match this report.',
  );
});

function download(
  bytes: Uint8Array,
  headers: Record<string, string>,
  pdfSha = sha(bytes),
  size = bytes.length,
) {
  routes({
    '/reports/dpb/requests?': listing([
      row({
        reportId,
        reportStatus: 'published',
        contentHash: 'a'.repeat(64),
        artifact: artifact({
          reportStatus: 'published',
          status: 'settled',
          pdf: { sha256: pdfSha, byteSize: size, retainUntil: '2036-01-01' },
        }),
      }),
    ]),
    [`/reports/dpb/${reportId}/pdf`]: () => new Response(bytes as BodyInit, { headers }),
  });
}

it('saves a PDF only when type, size and both hashes agree with the retained version', async () => {
  const bytes = new TextEncoder().encode('%PDF-1.7 dpb');
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() });
  download(bytes, { 'Content-Type': 'application/pdf', 'X-Report-SHA256': sha(bytes) });
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Download verified PDF' }));
  await screen.findByText('The downloaded PDF matches the recorded retained version.');
  expect(click).toHaveBeenCalledTimes(1);
  click.mockRestore();
});

it.each([
  [
    'a non-PDF content type',
    { 'Content-Type': 'text/plain' },
    undefined,
    undefined,
    /retained PDF response is invalid/,
  ],
  [
    'a mismatched response hash header',
    { 'Content-Type': 'application/pdf', 'X-Report-SHA256': 'c'.repeat(64) },
    undefined,
    undefined,
    /differ from the released PDF hash/,
  ],
  [
    'a mismatched recorded hash',
    { 'Content-Type': 'application/pdf' },
    'c'.repeat(64),
    undefined,
    /differ from the released PDF hash/,
  ],
  ['too few bytes', { 'Content-Type': 'application/pdf' }, undefined, 500, /size differs/],
  [
    'too many bytes',
    { 'Content-Type': 'application/pdf' },
    undefined,
    3,
    /exceed the retained PDF size/,
  ],
] as const)('saves nothing for %s', async (_n, headers, pdfSha, size, message) => {
  const bytes = new TextEncoder().encode('%PDF-1.7 dpb');
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  download(bytes, { 'X-Report-SHA256': sha(bytes), ...headers }, pdfSha, size);
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Download verified PDF' }));
  expect((await screen.findByRole('alert')).textContent).toMatch(message);
  expect(click).not.toHaveBeenCalled();
  click.mockRestore();
});
