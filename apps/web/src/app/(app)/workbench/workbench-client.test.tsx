// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AgentWorkbenchClient } from './workbench-client';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@/lib/invoke-agent', () => ({
  invokeAgent: invoke,
  AgentInvocationError: class AgentInvocationError extends Error {},
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
const props = {
  userEmail: 'operator@example.com',
  ledgerTodayCount: null,
  awaitingReviewCount: null,
  recentRuns: [],
  pendingPlans: [],
  dataResidencyRegion: 'configured-target',
  environment: 'local',
  loadError: true,
};
beforeEach(() => invoke.mockReset());
afterEach(cleanup);

it('shows unavailable metrics without fictional health, redaction, or reconciled plans', () => {
  render(<AgentWorkbenchClient {...props} />);
  expect(screen.getByTestId('workbench-ledger-today').textContent).toBe('Unavailable');
  expect(screen.getByTestId('workbench-awaiting-review').textContent).toBe('Unavailable');
  expect(document.body.textContent).toContain(
    'This does not establish that all plans are reconciled',
  );
  expect(document.body.textContent).not.toContain('PII Redaction: Enforced');
  expect(document.body.textContent).not.toContain('All remediation plans are reconciled');
  expect(document.body.textContent).toContain('configured region target');
  expect(document.body.textContent).not.toContain('Gateway Guard:');
});

it('distinguishes unreadable ledger and plan lists from real empty lists', () => {
  render(<AgentWorkbenchClient {...props} recentRuns={null} pendingPlans={null} />);
  expect(screen.getByText('Recent ledger activity is unavailable.')).toBeTruthy();
  expect(screen.getByText('Review plans are unavailable.')).toBeTruthy();
  expect(document.body.textContent).not.toContain('0 plans awaiting review.');
});

it('routes approval and unavailable regulatory feeds to dedicated workflows', () => {
  render(<AgentWorkbenchClient {...props} />);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'karya' } });
  expect(screen.getByRole('link', { name: 'Open karya workflow' }).getAttribute('href')).toBe(
    '/approval',
  );
  expect(screen.queryByRole('button', { name: 'Run karya' })).toBeNull();
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'nazar' } });
  expect(screen.getByRole('link', { name: 'Open nazar workflow' }).getAttribute('href')).toBe(
    '/regwatch',
  );
  expect(screen.queryByRole('button', { name: 'Run nazar' })).toBeNull();
  expect(invoke).not.toHaveBeenCalled();
});

it('invokes a supported read-only agent and shows only returned proof references', async () => {
  invoke.mockResolvedValue({ status: 'succeeded', latency_ms: 23, ledger_entry_ids: ['ledger-1'] });
  render(<AgentWorkbenchClient {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Run drishti' }));
  await waitFor(() =>
    expect(screen.getByRole('status').textContent).toContain('Execution completed'),
  );
  expect(invoke).toHaveBeenCalledWith('drishti', { scope: 'workbench' });
  expect(screen.getByRole('link', { name: /Ledger entry #ledger-1/ }).getAttribute('href')).toBe(
    '/ledger?q=ledger-1',
  );
});
