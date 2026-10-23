// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SetupWizard } from './setup-wizard';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('./sustenance', () => ({ DriftCard: () => <p>Recorded drift</p> }));
// MutationForm is intentionally real: these cases must exercise actual submit,
// random-source fallback, tenant headers and unknown-outcome behavior.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const readiness = {
  ready: false,
  checks: [],
  counts: {
    systems: 1,
    registeredConnectors: 0,
    manualSystems: 0,
    activeReadGrants: 0,
    activeWriteGrants: 0,
  },
};
const wizard = {
  id: '10000000-0000-4000-8000-000000000001',
  tenant_id: 'tenant-1',
  estate_id: 'estate-1',
  status: 'in_progress',
  completed_steps: ['company', 'estate', 'inventory'],
  manual_system_ids: [],
  version: 4,
  started_by: 'user-1',
  completed_by: null,
  completed_at: null,
  created_at: '2026-10-15T00:00:00Z',
  updated_at: '2026-10-15T00:00:00Z',
};
const base = {
  tenantId: 'tenant-1',
  canManage: true,
  profile: null,
  estates: [{ id: 'estate-1', name: 'Client Estate', status: 'active' as const }],
  systems: [
    {
      id: '20000000-0000-4000-8000-000000000002',
      estateId: 'estate-1',
      name: 'Payroll',
      active: true,
      declaredCategories: ['identity'],
      hasConnector: false,
    },
  ],
};

it('withholds stale step controls until a confirmed save reloads the current version', async () => {
  let saved = false;
  let releaseRead: (response: Response) => void = () => {
    throw new Error('Refresh was not requested');
  };
  const refreshed = new Promise<Response>((resolve) => {
    releaseRead = resolve;
  });
  const current = {
    ...wizard,
    version: 5,
    completed_steps: [...wizard.completed_steps, 'connectors'],
    manual_system_ids: [base.systems[0]!.id],
  };
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      saved = true;
      return Response.json({ data: current, readiness });
    }
    return saved ? refreshed : Response.json({ data: wizard, readiness });
  });
  vi.stubGlobal('fetch', fetcher);
  render(<SetupWizard {...base} />);
  fireEvent.click(await screen.findByLabelText(/Payroll: no connector/));
  fireEvent.click(screen.getByRole('button', { name: 'Record connection path' }));
  await screen.findByText('Loading onboarding progress…');
  expect(
    screen.queryByRole('button', { name: /Company profile|Estate|Record grant review/ }),
  ).toBeNull();
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  await act(async () => releaseRead(Response.json({ data: current, readiness })));
  fireEvent.click(await screen.findByLabelText('I have reviewed agent access for this estate'));
  fireEvent.click(screen.getByRole('button', { name: 'Record grant review' }));
  await waitFor(() => {
    const writes = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(writes).toHaveLength(2);
    expect(JSON.parse(String(writes[1]![1]?.body))).toMatchObject({
      step: 'grants',
      expectedVersion: 5,
      acknowledged: true,
    });
  });
});

it('starts the real wizard using getRandomValues on HTTP without randomUUID', async () => {
  const getRandomValues = vi.fn((bytes: Uint8Array) => {
    bytes.fill(19);
    return bytes;
  });
  vi.stubGlobal('crypto', { getRandomValues });
  let started = false;
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      started = true;
      return Response.json({ data: wizard, readiness });
    }
    return Response.json({ data: started ? wizard : null, readiness: started ? readiness : null });
  });
  vi.stubGlobal('fetch', fetcher);
  render(<SetupWizard {...base} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Start onboarding' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Record connection path' })).toBeTruthy(),
  );
  const writes = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(writes).toHaveLength(1);
  expect(writes[0]![0]).toBe('/api/bff/v1/onboarding/wizard');
  expect(JSON.parse(String(writes[0]![1]?.body))).toEqual({});
  expect(writes[0]![1]?.headers).toMatchObject({
    'X-Tenant-Id': 'tenant-1',
    'Idempotency-Key': expect.stringMatching(
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    ),
  });
  expect(getRandomValues).toHaveBeenCalledOnce();
});

it('records an explicit manual connection without registering a connector or issuing grants', async () => {
  const getRandomValues = vi.fn((bytes: Uint8Array) => {
    bytes.fill(29);
    return bytes;
  });
  vi.stubGlobal('crypto', { getRandomValues });
  let recorded = false;
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    const current = recorded
      ? {
          ...wizard,
          version: 5,
          completed_steps: [...wizard.completed_steps, 'connectors'],
          manual_system_ids: [base.systems[0]!.id],
        }
      : wizard;
    if (init?.method === 'POST') {
      recorded = true;
      return Response.json({ data: { ...current, version: 5 }, readiness });
    }
    return Response.json({ data: current, readiness });
  });
  vi.stubGlobal('fetch', fetcher);
  render(<SetupWizard {...base} />);
  const manual = await screen.findByLabelText(/Payroll: no connector/);
  expect((manual as HTMLInputElement).checked).toBe(false);
  fireEvent.click(manual);
  fireEvent.click(screen.getByRole('button', { name: 'Record connection path' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Record grant review' })).toBeTruthy(),
  );
  const writes = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(writes).toHaveLength(1);
  expect(writes[0]![0]).toBe(`/api/bff/v1/onboarding/wizard/${wizard.id}/steps`);
  expect(JSON.parse(String(writes[0]![1]?.body))).toEqual({
    step: 'connectors',
    expectedVersion: 4,
    manualSystemIds: [base.systems[0]!.id],
  });
  expect(writes[0]![1]?.headers).toMatchObject({
    'X-Tenant-Id': 'tenant-1',
    'Idempotency-Key': expect.any(String),
  });
  expect(fetcher.mock.calls.every(([url]) => url.includes('/onboarding/wizard'))).toBe(true);
  expect(getRandomValues).toHaveBeenCalledOnce();
});
