// @vitest-environment jsdom
import React from 'react';
import { renderToString } from 'react-dom/server';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PublicWebsiteClient } from './public-website-client';
import type { PublicFormMetadata } from '@axiom/types';

const check = {
  id: '11111111-1111-4111-8111-111111111111',
  requestedUrl: 'https://example.com/',
  finalUrl: 'https://example.com/privacy',
  checkedAt: '2026-10-04T00:00:00.000Z',
  status: 'checked',
  bytes: 1234,
  contentSha256: 'a'.repeat(64),
  title: 'Privacy',
  headings: ['How we use data'],
  publicLinks: [{ label: 'Contact', url: 'https://example.com/contact' }],
  auditPages: [
    {
      kind: 'contact',
      requestedUrl: 'https://example.com/contact',
      status: 'checked',
      finalUrl: 'https://example.com/contact',
      title: 'Contact us',
      contentSha256: 'b'.repeat(64),
    },
  ],
  observations: [
    { kind: 'privacy', status: 'retrieved' },
    { kind: 'contact', status: 'retrieved' },
    { kind: 'terms', status: 'not_linked' },
  ],
};

const metadata: PublicFormMetadata = {
  version: 1,
  scope: 'static_html_form_descendants',
  sourceSha256: check.contentSha256,
  observedFormCount: 1,
  formsTruncated: false,
  forms: [
    {
      ordinal: 1,
      method: 'post',
      observedControlCount: 3,
      excludedControlCount: 1,
      controlsTruncated: false,
      controls: [
        {
          ordinal: 2,
          element: 'input',
          inputType: 'email',
          requiredAttribute: true,
          disabledAttribute: false,
        },
        { ordinal: 3, element: 'textarea', requiredAttribute: false, disabledAttribute: true },
      ],
    },
  ],
};

it('shows source-bound starting and linked page form facts to viewers', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      Response.json({
        data: [
          {
            ...check,
            formMetadata: metadata,
            auditPages: [
              {
                ...check.auditPages[0],
                formMetadata: { ...metadata, sourceSha256: 'b'.repeat(64) },
              },
            ],
          },
        ],
      }),
    ),
  );
  render(<PublicWebsiteClient tenantId="tenant-1" canManage={false} />);
  const root = await screen.findByRole('region', { name: 'Starting page static HTML forms' });
  const contact = screen.getByRole('region', { name: 'contact static HTML forms' });
  expect(within(root).getByText('1 form observed in retrieved static HTML.')).toBeTruthy();
  expect(within(contact).getByText('1 form observed in retrieved static HTML.')).toBeTruthy();
  fireEvent.click(within(root).getByText('Inspect recorded form attributes'));
  expect(root.querySelector('details')?.open).toBe(true);
  expect(
    within(root).getByText(/3 controls observed · 1 excluded · 2 control details recorded/),
  ).toBeTruthy();
  expect(
    within(root).getByText(
      /Control 2: input \(email\) · Required attribute: present · Disabled attribute: absent/,
    ),
  ).toBeTruthy();
  expect(
    within(root).getByText(
      /Control 3: textarea · Required attribute: absent · Disabled attribute: present/,
    ),
  ).toBeTruthy();
  expect(
    within(root).getByText(/backend storage and processing locations are unverified/),
  ).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Audit public website' })).toBeNull();
});

it('distinguishes observed zero, legacy unexamined and unavailable pages', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      Response.json({
        data: [
          {
            ...check,
            formMetadata: { ...metadata, observedFormCount: 0, forms: [] },
            auditPages: [
              ...check.auditPages,
              { kind: 'terms', requestedUrl: 'https://example.com/terms', status: 'unavailable' },
            ],
          },
        ],
      }),
    ),
  );
  render(<PublicWebsiteClient tenantId="tenant-1" canManage={false} />);
  const root = await screen.findByRole('region', { name: 'Starting page static HTML forms' });
  expect(within(root).getByText('0 forms observed in retrieved static HTML.')).toBeTruthy();
  expect(within(root).queryByText('Inspect recorded form attributes')).toBeNull();
  expect(
    within(screen.getByRole('region', { name: 'contact static HTML forms' })).getByText(
      'Static HTML forms were not examined in this saved check.',
    ),
  ).toBeTruthy();
  const unavailable = screen.getByRole('region', { name: 'terms static HTML forms' });
  expect(
    within(unavailable).getByText('Form inspection unavailable: this page could not be retrieved.'),
  ).toBeTruthy();
  expect(unavailable.textContent).not.toContain('0 forms');
});

