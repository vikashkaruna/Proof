// @vitest-environment jsdom
import React from 'react';
import { createHash } from 'node:crypto';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TechnicalReviewsClient } from './reviews-client';
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
const otherTenant = '99999999-9999-4999-8999-999999999999';
const planId = '22222222-2222-4222-8222-222222222222';
const requestId = '33333333-3333-4333-8333-333333333333';
const reportId = '44444444-4444-4444-8444-444444444444';
const actionId = '55555555-5555-4555-8555-555555555555';
const opKey = '66666666-6666-4666-8666-666666666666';
const plans = [{ id: planId, title: 'Plan alpha', status: 'approved', created_at: '2026-01-01' }];

const frozen = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    schema_version: 1,
    kind: 'technical_plan_source',
    request_id: requestId,
    tenant_id: tenant,
    plan: { id: planId },
    actions: [{ id: actionId, sequence: 1 }],
    limitations: ['a', 'b', 'c'],
    ...over,
  });
const manifest = (over: Record<string, unknown> = {}, sourceText = frozen()) =>
  JSON.stringify({
    schema_version: 2,
    kind: 'technical_recorded_register',
    source_kind: 'recorded_remediation_plan',
    plan_id: planId,
    request_id: requestId,
    tenant_id: tenant,
    source_sha256: sha(sourceText),
    title: 'Register',
    generated_by: 'technical-report-builder',
    ...over,
  });
