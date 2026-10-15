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

it('retries an uncertain check with the same key and body, but clears a controlled refusal', async () => {
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
    expect(
      screen.getByText('That address does not resolve to a permitted public website.'),
    ).toBeTruthy(),
  );
  expect(fetcher.mock.calls[1]?.[1]?.headers['Idempotency-Key']).toBe(
    fetcher.mock.calls[2]?.[1]?.headers['Idempotency-Key'],
  );
  expect(fetcher.mock.calls[1]?.[1]?.body).toBe(fetcher.mock.calls[2]?.[1]?.body);
  expect(screen.getByRole('button', { name: 'Audit public website' })).toBeTruthy();
});

it('preserves an in-progress request key but releases a completed upstream failure', async () => {
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
    expect(
      screen.getByText(
        'The public website could not be retrieved. Check the address and try again.',
      ),
    ).toBeTruthy(),
  );
  expect(fetcher.mock.calls[2]?.[1]?.headers['Idempotency-Key']).toBe(firstKey);
  expect(screen.getByRole('button', { name: 'Audit public website' })).toBeTruthy();
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