it('makes form and control truncation visible without implying complete inventory', async () => {
  const truncated: PublicFormMetadata = {
    ...metadata,
    observedFormCount: 4,
    formsTruncated: true,
    forms: [1, 2, 3].map((ordinal) => ({
      ordinal,
      method: 'get',
      observedControlCount: 14,
      excludedControlCount: 1,
      controlsTruncated: true,
      controls: Array.from({ length: 12 }, (_, index) => ({
        ordinal: index + 2,
        element: 'input',
        inputType: 'text',
        requiredAttribute: false,
        disabledAttribute: false,
      })),
    })),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(Response.json({ data: [{ ...check, formMetadata: truncated }] })),
  );
  render(<PublicWebsiteClient tenantId="tenant-1" canManage={false} />);
  const root = await screen.findByRole('region', { name: 'Starting page static HTML forms' });
  expect(
    within(root).getByText('Form details are truncated: 3 of 4 observed forms are recorded.'),
  ).toBeTruthy();
  fireEvent.click(within(root).getByText('Inspect recorded form attributes'));
  expect(
    within(root).getAllByText(
      'Control details are truncated; additional eligible controls were observed.',
    ),
  ).toHaveLength(3);
  expect(root.querySelectorAll('details li li')).toHaveLength(36);
});

it.each([
  { ...check, status: 'failed', formMetadata: metadata },
  { ...check, formMetadata: { ...metadata, sourceSha256: 'c'.repeat(64) } },
  { ...check, formMetadata: { ...metadata, rawValue: 'private-sentinel' } },
  {
    ...check,
    formMetadata: {
      ...metadata,
      forms: [
        {
          ...metadata.forms[0],
          controls: [
            { ...metadata.forms[0]!.controls[0], label: 'private-sentinel' },
            metadata.forms[0]!.controls[1],
          ],
        },
      ],
    },
  },
  { ...check, auditPages: [{ ...check.auditPages[0], formMetadata: metadata }] },
  {
    ...check,
    auditPages: [
      {
        ...check.auditPages[0],
        status: 'unavailable',
        formMetadata: { ...metadata, sourceSha256: 'b'.repeat(64) },
      },
    ],
  },
])('fails closed rather than dropping invalid recorded form metadata %#', async (invalid) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ data: [invalid] })));
  render(<PublicWebsiteClient tenantId="tenant-1" canManage={false} />);
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    'Recent checks could not be loaded.',
  );
  expect(screen.queryByText('Privacy')).toBeNull();
  expect(document.body.textContent).not.toContain('private-sentinel');
});

afterEach(() => {
  localStorage.clear();
  cleanup();
  vi.unstubAllGlobals();
});

it('does not expose an active submit button before hydration', () => {
  const html = renderToString(<PublicWebsiteClient tenantId="tenant-1" canManage />);
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Audit public website<\/button>/);
});

it('lets viewers inspect recorded public content without a check action or unsafe external link', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ data: [check] }));
  vi.stubGlobal('fetch', fetcher);
  render(<PublicWebsiteClient tenantId="tenant-1" canManage={false} />);
  await waitFor(() => expect(screen.getByText('How we use data')).toBeTruthy());
  expect(screen.getByText(/Contact: https:\/\/example.com\/contact/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Audit public website' })).toBeNull();
  expect(screen.queryByRole('link', { name: /Contact/ })).toBeNull();
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
    cache: 'no-store',
    headers: { 'X-Tenant-Id': 'tenant-1' },
  });
});

it('checks a public URL through the tenant-scoped BFF and shows the retrieved content', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ data: [] }))
    .mockResolvedValueOnce(
      Response.json({ data: { ...check, formMetadata: metadata } }, { status: 201 }),
    );
  vi.stubGlobal('fetch', fetcher);
  render(<PublicWebsiteClient tenantId="tenant-1" canManage />);
  await waitFor(() =>
    expect(
      screen.getByText('No public website checks recorded for this organization.'),
    ).toBeTruthy(),
  );
  fireEvent.change(screen.getByRole('textbox', { name: 'Public page URL' }), {
    target: { value: check.requestedUrl },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Audit public website' }));
  await waitFor(() => expect(screen.getByText('How we use data')).toBeTruthy());
  expect(screen.getByText('Public website audit recorded.')).toBeTruthy();
  expect(
    within(screen.getByRole('region', { name: 'Starting page static HTML forms' })).getByText(
      '1 form observed in retrieved static HTML.',
    ),
  ).toBeTruthy();
  expect(screen.getByText(/limited public-content audit/)).toBeTruthy();
  expect(screen.getByText(/no eligible same-site link found on the starting page/)).toBeTruthy();
  expect(screen.getByText(/Contact us/)).toBeTruthy();
  const request = fetcher.mock.calls[1];
  expect(request?.[0]).toBe('/api/bff/v1/public-website-checks');
  expect(request?.[1]).toMatchObject({
    method: 'POST',
    headers: { 'X-Tenant-Id': 'tenant-1', 'Content-Type': 'application/json' },
  });
  expect(request?.[1]?.headers['Idempotency-Key']).toMatch(/[0-9a-f-]{36}/);
  expect(JSON.parse(request?.[1]?.body)).toEqual({ url: check.requestedUrl });
});

