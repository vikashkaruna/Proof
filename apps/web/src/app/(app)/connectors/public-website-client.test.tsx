// @vitest-environment jsdom
import React from 'react';
import { renderToString } from 'react-dom/server';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PublicWebsiteClient } from './public-website-client';

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
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('does not expose an active submit button before hydration', () => {
  const html = renderToString(<PublicWebsiteClient tenantId="tenant-1" canManage />);
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Check public content<\/button>/);
});

it('lets viewers inspect recorded public content without a check action or unsafe external link', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ data: [check] }));
  vi.stubGlobal('fetch', fetcher);
  render(<PublicWebsiteClient tenantId="tenant-1" canManage={false} />);
  await waitFor(() => expect(screen.getByText('How we use data')).toBeTruthy());
  expect(screen.getByText(/Contact: https:\/\/example.com\/contact/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Check public content' })).toBeNull();
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
    .mockResolvedValueOnce(Response.json({ data: check }, { status: 201 }));
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
  fireEvent.click(screen.getByRole('button', { name: 'Check public content' }));
  await waitFor(() => expect(screen.getByText('How we use data')).toBeTruthy());
  expect(screen.getByText('Public content retrieved and recorded.')).toBeTruthy();
  expect(screen.getByText(/This inventories static content/)).toBeTruthy();
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
  fireEvent.click(screen.getByRole('button', { name: 'Check public content' }));
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
  expect(screen.getByRole('button', { name: 'Check public content' })).toBeTruthy();
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
  fireEvent.click(screen.getByRole('button', { name: 'Check public content' }));
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
  expect(screen.getByRole('button', { name: 'Check public content' })).toBeTruthy();
});
