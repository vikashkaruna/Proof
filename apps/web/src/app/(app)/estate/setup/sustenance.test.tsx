// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DriftCard, GrantReview, ToolRegistry } from './sustenance';

vi.mock('../estate-client', () => ({
  MutationForm: ({ label, children }: { label: string; children: React.ReactNode }) => (
    <form>
      {children}
      <button type="button">{label}</button>
    </form>
  ),
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const respond = (data: unknown) => Response.json({ data });

it('refuses to call estate drift current when the BFF cannot calculate it', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
  render(<DriftCard tenantId="tenant-1" estateId="estate-1" />);
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toContain('could not be checked'),
  );
  expect(screen.queryByText('No changes since the last onboarding.')).toBeNull();
});

it('refuses a malformed 200 drift body rather than claiming the estate is current', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(Response.json({ data: { status: 'current', added: 'unknown' } })),
  );
  render(<DriftCard tenantId="tenant-1" estateId="estate-1" />);
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toContain('could not be checked'),
  );
  expect(screen.queryByText('No changes since the last onboarding.')).toBeNull();
});

it('names the exact added, removed, changed and disconnected systems in a drifted estate', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      respond({
        status: 'drifted',
        added: [{ id: 'a', name: 'New datastore' }],
        removed: [{ id: 'b', name: 'Archived queue' }],
        changed: [{ id: 'c', name: 'Changed CRM' }],
        connectionLost: [{ id: 'd', name: 'Offline connector' }],
      }),
    ),
  );
  render(<DriftCard tenantId="tenant-1" estateId="estate-1" />);
  await waitFor(() => expect(screen.getByTestId('drift-status').textContent).toContain('changed'));
  for (const name of ['New datastore', 'Archived queue', 'Changed CRM', 'Offline connector'])
    expect(document.body.textContent).toContain(name);
  expect(document.body.textContent).not.toContain('No changes since the last onboarding');
});

it('hides grant mutation controls from a reviewer while showing overdue authority facts', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      respond([
        {
          id: 'grant-1',
          agentName: 'karya',
          scope: 'connector.write',
          connectorName: 'Payroll',
          overdue: true,
          dueAt: '2026-09-30T00:00:00Z',
          expiresAt: '2026-10-30T00:00:00Z',
        },
      ]),
    ),
  );
  render(
    <GrantReview
      tenantId="tenant-1"
      canManage={false}
      targets={{ connectors: [], workloads: [] }}
    />,
  );
  await waitFor(() => expect(screen.getByTestId('grant-grant-1')).toBeTruthy());
  expect(screen.getByTestId('grant-grant-1').textContent).toContain('overdue since');
  expect(screen.queryByText('Issue agent access')).toBeNull();
  expect(screen.queryByText('Revoke access')).toBeNull();
});

it('refuses an unreadable grant queue rather than claiming there are no active grants', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ data: [{ id: 'grant-1' }] })));
  render(
    <GrantReview
      tenantId="tenant-1"
      canManage={false}
      targets={{ connectors: [], workloads: [] }}
    />,
  );
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toContain('Agent grants could not be loaded'),
  );
  expect(screen.queryByText('No active agent grants to review.')).toBeNull();
});

it('requires connector and workload identities before offering agent access creation', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond([])));
  render(<GrantReview tenantId="tenant-1" canManage targets={{ connectors: [], workloads: [] }} />);
  await waitFor(() => expect(screen.getByText('No active agent grants to review.')).toBeTruthy());
  expect(document.body.textContent).toContain('Issuing access needs an enabled connector');
  expect(screen.queryByText('Issue access')).toBeNull();
});

it('does not invent registered tools when no connector exists', () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  render(<ToolRegistry tenantId="tenant-1" canManage connectors={[]} />);
  expect(
    screen.getByText('No active connectors. Register a connector before its tools.'),
  ).toBeTruthy();
  expect(fetcher).not.toHaveBeenCalled();
});

it('shows pinned tool versions but gives a viewer no register control', async () => {
  const fetcher = vi.fn().mockResolvedValue(
    respond([
      {
        id: 'tool-1',
        tool_name: 'read-table',
        tool_version: '1.0',
        operation_class: 'read',
        description_sha256: 'a'.repeat(64),
        created_at: '2026-09-30T00:00:00Z',
      },
    ]),
  );
  vi.stubGlobal('fetch', fetcher);
  render(
    <ToolRegistry
      tenantId="tenant-1"
      canManage={false}
      connectors={[{ id: 'connector-1', name: 'Payroll' }]}
    />,
  );
  await waitFor(() => expect(screen.getByText('read-table@1.0')).toBeTruthy());
  expect(screen.queryByText('Register a tool version')).toBeNull();
  expect(fetcher.mock.calls[0]![0]).toBe('/api/bff/v1/connectors/connector-1/tools');
});

it('refuses malformed tool metadata rather than showing an empty registry', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(Response.json({ data: [{ id: 'tool-1', tool_name: 'read-table' }] })),
  );
  render(
    <ToolRegistry
      tenantId="tenant-1"
      canManage={false}
      connectors={[{ id: 'connector-1', name: 'Payroll' }]}
    />,
  );
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toContain('Tools could not be loaded'),
  );
  expect(screen.queryByText('No tools registered for this connector.')).toBeNull();
});

it('hides a prior tenant connector and its tools while the next tenant loads', async () => {
  let finishNext: ((response: Response) => void) | undefined;
  const pending = new Promise<Response>((resolve) => {
    finishNext = resolve;
  });
  const fetcher = vi.fn().mockImplementation((url: string) =>
    url.includes('connector-1')
      ? Promise.resolve(
          respond([
            {
              id: 'tool-1',
              tool_name: 'private-tool',
              tool_version: '1.0',
              operation_class: 'read',
              description_sha256: 'a'.repeat(64),
            },
          ]),
        )
      : pending,
  );
  vi.stubGlobal('fetch', fetcher);
  const view = render(
    <ToolRegistry
      tenantId="tenant-1"
      canManage={false}
      connectors={[{ id: 'connector-1', name: 'First tenant' }]}
    />,
  );
  await waitFor(() => expect(screen.getByText('private-tool@1.0')).toBeTruthy());
  view.rerender(
    <ToolRegistry
      tenantId="tenant-2"
      canManage={false}
      connectors={[{ id: 'connector-2', name: 'Second tenant' }]}
    />,
  );
  expect(
    (screen.getByRole('combobox', { name: 'Tool connector' }) as HTMLSelectElement).value,
  ).toBe('connector-2');
  expect(screen.queryByText('private-tool@1.0')).toBeNull();
  expect(screen.getByText('Loading tools…')).toBeTruthy();
  await waitFor(() =>
    expect(
      fetcher.mock.calls.some(
        ([url, init]) => url.includes('connector-2') && init.headers['X-Tenant-Id'] === 'tenant-2',
      ),
    ).toBe(true),
  );
  finishNext?.(respond([]));
  await waitFor(() =>
    expect(screen.getByText('No tools registered for this connector.')).toBeTruthy(),
  );
});