it('retains an uncertain check after a later controlled refusal without a positive receipt', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ data: [] }))
    .mockRejectedValueOnce(new Error('lost response'))
    .mockResolvedValueOnce(
      Response.json({ error: { code: 'non_public_target' } }, { status: 400 }),
    );
  vi.stubGlobal('fetch', fetcher);
  render(<PublicWebsiteClient tenantId="tenant-1" canManage />);
  await waitFor(() =>
    expect(
      screen.getByText('No public website checks recorded for this organization.'),
    ).toBeTruthy(),
  );
  fireEvent.change(screen.getByRole('textbox', { name: 'Public page URL' }), {
    target: { value: check.requestedUrl },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Audit public website' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Retry same check' })).toBeTruthy(),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Retry same check' }));
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toContain(
      'That address does not resolve to a permitted public website.',
    ),
  );
  expect(fetcher.mock.calls[1]?.[1]?.headers['Idempotency-Key']).toBe(
    fetcher.mock.calls[2]?.[1]?.headers['Idempotency-Key'],
  );
  expect(fetcher.mock.calls[1]?.[1]?.body).toBe(fetcher.mock.calls[2]?.[1]?.body);
  expect(screen.getByRole('button', { name: 'Retry same check' })).toBeTruthy();
  expect((screen.getByLabelText('Public page URL') as HTMLInputElement).disabled).toBe(true);
});

it('retains an in-progress request key when a later upstream error lacks a positive receipt', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ data: [] }))
    .mockResolvedValueOnce(
      Response.json({ error: { code: 'idempotency_in_progress' } }, { status: 409 }),
    )
    .mockResolvedValueOnce(Response.json({ error: { code: 'unreachable' } }, { status: 502 }));
  vi.stubGlobal('fetch', fetcher);
  render(<PublicWebsiteClient tenantId="tenant-1" canManage />);
  await waitFor(() =>
    expect(screen.getByRole('textbox', { name: 'Public page URL' })).toBeTruthy(),
  );
  fireEvent.change(screen.getByRole('textbox', { name: 'Public page URL' }), {
    target: { value: check.requestedUrl },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Audit public website' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Retry same check' })).toBeTruthy(),
  );
  const firstKey = fetcher.mock.calls[1]?.[1]?.headers['Idempotency-Key'];
  fireEvent.click(screen.getByRole('button', { name: 'Retry same check' }));
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toContain(
      'The public website could not be retrieved. Check the address and try again.',
    ),
  );
  expect(fetcher.mock.calls[2]?.[1]?.headers['Idempotency-Key']).toBe(firstKey);
  expect(screen.getByRole('button', { name: 'Retry same check' })).toBeTruthy();
  expect((screen.getByLabelText('Public page URL') as HTMLInputElement).disabled).toBe(true);
});

it('audits with a secure HTTP UUID fallback and retries the exact pending public check', async () => {
  const getRandomValues = vi.fn((bytes: Uint8Array) => {
    bytes.fill(31);
    return bytes;
  });
  vi.stubGlobal('crypto', { getRandomValues });
  let posts = 0;
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method !== 'POST') return Response.json({ data: [] });
    posts++;
    if (posts === 1) throw new Error('lost response');
    return Response.json({ data: check }, { status: 201 });
  });
  vi.stubGlobal('fetch', fetcher);
  render(<PublicWebsiteClient tenantId="tenant-1" canManage />);
  await waitFor(() =>
    expect(screen.queryByText('Loading recent public website checks…')).toBeNull(),
  );
  const url = screen.getByLabelText('Public page URL') as HTMLInputElement;
  fireEvent.change(url, { target: { value: 'https://example.com/' } });
  fireEvent.click(screen.getByRole('button', { name: 'Audit public website' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Retry same check' })).toBeTruthy(),
  );
  expect(url.disabled).toBe(true);
  // Pending intent is immutable even if disabled DOM values change programmatically.
  fireEvent.change(url, { target: { value: 'https://different.example/' } });
  fireEvent.click(screen.getByRole('button', { name: 'Retry same check' }));
  await waitFor(() => expect(screen.getByText('Public website audit recorded.')).toBeTruthy());
  const writes = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
  expect(writes[0]![0]).toBe('/api/bff/v1/public-website-checks');
  expect(JSON.parse(String(writes[0]![1]?.body))).toEqual({ url: 'https://example.com/' });
  expect(writes[0]![1]?.headers).toMatchObject({
    'X-Tenant-Id': 'tenant-1',
    'Idempotency-Key': expect.stringMatching(
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    ),
  });
  expect(getRandomValues).toHaveBeenCalledOnce();
  expect(url.disabled).toBe(false);
});

