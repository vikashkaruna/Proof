// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ALL_AGENTS, SidebarAgentPanel } from './sidebar-agent-panel';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

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
