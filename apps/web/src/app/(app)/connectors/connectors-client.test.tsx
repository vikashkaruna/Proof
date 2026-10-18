// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ConnectorsClient, type ConnectorRow, type ConnectorSystem } from './connectors-client';

const { registrationRequests } = vi.hoisted(() => ({ registrationRequests: vi.fn() }));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('../estate/estate-client', () => ({
  MutationForm: ({
    label,
    children,
    tenantId,
    path,
    method,
    body,
  }: {
    label: string;
    children: React.ReactNode;
    tenantId: string;
    path: string;
    method: string;
    body: (form: FormData) => unknown;
  }) => (
    <form
      aria-label={label}
      onSubmit={(event) => {
        event.preventDefault();
        registrationRequests({
          tenantId,
          path,
          method,
          body: body(new FormData(event.currentTarget)),
        });
      }}
    >
      {children}
    </form>
  ),
}));
vi.mock('./public-website-client', () => ({
  PublicWebsiteClient: () => <section aria-label="Public website content check" />,
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
const referenceDescriptor = {
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
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  registrationRequests.mockClear();
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
        data: [referenceDescriptor],
        executionAvailable: false,
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
  expect(screen.getByText('Reference descriptor; not proof of vendor connectivity')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Open public website audit' }).getAttribute('href')).toBe(
    '#public-website-check',
  );
  expect(
    screen.getByText('Add an active estate system before registering a connector.'),
  ).toBeTruthy();
  expect(
    screen.getByRole('link', { name: 'Continue with manual evidence' }).getAttribute('href'),
  ).toBe('/estate/setup');
});

it('offers manual evidence without requiring a connector, estate system or management permission', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(Response.json({ data: [], executionAvailable: false })),
  );
  render(<ConnectorsClient tenantId="tenant-1" canManage={false} systems={[]} connectors={[]} />);
  await waitFor(() =>
    expect(screen.getByText('No reviewed connector options are available.')).toBeTruthy(),
  );
  const setup = screen.getByRole('region', { name: 'Connection setup' });
  expect(setup.textContent).toContain('Finish the company profile, estate and system inventory');
  expect(setup.textContent).toContain(
    'Connection path step, mark unconnected systems “assess manually”',
  );
  expect(setup.textContent).toContain('You can continue without registering a private connector.');
  expect(
    screen.getByRole('link', { name: 'Continue with manual evidence' }).getAttribute('href'),
  ).toBe('/estate/setup');
  expect(screen.queryByRole('form', { name: 'Create registration' })).toBeNull();
  expect(registrationRequests).not.toHaveBeenCalled();
});

it('labels production descriptors and enabled registrations as setup records rather than connected systems', async () => {
  const productionDescriptor = { ...referenceDescriptor, targetBinding: 'production' };
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        Response.json({ data: [productionDescriptor], executionAvailable: false }),
      ),
  );
  render(
    <ConnectorsClient
      tenantId="tenant-1"
      canManage={false}
      systems={[system]}
      connectors={[
        {
          ...connector,
          status: 'active',
          target_binding: 'production',
          descriptor_id: referenceDescriptor.id,
        },
      ]}
    />,
  );
  await waitFor(() =>
    expect(
      screen.getByText('Production descriptor · registration only', { exact: false }),
    ).toBeTruthy(),
  );
  expect(
    screen.getByText(
      /Reviewed local PostgreSQL sandbox discovery appears on eligible registrations when configured/,
    ),
  ).toBeTruthy();
  expect(
    screen.getByText('A setup record only; live connectivity is not available in this deployment.'),
  ).toBeTruthy();
  expect(
    screen.getByText(/An enabled registration does not establish live connectivity/),
  ).toBeTruthy();
  expect(screen.queryByRole('form', { name: 'Enable registration' })).toBeNull();
  expect(screen.queryByRole('form', { name: 'Create registration' })).toBeNull();
});

it('keeps the authorized registration payload non-secret and preserves lifecycle request scope', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(Response.json({ data: [referenceDescriptor], executionAvailable: false })),
  );
  render(
    <ConnectorsClient
      tenantId="tenant-1"
      canManage
      systems={[system]}
      connectors={[{ ...connector, descriptor_id: referenceDescriptor.id }]}
    />,
  );
  const form = await screen.findByRole('form', { name: 'Create registration' });
  fireEvent.change(form.querySelector('[name="name"]')!, {
    target: { value: 'Payroll reference' },
  });
  fireEvent.change(form.querySelector('[name="endpointRef"]')!, {
    target: { value: 'primary_crm' },
  });
  fireEvent.submit(form);
  expect(registrationRequests).toHaveBeenCalledWith({
    tenantId: 'tenant-1',
    path: '/connectors',
    method: 'POST',
    body: {
      systemId: system.id,
      descriptorId: referenceDescriptor.id,
      name: 'Payroll reference',
      endpointRef: 'primary_crm',
    },
  });
  expect(form.querySelector('[name="endpointRef"]')?.getAttribute('pattern')).toBe(
    '[a-z][a-z0-9_\\-]{0,79}',
  );
  expect(form.querySelector('[type="password"], [type="url"]')).toBeNull();
  fireEvent.submit(screen.getByRole('form', { name: 'Enable registration' }));
  expect(registrationRequests).toHaveBeenLastCalledWith({
    tenantId: 'tenant-1',
    path: `/connectors/${connector.id}`,
    method: 'PATCH',
    body: { operation: 'transition', expectedVersion: connector.version, status: 'active' },
  });
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