it('keeps a public check editable and sends no POST when secure randomness is unavailable', async () => {
  vi.stubGlobal('crypto', {});
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) =>
    Response.json({ data: init?.method === 'POST' ? check : [] }),
  );
  vi.stubGlobal('fetch', fetcher);
  render(<PublicWebsiteClient tenantId="tenant-1" canManage />);
  await waitFor(() =>
    expect(screen.queryByText('Loading recent public website checks…')).toBeNull(),
  );
  const url = screen.getByLabelText('Public page URL') as HTMLInputElement;
  fireEvent.change(url, { target: { value: 'https://example.com/' } });
  fireEvent.click(screen.getByRole('button', { name: 'Audit public website' }));
  await waitFor(() =>
    expect(screen.getByRole('status').textContent).toContain('could not be prepared'),
  );
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  expect(url.disabled).toBe(false);
  expect(url.value).toBe('https://example.com/');
  expect(screen.queryByRole('button', { name: 'Retry same check' })).toBeNull();
  vi.stubGlobal('crypto', { randomUUID: () => 'request-prepared-website' });
  fireEvent.change(url, { target: { value: 'https://example.com/corrected' } });
  fireEvent.click(screen.getByRole('button', { name: 'Audit public website' }));
  await waitFor(() => expect(screen.getByText('Public website audit recorded.')).toBeTruthy());
  const writes = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(writes).toHaveLength(1);
  expect(JSON.parse(String(writes[0]![1]?.body))).toEqual({ url: 'https://example.com/corrected' });
});

