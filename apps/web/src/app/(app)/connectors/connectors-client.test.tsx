// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ConnectorsClient, type ConnectorRow, type ConnectorSystem } from './connectors-client';

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('../estate/estate-client', () => ({
  MutationForm: ({ label, children }: { label: string; children: React.ReactNode }) => (
    <form aria-label={label}>{children}</form>
  ),
}));
const system: ConnectorSystem = {
  id: 'system-1',
  name: 'Payroll',
  status: 'active',
  estates: { name: 'Registered estate', status: 'active' },
};
const connector: ConnectorRow = {
  id: 'connector-1',
  system_id: system.id,
  name: 'Payroll access',
  endpoint_ref: 'payroll_ref',
  descriptor_id: 'descriptor-1',
  target_binding: 'staging',
  assurance: 'reviewed',
  status: 'draft',
  version: 1,
  connector_health_checks: [],
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('hides registration mutations for read-only users and does not infer connector health', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ data: [] })));
  render(
    <ConnectorsClient
      tenantId="tenant-1"
      canManage={false}
      systems={[system]}
      connectors={[connector]}
    />,
  );
  await waitFor(() => expect(screen.getByText('Health: Not checked')).toBeTruthy());
  expect(screen.getByText(/Non-production; writes prohibited/)).toBeTruthy();
  expect(screen.queryByRole('form', { name: 'Register connector' })).toBeNull();
  expect(screen.queryByRole('form', { name: 'Enable registration' })).toBeNull();
  expect(screen.queryByRole('form', { name: 'Disable registration' })).toBeNull();
});

it('refuses registration when no active parent system or catalogue exists', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ data: { invalid: true } })));
  render(
    <ConnectorsClient
      tenantId="tenant-1"
      canManage
      systems={[{ ...system, status: 'disabled' }]}
      connectors={[]}
    />,
  );
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toContain('catalogue could not be loaded'),
  );
  expect(
    screen.getByText('Add an active estate system before registering a connector.'),
  ).toBeTruthy();
  expect(screen.queryByRole('form', { name: 'Create registration' })).toBeNull();
});

it('shows recorded disabled registration controls without an execution-access claim', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ data: [] }));
  vi.stubGlobal('fetch', fetcher);
  render(
    <ConnectorsClient
      tenantId="tenant-1"
      canManage
      systems={[system]}
      connectors={[{ ...connector, status: 'disabled' }]}
    />,
  );
  await waitFor(() => expect(fetcher).toHaveBeenCalled());
  expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ 'X-Tenant-Id': 'tenant-1' });
  expect(screen.getByRole('form', { name: 'Save registration' })).toBeTruthy();
  expect(screen.getByRole('form', { name: 'Archive registration' })).toBeTruthy();
  expect(screen.queryByRole('form', { name: 'Enable registration' })).toBeNull();
  expect(document.body.textContent).not.toContain('Live access granted');
});

it('shows reviewed options even before an estate system exists and distinguishes reference from production', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      Response.json({
        data: [
          {
            schemaVersion: 1,
            id: '41410000-0000-4000-8000-000000000002',
            target: 'postgresql',
            version: '1.0.0',
            transport: 'sql',
            targetBinding: 'reference-mock',
            auth: 'cloud_iam',
            assurance: 'high',
            capabilities: { enumerate: { operation: 'sql.enumerate', mutating: false } },
            dataCategoryHints: [],
            rateLimit: { requestsPerSecond: 5, burst: 10 },
          },
        ],
      }),
    ),
  );
  render(<ConnectorsClient tenantId="tenant-1" canManage systems={[]} connectors={[]} />);
  await waitFor(() =>
    expect(
      screen.getByRole('region', { name: 'Available connector options' }).textContent,
    ).toContain('postgresql'),
  );
  expect(screen.getByText('Reference only', { exact: false })).toBeTruthy();
  expect(
    screen.getByText('Add an active estate system before registering a connector.'),
  ).toBeTruthy();
  expect(
    screen.getByRole('link', { name: 'review agent access in estate setup' }).getAttribute('href'),
  ).toBe('/estate/setup');
});

it('refreshes saved readiness without treating a prior observation as a live check', async () => {
  const liveConnector = { ...connector, id: '11111111-1111-4111-8111-111111111111' };
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ data: [] }))
    .mockResolvedValueOnce(
      Response.json({
        data: {
          connectorId: liveConnector.id,
          registrationStatus: 'draft',
          credentialConfigured: false,
          readGrantConfigured: false,
          lastObservation: {
            status: 'healthy',
            checked_at: '2026-10-03T12:00:00Z',
            error_code: null,
          },
          liveCheckAvailable: false,
        },
      }),
    );
  vi.stubGlobal('fetch', fetcher);
  render(
    <ConnectorsClient
      tenantId="tenant-1"
      canManage={false}
      systems={[system]}
      connectors={[liveConnector]}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Check setup status' }));
  await waitFor(() =>
    expect(screen.getByRole('list', { name: 'Connection setup checks' }).textContent).toContain(
      'Broker credential: not configured',
    ),
  );
  expect(
    screen.getByText('A live connection test is not available from this screen', { exact: false }),
  ).toBeTruthy();
  expect(fetcher.mock.calls[1]?.[0]).toBe(`/api/bff/v1/connectors/${liveConnector.id}/readiness`);
  expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
    cache: 'no-store',
    headers: { 'X-Tenant-Id': 'tenant-1' },
  });
});