const row = (over: Record<string, unknown> = {}) => ({
  requestId,
  planId,
  title: 'Alpha register',
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
const mount = (over: Partial<{ canRequest: boolean; founder: boolean; tenantId: string }> = {}) =>
  render(
    <TechnicalReviewsClient
      tenantId={over.tenantId ?? tenant}
      plans={plans}
      canRequest={over.canRequest ?? false}
      founder={over.founder ?? true}
    />,
  );

beforeEach(() => {
  request.mockReset();
});
afterEach(cleanup);

function draftScenario(opts: {
  sourceText?: string;
  sourceSha?: string;
  draftText?: string;
  draftHash?: string;
  draftId?: string;
}) {
  const sourceText = opts.sourceText ?? frozen();
  const draftText = opts.draftText ?? manifest({}, sourceText);
  const draftHash = opts.draftHash ?? sha(draftText);
  routes({
    '/reports/technical/requests?': listing([
      row({ reportId, reportStatus: 'draft', contentHash: sha(draftText) }),
    ]),
    [`/reports/technical/requests/${requestId}/source`]: () =>
      Response.json({ sourceText, sourceSha256: opts.sourceSha ?? sha(sourceText) }),
    [`/reports/${reportId}`]: () =>
      Response.json({
        data: {
          id: opts.draftId ?? reportId,
          kind: 'technical',
          contentText: draftText,
          contentHash: draftHash,
        },
      }),
  });
  return { draftText };
}

it('shows a failed list read as an error with no invented requests', async () => {
  routes({
    '/reports/technical/requests?': () => {
      throw new Error('list unavailable');
    },
  });
  mount();
  expect((await screen.findByRole('alert')).textContent).toBe('list unavailable');
  expect(screen.getByText('No technical register requests are recorded.')).toBeTruthy();
});

it('shows request rows but no founder actions to a non-founder', async () => {
  routes({
    '/reports/technical/requests?': listing([
      row({ reportId, reportStatus: 'draft', contentHash: 'a'.repeat(64) }),
    ]),
  });
  mount({ founder: false });
  await screen.findByText(/Internal reference: Alpha register/);
  expect(screen.getByText(/Plan alpha/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Inspect frozen source' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Create deterministic draft' })).toBeNull();
});

it('freezes a source only for a selected plan with a non-blank title and a fresh operation key', async () => {
  const bodies: unknown[] = [];
  routes({
    '/reports/technical/requests?': listing([]),
    '/reports/technical/request': (_p, init) => {
      bodies.push(init?.body);
      return Response.json({});
    },
  });
  mount({ canRequest: true });
  const submit = await screen.findByRole('button', { name: 'Freeze source' });
  expect((submit as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Recorded remediation plan'), {
    target: { value: planId },
  });
  fireEvent.change(screen.getByLabelText('Register title'), {
    target: { value: '  Q3 register ' },
  });
  fireEvent.click(submit);
  await waitFor(() => expect(bodies).toHaveLength(1));
  expect(bodies[0]).toMatchObject({ planId, title: 'Q3 register' });
  expect((bodies[0] as { operationKey: string }).operationKey).toMatch(/^[0-9a-f-]{36}$/);
  expect(await screen.findByText('Action recorded. Refreshing the recorded state.')).toBeTruthy();
});

it('offers draft creation for a request with no report and posts to the generate route', async () => {
  const posted: string[] = [];
  routes({
    '/reports/technical/requests?': listing([row()]),
    [`/reports/technical/requests/${requestId}/generate`]: (p) => {
      posted.push(p);
      return Response.json({}, { status: 202 });
    },
  });
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Create deterministic draft' }));
  await waitFor(() => expect(posted).toHaveLength(1));
  expect(await screen.findByText(/Storage is pending/)).toBeTruthy();
});

it('previews the frozen source only after every digest and binding check passes, then gates approval on confirmation', async () => {
  const { draftText } = draftScenario({});
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
  expect(approve.disabled).toBe(false);
  fireEvent.click(approve);
  await waitFor(() => expect(reviews).toHaveLength(1));
  expect(reviews[0]).toMatchObject({ decision: 'approved', expectedContentHash: sha(draftText) });
});

it.each([
  [
    'a source whose bytes do not match the recorded digest',
    { sourceSha: 'f'.repeat(64) },
    /do not match their recorded digest/,
  ],
  [
    'a source frozen for another tenant',
    { sourceText: frozen({ tenant_id: otherTenant }) },
    /different request or plan/,
  ],
  [
    'a source frozen for another plan',
    { sourceText: frozen({ plan: { id: otherTenant } }) },
    /different request or plan/,
  ],
  ['a malformed source envelope', { sourceText: frozen({ limitations: ['only one'] }) }, /./],
  [
    'a draft whose hash differs from its content',
    { draftHash: 'e'.repeat(64) },
    /draft differs from the recorded content hash/,
  ],
  [
    'a draft for a different report id',
    { draftId: otherTenant },
    /draft differs from the recorded content hash/,
  ],
  [
    'a draft not bound to the frozen source',
    { draftText: manifest({ source_sha256: 'd'.repeat(64) }) },
    /does not bind to the frozen source/,
  ],
] as const)('refuses %s and shows no preview', async (_name, scenario, message) => {
  draftScenario(scenario);
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Inspect frozen source' }));
  expect((await screen.findByRole('alert')).textContent).toMatch(message);
  expect(screen.queryByText('Frozen source, verified against its SHA-256')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Approve exact draft' })).toBeNull();
});

it('runs build, reconcile and retry against the recorded operation and rejects a mismatched build response', async () => {
  const bodies: Array<[string, unknown]> = [];
  let buildReport = reportId;
  routes({
    '/reports/technical/requests?': listing([
      row({
        reportId,
        reportStatus: 'approved',
        contentHash: 'a'.repeat(64),
        artifact: artifact(),
      }),
    ]),
    [`/reports/technical/${reportId}/artifacts`]: (p, init) => {
      bodies.push([p, init?.body]);
      return Response.json(
        {
          reportId: buildReport,
          reportStatus: 'approved',
          status: 'pending',
          operationKey: opKey,
          lastErrorCode: null,
          pdf: null,
        },
        { status: 202 },
      );
    },
  });
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Build retained versions' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Reconcile' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Retry missing' }));
  await waitFor(() => expect(bodies).toHaveLength(3));
  expect(bodies.map(([p]) => p)).toEqual([
    `/reports/technical/${reportId}/artifacts`,
    `/reports/technical/${reportId}/artifacts/reconcile`,
    `/reports/technical/${reportId}/artifacts/retry-missing`,
  ]);
  expect(bodies[1]![1]).toEqual({ operationKey: opKey });
  expect(bodies[2]![1]).toEqual({ operationKey: opKey });
  expect(screen.getByText(/Retained artifacts: pending/)).toBeTruthy();
  buildReport = otherTenant;
  fireEvent.click(screen.getByRole('button', { name: 'Reconcile' }));
  expect((await screen.findByRole('alert')).textContent).toBe(
    'The retained build response does not match this report.',
  );
});

it('releases only the exact reviewed and retained hashes after explicit authorization', async () => {
  const pdfSha = 'b'.repeat(64);
  const released: unknown[] = [];
  routes({
    '/reports/technical/requests?': listing([
      row({
        reportId,
        reportStatus: 'approved',
        contentHash: 'a'.repeat(64),
        artifact: artifact({
          status: 'settled',
          pdf: { sha256: pdfSha, byteSize: 10, retainUntil: '2036-01-01' },
        }),
      }),
    ]),
    [`/reports/technical/${reportId}/release`]: (_p, init) => {
      released.push(init?.body);
      return Response.json({});
    },
  });
  mount();
  const release = (await screen.findByRole('button', {
    name: 'Release exact PDF',
  })) as HTMLButtonElement;
  expect(release.disabled).toBe(true);
  expect(screen.getByText(new RegExp(`PDF SHA-256 ${pdfSha}`))).toBeTruthy();
  fireEvent.click(screen.getByLabelText(/I authorize release/));
  fireEvent.click(release);
  await waitFor(() => expect(released).toEqual([{ contentHash: 'a'.repeat(64), pdfHash: pdfSha }]));
});

function downloadScenario(
  bytes: Uint8Array,
  headers: Record<string, string>,
  pdfSha = sha(bytes),
  byteSize = bytes.length,
) {
  routes({
    '/reports/technical/requests?': listing([
      row({
        reportId,
        reportStatus: 'published',
        contentHash: 'a'.repeat(64),
        artifact: artifact({
          reportStatus: 'published',
          status: 'settled',
          pdf: { sha256: pdfSha, byteSize, retainUntil: '2036-01-01' },
        }),
      }),
    ]),
    [`/reports/technical/${reportId}/pdf`]: () => new Response(bytes as BodyInit, { headers }),
  });
}

it('saves a PDF only when size, content type, and both hashes match the retained version', async () => {
  const bytes = new TextEncoder().encode('%PDF-1.7 fixture');
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() });
  downloadScenario(bytes, { 'Content-Type': 'application/pdf', 'X-Report-SHA256': sha(bytes) });
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Download verified PDF' }));
  expect(
    await screen.findByText('The downloaded PDF matches the recorded retained version.'),
  ).toBeTruthy();
  expect(click).toHaveBeenCalledTimes(1);
  click.mockRestore();
});