it('blocks an unknown public check retry in another organisation and replays exactly on return', async () => {
  const uuid = vi.fn(() => 'public-scope-1');
  vi.stubGlobal('crypto', { randomUUID: uuid });
  let posts = 0;
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method !== 'POST') return Response.json({ data: [] });
    if (++posts === 1) throw new Error('lost response');
    return Response.json({ data: check });
  });
  vi.stubGlobal('fetch', fetcher);
  const view = render(<PublicWebsiteClient tenantId="tenant-A" canManage />);
  fireEvent.change(screen.getByLabelText('Public page URL'), {
    target: { value: 'https://example.com/' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Audit public website' }));
  await screen.findByRole('button', { name: 'Retry same check' });
  const first = fetcher.mock.calls.find(([, init]) => init?.method === 'POST')!;
  view.rerender(<PublicWebsiteClient tenantId="tenant-B" canManage />);
  fireEvent.click(screen.getByRole('button', { name: 'Retry same check' }));
  await screen.findByText(/Return to the original organisation/);
  expect(posts).toBe(1);
  expect(uuid).toHaveBeenCalledOnce();
  expect((screen.getByLabelText('Public page URL') as HTMLInputElement).disabled).toBe(true);
  view.rerender(<PublicWebsiteClient tenantId="tenant-A" canManage />);
  fireEvent.click(screen.getByRole('button', { name: 'Retry same check' }));
  await screen.findByText('Public website audit recorded.');
  const writes = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(first);
  expect(uuid).toHaveBeenCalledOnce();
});

it('allows a fresh public check in a new organisation after a definite refusal', async () => {
  let key = 0;
  vi.stubGlobal('crypto', { randomUUID: () => `public-fresh-${++key}` });
  let posts = 0;
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method !== 'POST') return Response.json({ data: [] });
    return ++posts === 1
      ? Response.json({ error: { code: 'invalid_url' } }, { status: 400 })
      : Response.json({ data: check });
  });
  vi.stubGlobal('fetch', fetcher);
  const view = render(<PublicWebsiteClient tenantId="tenant-A" canManage />);
  fireEvent.change(screen.getByLabelText('Public page URL'), {
    target: { value: 'https://example.com/' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Audit public website' }));
  await screen.findByText('Enter a valid public HTTP or HTTPS URL.');
  view.rerender(<PublicWebsiteClient tenantId="tenant-B" canManage />);
  fireEvent.change(screen.getByLabelText('Public page URL'), {
    target: { value: 'https://example.com/corrected' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Audit public website' }));
  await screen.findByText('Public website audit recorded.');
  const writes = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(writes).toHaveLength(2);
  expect(writes[1]![1]?.headers).toMatchObject({
    'X-Tenant-Id': 'tenant-B',
    'Idempotency-Key': 'public-fresh-2',
  });
  expect(JSON.parse(String(writes[1]![1]?.body))).toEqual({ url: 'https://example.com/corrected' });
});

it('never shows an old organisation check when its in-flight success arrives during new history loading', async () => {
  let finishPost!: (response: Response) => void;
  let finishHistory!: (response: Response) => void;
  const oldPost = new Promise<Response>((resolve) => {
    finishPost = resolve;
  });
  const newHistory = new Promise<Response>((resolve) => {
    finishHistory = resolve;
  });
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return oldPost;
    return (init?.headers as Record<string, string>)['X-Tenant-Id'] === 'tenant-B'
      ? newHistory
      : Response.json({ data: [{ ...check, title: 'A-only retained check' }] });
  });
  vi.stubGlobal('fetch', fetcher);
  const view = render(<PublicWebsiteClient tenantId="tenant-A" canManage />);
  await screen.findByText('A-only retained check');
  fireEvent.change(screen.getByLabelText('Public page URL'), {
    target: { value: 'https://example.com/' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Audit public website' }));
  view.rerender(<PublicWebsiteClient tenantId="tenant-B" canManage />);
  expect(screen.queryByText('A-only retained check')).toBeNull();
  await act(async () => {
    finishPost(Response.json({ data: { ...check, title: 'A-only completed check' } }));
  });
  await screen.findByText(/original organisation completed/);
  expect(screen.queryByText('A-only completed check')).toBeNull();
  expect(screen.queryByText('A-only retained check')).toBeNull();
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  await act(async () => {
    finishHistory(
      Response.json({
        data: [
          { ...check, id: '22222222-2222-4222-8222-222222222222', title: 'B-only retained check' },
        ],
      }),
    );
  });
  await screen.findByText('B-only retained check');
  expect(screen.queryByText('A-only completed check')).toBeNull();
});

it.each(['response', 'network', 'malformed'])(
  'retains a %s public-check outcome that becomes unknown after the organisation changes',
  async (outcome) => {
    let finish!: (response: Response) => void;
    let fail!: (error: Error) => void;
    const response = new Promise<Response>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    let posts = 0;
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return Response.json({ data: [] });
      return ++posts === 1 ? response : Response.json({ data: check });
    });
    vi.stubGlobal('fetch', fetcher);
    const uuid = vi.fn(() => 'public-deferred-scope-key');
    vi.stubGlobal('crypto', { randomUUID: uuid });
    const view = render(<PublicWebsiteClient tenantId="tenant-A" canManage />);
    fireEvent.change(screen.getByLabelText('Public page URL'), {
      target: { value: 'https://example.com/' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Audit public website' }));
    const first = fetcher.mock.calls.find(([, init]) => init?.method === 'POST')!;
    view.rerender(<PublicWebsiteClient tenantId="tenant-B" canManage />);
    await act(async () => {
      if (outcome === 'network') fail(new Error('private-network-detail'));
      else
        finish(
          outcome === 'response'
            ? Response.json({ error: { code: 'unknown' } }, { status: 503 })
            : Response.json({ data: {} }),
        );
    });
    await screen.findByText(/Return to the original organisation/);
    expect(posts).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Retry same check' }));
    expect(posts).toBe(1);
    view.rerender(<PublicWebsiteClient tenantId="tenant-A" canManage />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry same check' }));
    await screen.findByText('Public website audit recorded.');
    const writes = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual(first);
    expect(uuid).toHaveBeenCalledOnce();
  },
);

it.each([
  ['network', 401],
  ['network', 403],
  ['network', 409],
  ['response', 401],
  ['response', 403],
  ['response', 409],
  ['malformed', 401],
  ['malformed', 403],
  ['malformed', 409],
])(
  'retains the original %s-unknown public check after a later HTTP %s refusal until positive settlement',
  async (outcome, status) => {
    const uuid = vi.fn(() => 'sticky-public-original-key');
    vi.stubGlobal('crypto', { randomUUID: uuid });
    let posts = 0;
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return Response.json({ data: [] });
      posts++;
      if (posts === 1) {
        if (outcome === 'network') throw new Error('response lost');
        return outcome === 'response'
          ? Response.json({ error: { code: 'unknown' } }, { status: 503 })
          : Response.json({ data: {} });
      }
      return posts === 2
        ? Response.json({ error: { code: 'access_refused' } }, { status: Number(status) })
        : Response.json({ data: check });
    });
    vi.stubGlobal('fetch', fetcher);
    render(<PublicWebsiteClient tenantId="tenant-1" canManage />);
    fireEvent.change(screen.getByLabelText('Public page URL'), {
      target: { value: 'https://example.com/' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Audit public website' }));
    await screen.findByRole('button', { name: 'Retry same check' });
    const first = fetcher.mock.calls.find(([, init]) => init?.method === 'POST')!;
    fireEvent.click(screen.getByRole('button', { name: 'Retry same check' }));
    await screen.findByText(/The website check could not be completed/);
    expect((screen.getByLabelText('Public page URL') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Audit public website' })).toBeNull();
    expect(uuid).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Retry same check' }));
    await screen.findByText('Public website audit recorded.');
    const writes = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(writes).toHaveLength(3);
    expect(writes[1]).toEqual(first);
    expect(writes[2]).toEqual(first);
    expect(uuid).toHaveBeenCalledOnce();
  },
);

it.each([400, 401, 403, 409, 502])(
  'permits a fresh public check after an initial definite HTTP %s refusal without a prior unknown',
  async (status) => {
    let key = 0;
    vi.stubGlobal('crypto', { randomUUID: () => `definite-public-${++key}` });
    let posts = 0;
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return Response.json({ data: [] });
      return ++posts === 1
        ? Response.json(
            { error: { code: status === 502 ? 'unreachable' : 'non_public_target' } },
            { status },
          )
        : Response.json({ data: check });
    });
    vi.stubGlobal('fetch', fetcher);
    render(<PublicWebsiteClient tenantId="tenant-1" canManage />);
    fireEvent.change(screen.getByLabelText('Public page URL'), {
      target: { value: 'https://example.com/' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Audit public website' }));
    await screen.findByText(
      status === 502
        ? 'The public website could not be retrieved. Check the address and try again.'
        : 'That address does not resolve to a permitted public website.',
    );
    expect((screen.getByLabelText('Public page URL') as HTMLInputElement).disabled).toBe(false);
    fireEvent.change(screen.getByLabelText('Public page URL'), {
      target: { value: 'https://example.com/corrected' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Audit public website' }));
    await screen.findByText('Public website audit recorded.');
    const writes = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(writes).toHaveLength(2);
    expect(writes[0]![1]?.headers).toMatchObject({ 'Idempotency-Key': 'definite-public-1' });
    expect(writes[1]![1]?.headers).toMatchObject({ 'Idempotency-Key': 'definite-public-2' });
    expect(JSON.parse(String(writes[1]![1]?.body))).toEqual({
      url: 'https://example.com/corrected',
    });
  },
);

const recaptureContext = {
  id: 'tenant-1/engagement-1/check-1',
  actorId: '22222222-2222-4222-8222-222222222222',
  url: 'https://example.com/privacy',
  engagementTitle: 'Selected engagement',
  estateName: 'Selected estate',
};
const contextualCheck = { ...check, requestedUrl: recaptureContext.url };
it('keeps contextual capture URL and exact uncertain request locked to its original engagement', async () => {
  const saved = vi.fn();
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method !== 'POST') return Response.json({ data: [] });
    const posts = fetcher.mock.calls.filter(([, i]) => i?.method === 'POST');
    if (posts.length === 1) throw new Error('connection lost');
    return Response.json({ data: contextualCheck }, { status: 201 });
  });
  vi.stubGlobal('fetch', fetcher);
  const view = render(
    <PublicWebsiteClient
      tenantId="11111111-1111-4111-8111-111111111111"
      canManage
      context={recaptureContext}
      onRecorded={saved}
    />,
  );
  expect(screen.getByLabelText('Public page URL')).toHaveProperty('readOnly', true);
  expect(document.body.textContent).toContain('Selected estate');
  expect(document.body.textContent).toContain('optional consent page');
  expect(document.body.textContent).toContain('five pages maximum');
  expect(document.body.textContent).toContain('No system or registered connector association');
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Audit public website' })).toHaveProperty(
      'disabled',
      false,
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Audit public website' }));
  await screen.findByRole('button', { name: 'Retry same check' });
  view.rerender(
    <PublicWebsiteClient
      tenantId="11111111-1111-4111-8111-111111111111"
      canManage
      context={{ ...recaptureContext, id: 'other', url: 'https://example.com/other' }}
      onRecorded={saved}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Retry same check' }));
  await screen.findByText(/Return to the original organisation, engagement/);
  expect(fetcher.mock.calls.filter(([, i]) => i?.method === 'POST')).toHaveLength(1);
  view.rerender(
    <PublicWebsiteClient
      tenantId="11111111-1111-4111-8111-111111111111"
      canManage
      context={recaptureContext}
      onRecorded={saved}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Retry same check' }));
  await waitFor(() => expect(saved).toHaveBeenCalledWith(contextualCheck));
  const posts = fetcher.mock.calls.filter(([, i]) => i?.method === 'POST');
  expect(posts[1]?.[1]).toEqual(posts[0]?.[1]);
  expect(posts[0]?.[1]?.body).toBe(JSON.stringify({ url: recaptureContext.url }));
});
it('blocks contextual capture behind source workflow prerequisites without sending a POST', async () => {
  const fetcher = vi.fn(async () => Response.json({ data: [] }));
  vi.stubGlobal('fetch', fetcher);
  render(
    <PublicWebsiteClient
      tenantId="11111111-1111-4111-8111-111111111111"
      canManage
      context={recaptureContext}
      disabledReason="Reconcile retained source request first."
    />,
  );
  const submit = screen.getByRole('button', { name: 'Audit public website' });
  expect(submit).toHaveProperty('disabled', true);
  fireEvent.submit(submit.closest('form')!);
  expect(fetcher.mock.calls).toHaveLength(1);
});

it('restores a contextual uncertain request across reload and keeps its key after an authorization refusal', async () => {
  const posted: RequestInit[] = [];
  let phase = 0;
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method !== 'POST') return Response.json({ data: [] });
    posted.push(init);
    phase++;
    if (phase === 1) throw new Error('lost reply');
    if (phase === 2) return Response.json({ error: { code: 'forbidden' } }, { status: 403 });
    return Response.json({ data: contextualCheck }, { status: 201 });
  });
  vi.stubGlobal('fetch', fetcher);
  const tenantId = '11111111-1111-4111-8111-111111111111';
  const saved = vi.fn();
  const first = render(
    <PublicWebsiteClient
      tenantId={tenantId}
      canManage
      context={recaptureContext}
      onRecorded={saved}
    />,
  );
  const audit = await screen.findByRole('button', { name: 'Audit public website' });
  await waitFor(() => expect(audit).toHaveProperty('disabled', false));
  fireEvent.click(audit);
  await screen.findByRole('button', { name: 'Retry same check' });
  first.unmount();
  render(
    <PublicWebsiteClient
      tenantId={tenantId}
      canManage
      context={recaptureContext}
      onRecorded={saved}
    />,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Retry same check' }));
  await screen.findByText(/The result is uncertain/);
  expect(saved).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Retry same check' }));
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(posted).toHaveLength(3);
  expect(posted[1]).toEqual(posted[0]);
  expect(posted[2]).toEqual(posted[0]);
});
it('never selects a saved result in another engagement', async () => {
  let resolve!: (value: Response) => void;
  const saved = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? new Promise<Response>((r) => {
            resolve = r;
          })
        : Promise.resolve(Response.json({ data: [] })),
    ),
  );
  const tenantId = '11111111-1111-4111-8111-111111111111';
  const view = render(
    <PublicWebsiteClient
      tenantId={tenantId}
      canManage
      context={recaptureContext}
      onRecorded={saved}
    />,
  );
  const audit = await screen.findByRole('button', { name: 'Audit public website' });
  await waitFor(() => expect(audit).toHaveProperty('disabled', false));
  fireEvent.click(audit);
  view.rerender(
    <PublicWebsiteClient
      tenantId={tenantId}
      canManage
      context={{ ...recaptureContext, id: 'different' }}
      onRecorded={saved}
    />,
  );
  await act(async () => resolve(Response.json({ data: contextualCheck }, { status: 201 })));
  expect(saved).not.toHaveBeenCalled();
});

it('keeps a confirmed save known when journal cleanup fails and reconciles without another POST', async () => {
  const tenantId = '11111111-1111-4111-8111-111111111111';
  const saved = vi.fn();
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) =>
    init?.method === 'POST'
      ? Response.json({ data: contextualCheck }, { status: 201 })
      : Response.json({ data: [] }),
  );
  vi.stubGlobal('fetch', fetcher);
  const remove = vi.spyOn(Storage.prototype, 'removeItem').mockImplementationOnce(() => {
    throw new Error('storage denied');
  });
  render(
    <PublicWebsiteClient
      tenantId={tenantId}
      canManage
      context={recaptureContext}
      onRecorded={saved}
    />,
  );
  const audit = screen.getByRole('button', { name: 'Audit public website' });
  await waitFor(() => expect(audit).toHaveProperty('disabled', false));
  fireEvent.click(audit);
  const reconcile = await screen.findByRole('button', { name: 'Reconcile saved capture storage' });
  expect(saved).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Retry same check' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Audit public website' })).toHaveProperty(
    'disabled',
    true,
  );
  remove.mockRestore();
  fireEvent.click(reconcile);
  await waitFor(() => expect(saved).toHaveBeenCalledExactlyOnceWith(contextualCheck));
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
});
it('does not call the original view after its capture resolves following unmount', async () => {
  let resolve!: (response: Response) => void;
  const saved = vi.fn();
  const tenantId = '11111111-1111-4111-8111-111111111111';
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? new Promise<Response>((r) => {
            resolve = r;
          })
        : Promise.resolve(Response.json({ data: [] })),
    ),
  );
  const view = render(
    <PublicWebsiteClient
      tenantId={tenantId}
      canManage
      context={recaptureContext}
      onRecorded={saved}
    />,
  );
  const audit = screen.getByRole('button', { name: 'Audit public website' });
  await waitFor(() => expect(audit).toHaveProperty('disabled', false));
  fireEvent.click(audit);
  view.unmount();
  await act(async () => resolve(Response.json({ data: contextualCheck }, { status: 201 })));
  expect(saved).not.toHaveBeenCalled();
});

it('retains the exact request when a valid-looking saved response belongs to a different submitted URL', async () => {
  const saved = vi.fn();
  let count = 0;
  const posted: RequestInit[] = [];
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method !== 'POST') return Response.json({ data: [] });
    posted.push(init);
    count++;
    return Response.json(
      {
        data:
          count === 1
            ? { ...contextualCheck, requestedUrl: 'https://other.org/' }
            : contextualCheck,
      },
      { status: 201 },
    );
  });
  vi.stubGlobal('fetch', fetcher);
  render(
    <PublicWebsiteClient
      tenantId="11111111-1111-4111-8111-111111111111"
      canManage
      context={recaptureContext}
      onRecorded={saved}
    />,
  );
  const audit = screen.getByRole('button', { name: 'Audit public website' });
  await waitFor(() => expect(audit).toHaveProperty('disabled', false));
  fireEvent.click(audit);
  await screen.findByRole('button', { name: 'Retry same check' });
  expect(saved).not.toHaveBeenCalled();
  const original = screen.getByLabelText('Original retained capture context');
  expect(original.textContent).toContain(recaptureContext.id);
  expect(original.textContent).toContain(recaptureContext.url);
  expect(original.querySelector('a')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry same check' }));
  await waitFor(() => expect(saved).toHaveBeenCalledExactlyOnceWith(contextualCheck));
  expect(posted[1]).toEqual(posted[0]);
});
it('reconciles a known save whose own entry cleared before remaining-journal validation failed without deleting another entry', async () => {
  const tenantId = '11111111-1111-4111-8111-111111111111';
  const saved = vi.fn();
  let posts = 0;
  const other = {
    tenantId,
    actorId: recaptureContext.actorId,
    contextId: recaptureContext.id,
    key: '44444444-4444-4444-8444-444444444444',
    url: recaptureContext.url,
    body: JSON.stringify({ url: recaptureContext.url }),
  };
  const otherKey = `axiom:public-recapture:v1:${tenantId}:${other.actorId}:${other.key}`;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return Response.json({ data: [] });
      posts++;
      if (posts === 1)
        localStorage.setItem(otherKey, JSON.stringify({ ...other, body: 'corrupted fixture' }));
      return Response.json({ data: contextualCheck }, { status: 201 });
    }),
  );
  render(
    <PublicWebsiteClient
      tenantId={tenantId}
      canManage
      context={recaptureContext}
      onRecorded={saved}
    />,
  );
  const audit = screen.getByRole('button', { name: 'Audit public website' });
  await waitFor(() => expect(audit).toHaveProperty('disabled', false));
  fireEvent.click(audit);
  const reconcile = await screen.findByRole('button', { name: 'Reconcile saved capture storage' });
  expect(saved).not.toHaveBeenCalled();
  expect(localStorage.getItem(otherKey)).toContain('corrupted fixture');
  // Repair only this test's synthetic competing record; reconciliation must
  // preserve that different operation and restore it rather than send new work.
  localStorage.setItem(otherKey, JSON.stringify(other));
  fireEvent.click(reconcile);
  await screen.findByRole('button', { name: 'Retry same check' });
  expect(posts).toBe(1);
  expect(saved).not.toHaveBeenCalled();
  expect(localStorage.getItem(otherKey)).toBe(JSON.stringify(other));
  fireEvent.click(screen.getByRole('button', { name: 'Retry same check' }));
  await waitFor(() => expect(saved).toHaveBeenCalledExactlyOnceWith(contextualCheck));
  expect(posts).toBe(2);
});

it('keeps recent check summary and Discovery link visible while raw facts start collapsed', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ data: [check] })));
  render(<PublicWebsiteClient tenantId="tenant-1" canManage={false} canOpenDiscovery />);
  const link = await screen.findByRole('link', { name: 'Review this saved website evidence' });
  expect(link.closest('details')).toBeNull();
  const summary = screen.getByText('Show retained HTML facts and hashes');
  const details = summary.closest('details');
  expect(details?.hasAttribute('open')).toBe(false);
  expect(details?.textContent).toContain(check.contentSha256);
  expect(details?.textContent).toContain('How we use data');
  expect(screen.getByText('Privacy').closest('details')).toBeNull();
  expect(screen.getByText(/Fetched/).closest('details')).toBeNull();
});
