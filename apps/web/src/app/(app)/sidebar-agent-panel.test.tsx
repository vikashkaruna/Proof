// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ALL_AGENTS, SidebarAgentPanel } from './sidebar-agent-panel';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock('@/lib/invoke-agent', async (importOriginal) => ({ ...await importOriginal<typeof import('@/lib/invoke-agent')>(), invokeAgent: mocks.invoke }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); mocks.invoke.mockReset(); mocks.refresh.mockReset(); });

it('does not offer a fictional regulatory feed scan or an enforcement countdown', async () => {
  const nazar = ALL_AGENTS.find((agent) => agent.name === 'nazar');
  expect(nazar?.description).toContain('unavailable');
  expect(nazar?.statutoryBoundary).not.toContain('13 May 2027');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ active_runs: [] })));
  render(<SidebarAgentPanel />);
  await waitFor(() => expect(screen.getByText('No active agent runs reported')).toBeTruthy());
  expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /nazar/i }));
  expect(screen.getByRole('link', { name: /Open Regulatory Watch/ }).getAttribute('href')).toBe('/regwatch');
  expect(screen.queryByRole('button', { name: /Scan Regulatory Feeds/ })).toBeNull();
});

it('routes source-bound and approval-gated agents to dedicated workflows', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ active_runs: [] }));
  vi.stubGlobal('fetch', fetcher);
  render(<SidebarAgentPanel />);
  await waitFor(() => expect(screen.getByText('No active agent runs reported')).toBeTruthy());
  for (const [name, path] of [
    ['parikshan', '/assessment'], ['saakshi', '/evidence'], ['karya', '/approval'],
    ['prativedan', '/reports'], ['sanket', '/breaches'], ['samadhan', '/execution'],
    ['pramaan', '/reports'],
  ] as const) {
    const label = ALL_AGENTS.find((agent) => agent.name === name)?.actionLabel;
    if (!label) throw new Error(`Missing agent fixture ${name}`);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(name, 'i') }));
    expect(screen.getByRole('link', { name: new RegExp(label) }).getAttribute('href')).toBe(path);
  }
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('marks unreadable agent-run status unavailable instead of claiming no active runs', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
  render(<SidebarAgentPanel />);
  await waitFor(() => expect(screen.getByText('Agent-run status unavailable')).toBeTruthy());
  expect(document.body.textContent).not.toContain('No active agent runs reported');
  fireEvent.click(screen.getByRole('button', { name: /drishti/i }));
  expect(document.body.textContent).toContain('State: unavailable');
});

it('accepts active state only from a well-formed run list', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ active_runs: [{ agent: 'drishti', status: 'running' }] })));
  const view = render(<SidebarAgentPanel />);
  await waitFor(() => expect(screen.getByText('1 agent run(s) reported active')).toBeTruthy());
  expect(screen.getByRole('button', { name: /drishti/i }).title).toContain('Status: working');
  view.unmount();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ active_runs: null })));
  render(<SidebarAgentPanel />);
  await waitFor(() => expect(screen.getByText('Agent-run status unavailable')).toBeTruthy());
});

it('counts recorded runs separately from distinct agent names', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ active_runs: [
    { agent: 'drishti', status: 'running' }, { agent: 'drishti', status: 'queued' }, { agent: 'vibhaag', status: 'running' },
  ] })));
  render(<SidebarAgentPanel />);
  await waitFor(() => expect(screen.getByText('3 agent run(s) reported active')).toBeTruthy());
  expect(screen.getByRole('button', { name: /drishti/i }).title).toContain('Status: working');
  expect(screen.getByRole('button', { name: /vibhaag/i }).title).toContain('Status: working');
  expect(screen.getByRole('button', { name: /parikshan/i }).title).toContain('Status: idle');
});

it('retracts a previously active run when the next status poll is unreadable', async () => {
  let poll: (() => void) | null = null;
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  vi.stubGlobal('setInterval', vi.fn((handler: () => void, interval: number) => {
    if (interval === 4000) { poll = handler; return 1; }
    return realSetInterval(handler, interval);
  }));
  vi.stubGlobal('clearInterval', vi.fn((id: number) => { if (id !== 1) realClearInterval(id); }));
  let reads = 0;
  vi.stubGlobal('fetch', vi.fn(async () => {
    reads++;
    return reads === 1
      ? Response.json({ active_runs: [{ agent: 'drishti', status: 'running' }] })
      : new Response(null, { status: 503 });
  }));
  render(<SidebarAgentPanel />);
  await waitFor(() => expect(screen.getByText('1 agent run(s) reported active')).toBeTruthy());
  expect(poll).not.toBeNull();
  await act(async () => { poll?.(); });
  await waitFor(() => expect(screen.getByText('Agent-run status unavailable')).toBeTruthy());
  expect(document.body.textContent).not.toContain('1 agent run(s) reported active');
  expect(screen.getByRole('button', { name: /drishti/i }).title).toContain('Status: unavailable');
});

it.each([
  { agent_name: 'drishti', status: 'running' },
  { agent: 'drishti', status: 'succeeded' },
])('refuses a nonempty response outside the persisted active-run contract (%j)', async (row) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ active_runs: [row] })));
  render(<SidebarAgentPanel />);
  await waitFor(() => expect(screen.getByText('Agent-run status unavailable')).toBeTruthy());
});

it('shows ledger proof only after a confirmed direct invocation', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ active_runs: [] })));
  mocks.invoke.mockResolvedValue({ latency_ms: 21, ledger_entry_ids: ['ledger-1', 'ledger-2'] });
  render(<SidebarAgentPanel />);
  fireEvent.click(screen.getByRole('button', { name: /drishti/i }));
  fireEvent.click(screen.getByRole('button', { name: /Run Discovery Scan/ }));
  await waitFor(() => expect(screen.getByText('✓ Succeeded')).toBeTruthy());
  expect(mocks.invoke).toHaveBeenCalledWith('drishti', { scope: 'manual_trigger' });
  expect(screen.getByRole('link', { name: /#ledger-1, #ledger-2/ }).getAttribute('href')).toBe('/ledger?q=ledger-1');
  expect(mocks.refresh).toHaveBeenCalledOnce();
});

it('keeps an ambiguous direct invocation as an error without invented proof', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ active_runs: [] })));
  mocks.invoke.mockRejectedValue(new Error('private transport detail'));
  render(<SidebarAgentPanel />);
  fireEvent.click(screen.getByRole('button', { name: /drishti/i }));
  fireEvent.click(screen.getByRole('button', { name: /Run Discovery Scan/ }));
  await waitFor(() => expect(screen.getByText('✕ Error')).toBeTruthy());
  expect(document.body.textContent).toContain('Could not confirm the agent outcome.');
  expect(document.body.textContent).not.toContain('private transport detail');
  expect(document.body.textContent).not.toContain('Ledger proof:');
  expect(mocks.refresh).not.toHaveBeenCalled();
});