it.each([
  [
    'wrong content type',
    { 'Content-Type': 'text/html' },
    undefined,
    undefined,
    /retained PDF response is invalid/,
  ],
  [
    'header hash that differs from the bytes',
    { 'Content-Type': 'application/pdf', 'X-Report-SHA256': 'c'.repeat(64) },
    undefined,
    undefined,
    /differ from the released PDF hash/,
  ],
  [
    'recorded hash that differs from the bytes',
    { 'Content-Type': 'application/pdf' },
    'c'.repeat(64),
    undefined,
    /differ from the released PDF hash/,
  ],
  [
    'fewer bytes than the retained size',
    { 'Content-Type': 'application/pdf' },
    undefined,
    999,
    /size differs/,
  ],
  [
    'more bytes than the retained size',
    { 'Content-Type': 'application/pdf' },
    undefined,
    4,
    /exceed the retained PDF size/,
  ],
] as const)(
  'refuses a download with a %s and saves nothing',
  async (_n, headers, pdfSha, size, message) => {
    const bytes = new TextEncoder().encode('%PDF-1.7 fixture');
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    downloadScenario(
      bytes,
      {
        ...headers,
        'X-Report-SHA256': (headers as Record<string, string>)['X-Report-SHA256'] ?? sha(bytes),
      },
      pdfSha,
      size,
    );
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Download verified PDF' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(message);
    expect(click).not.toHaveBeenCalled();
    click.mockRestore();
  },
);
