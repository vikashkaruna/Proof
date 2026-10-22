// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AuthenticatedWebsitePanel } from './authenticated-website-panel';

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
const id = (n: number) => `79790000-0000-4000-8000-${String(n).padStart(12, '0')}`;
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const row = {
  id: id(3),
  status: 'checked',
  errorCode: null,
  checkedAt: '2026-10-22T11:00:00.000Z',
  pagesRead: 7,
  pagesSkipped: 3,
};

it('runs a signed-in check with only an operation key and shows the recorded outcome', async () => {
  const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
    init?.method === 'POST'
      ? Response.json({ data: { status: 'checked', errorCode: null, checkId: id(3) } })
      : Response.json({ data: [row], available: true }),
  );
  vi.stubGlobal('fetch', fetch);
  render(<AuthenticatedWebsitePanel tenantId={id(1)} connectorId={id(2)} canManage />);
  expect(await screen.findByText(/7 pages read, 3 not opened/)).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Run signed-in check' }));
  await screen.findByText(/Signed-in check saved/);
  const post = fetch.mock.calls.find(([, init]) => init?.method === 'POST')!;
  expect(Object.keys(JSON.parse(String(post[1]?.body)))).toEqual(['operationKey']);
  expect(screen.getByRole('link', { name: 'Open scan report' }).getAttribute('href')).toBe(
    `/connectors/${id(2)}/scan-report`,
  );
});

it('explains a refused sign-in and hides the run button when not configured', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === 'POST'
        ? Response.json({ data: { status: 'failed', errorCode: 'login_failed' } }, { status: 422 })
        : Response.json({ data: [], available: true }),
    ),
  );
  render(<AuthenticatedWebsitePanel tenantId={id(1)} connectorId={id(2)} canManage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Run signed-in check' }));
  expect(await screen.findByText(/Sign-in was refused/)).toBeDefined();
  cleanup();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ data: [], available: false })),
  );
  render(<AuthenticatedWebsitePanel tenantId={id(1)} connectorId={id(2)} canManage />);
  expect(await screen.findByText(/not configured for signed-in checks/)).toBeDefined();
  expect(screen.queryByRole('button', { name: 'Run signed-in check' })).toBeNull();
});
