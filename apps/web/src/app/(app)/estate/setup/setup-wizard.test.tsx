// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SetupWizard } from './setup-wizard';

vi.mock('../estate-client', () => ({
  MutationForm: ({ label, children }: { label: string; children: React.ReactNode }) => (
    <form>
      {children}
      <button type="button">{label}</button>
    </form>
  ),
}));
vi.mock('./sustenance', () => ({ DriftCard: () => <p>Recorded drift</p> }));
const wizard = {
  id: 'wizard-1',
  tenant_id: 'tenant-1',
  estate_id: 'estate-1',
  status: 'in_progress',
  completed_steps: ['company', 'estate'],
  manual_system_ids: [],
  version: 3,
  started_by: 'user-1',
  completed_by: null,
  completed_at: null,
  created_at: '2026-09-30T00:00:00Z',
  updated_at: '2026-09-30T00:00:00Z',
};
const readiness = {
  ready: false,
  checks: [{ key: 'systems_declared', ok: false }],
  counts: {
    systems: 0,
    registeredConnectors: 0,
    manualSystems: 0,
    activeReadGrants: 0,
    activeWriteGrants: 0,
  },
};
const base = { tenantId: 'tenant-1', canManage: false, profile: null, estates: [], systems: [] };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('reports unavailable progress as an error instead of guessing a completed run', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
  render(<SetupWizard {...base} />);
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('unavailable'));
  expect(screen.queryByText('Start onboarding')).toBeNull();
});

it('refuses a malformed successful wizard read rather than offering a new run', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({})));
  render(<SetupWizard {...base} canManage />);
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('unavailable'));
  expect(screen.queryByText('Start onboarding')).toBeNull();
});

it('refuses an unknown wizard status and incomplete readiness totals', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(Response.json({ data: { ...wizard, status: 'verified' }, readiness })),
  );
  const view = render(<SetupWizard {...base} canManage />);
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('unavailable'));
  expect(screen.queryByText('Start re-onboarding')).toBeNull();
  view.unmount();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(Response.json({ data: wizard, readiness: { checks: [] } })),
  );
  render(<SetupWizard {...base} canManage />);
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('unavailable'));
});

it('shows no-run state and exposes start only to a manager', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ data: null, readiness: null })));
  const view = render(<SetupWizard {...base} />);
  await waitFor(() => expect(screen.getByText('No onboarding run has been started.')).toBeTruthy());
  view.rerender(<SetupWizard {...base} canManage />);
  expect(screen.getByText('Start onboarding')).toBeTruthy();
});

it('locks incomplete future steps and refuses to invent a system inventory', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ data: wizard, readiness })));
  render(<SetupWizard {...base} canManage />);
  await waitFor(() => expect(screen.getByTestId('setup-wizard')).toBeTruthy());
  expect(screen.getByText('No active systems are declared in this estate yet.')).toBeTruthy();
  expect(screen.getByRole('button', { name: /Connection path/ }).hasAttribute('disabled')).toBe(
    true,
  );
  expect(screen.getByTestId('readiness-checks').textContent).toContain(
    'At least one active system is declared',
  );
  fireEvent.click(screen.getByRole('button', { name: /Company profile/ }));
  expect(screen.getByText('Save company profile')).toBeTruthy();
});

it('renders a completed run as a saved snapshot and does not offer advance controls to viewers', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      Response.json({
        data: {
          ...wizard,
          status: 'completed',
          completed_at: '2026-09-30T00:00:00Z',
          completed_steps: ['company', 'estate', 'inventory', 'connectors', 'grants', 'readiness'],
        },
        readiness: { ...readiness, ready: true },
      }),
    ),
  );
  render(<SetupWizard {...base} />);
  await waitFor(() =>
    expect(screen.getByTestId('setup-complete').textContent).toContain('readiness snapshot'),
  );
  expect(screen.getByText('Recorded drift')).toBeTruthy();
  expect(screen.queryByText('Start re-onboarding')).toBeNull();
});

it('offers a manual connection path only for the saved estate systems', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      Response.json({
        data: {
          ...wizard,
          completed_steps: ['company', 'estate', 'inventory'],
          manual_system_ids: ['system-1'],
        },
        readiness,
      }),
    ),
  );
  render(
    <SetupWizard
      {...base}
      canManage
      estates={[{ id: 'estate-1', name: 'Saved estate', status: 'active' }]}
      systems={[
        {
          id: 'system-1',
          estateId: 'estate-1',
          name: 'Payroll',
          active: true,
          declaredCategories: ['identity'],
          hasConnector: false,
        },
        {
          id: 'system-2',
          estateId: 'other-estate',
          name: 'Other tenant system',
          active: true,
          declaredCategories: [],
          hasConnector: true,
        },
      ]}
    />,
  );
  await waitFor(() => expect(screen.getByText('Record connection path')).toBeTruthy());
  expect(screen.getByText(/Payroll: no connector/)).toBeTruthy();
  expect(screen.getByLabelText(/Payroll: no connector/).getAttribute('type')).toBe('checkbox');
  expect((screen.getByLabelText(/Payroll: no connector/) as HTMLInputElement).checked).toBe(true);
  expect(document.body.textContent).not.toContain('Other tenant system');
  expect(document.body.textContent).toContain('not evidence of a live connection');
});

it('shows recorded grant counts but requires a separate human grant review', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      Response.json({
        data: {
          ...wizard,
          completed_steps: ['company', 'estate', 'inventory', 'connectors'],
        },
        readiness: {
          ...readiness,
          counts: { ...readiness.counts, activeReadGrants: 1, activeWriteGrants: 0 },
        },
      }),
    ),
  );
  render(<SetupWizard {...base} canManage />);
  await waitFor(() => expect(screen.getByText('Record grant review')).toBeTruthy());
  expect(screen.getByTestId('grant-counts').textContent).toContain('1 read, 0 write');
  expect(
    screen.getByLabelText('I have reviewed agent access for this estate').getAttribute('required'),
  ).not.toBeNull();
  expect(document.body.textContent).toContain('This wizard never issues grants');
});
