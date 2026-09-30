// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LedgerStreamView, type LedgerStreamEntry } from './ledger-stream-view';

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'clipboard');
});

const recorded: LedgerStreamEntry = {
  id: 'record-1',
  seq: 1,
  type: 'assessment.started',
  actor: 'Parikshan',
  actorType: 'agent',
  time: '10:00',
  corr: 'cr-a1',
  fullCorr: 'a1',
  target: 'estate-1',
  entryHash: 'abcd',
  fullEntryHash: 'a'.repeat(64),
  prevHash: 'genesis',
  result: 'pending',
  dot: '#64748B',
  actorStyle: 'text-slate-600',
  detail: { state: 'started' },
};

it('shows a truthful empty ledger and no reconstructed approval or seal', () => {
  render(<LedgerStreamView entries={[]} />);
  expect(screen.getByText('No matching ledger entries')).toBeTruthy();
  expect(document.body.textContent).not.toContain('Saakshi sealed');
  expect(document.body.textContent).not.toContain('Human approval token issued');
  expect(document.body.textContent).not.toContain('cr-118');
});

it('inspects only the selected recorded event and makes no lifecycle claim', () => {
  const entry: LedgerStreamEntry = {
    id: 'record-1',
    seq: 1,
    type: 'assessment.started',
    actor: 'Parikshan',
    actorType: 'agent',
    time: '10:00',
    corr: 'cr-a1',
    fullCorr: 'a1',
    target: 'estate-1',
    entryHash: 'abcd',
    prevHash: 'genesis',
    result: 'pending',
    dot: '#64748B',
    actorStyle: 'text-slate-600',
    detail: { state: 'started' },
  };
  render(<LedgerStreamView entries={[entry]} />);
  expect(screen.getAllByText('assessment.started').length).toBeGreaterThan(0);
  expect(
    screen.getByText(
      'Only recorded fields are shown; this entry does not prove a complete lifecycle.',
    ),
  ).toBeTruthy();
  expect(document.body.textContent).not.toContain('purge executed');
  expect(document.body.textContent).not.toContain('proof sealed');
});

it('surfaces a load-more refusal and retries the same page without inventing rows', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ error: 'unavailable' }, { status: 503 }))
    .mockResolvedValueOnce(Response.json({ entries: [] }));
  vi.stubGlobal('fetch', fetcher);
  render(<LedgerStreamView entries={[]} totalPages={2} currentPage={1} />);
  fireEvent.click(screen.getByRole('button', { name: /Lazy load more entries/ }));
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toContain('could not be loaded'),
  );
  expect(screen.getByText('No matching ledger entries')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /Lazy load more entries/ }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  expect(fetcher.mock.calls[0]![0]).toBe(fetcher.mock.calls[1]![0]);
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: /Lazy load more entries/ })).toBeNull(),
  );
});

it('shows a copy confirmation only after the complete recorded hash reaches the clipboard', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  render(<LedgerStreamView entries={[recorded]} />);
  fireEvent.click(screen.getByRole('button', { name: /abcd/ }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith('a'.repeat(64)));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /abcd/ }).textContent).toContain('✓'),
  );
});

it('does not show a copied hash when clipboard access is denied', async () => {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: vi.fn().mockRejectedValue(new Error('permission denied')),
    },
  });
  render(<LedgerStreamView entries={[recorded]} />);
  fireEvent.click(screen.getByRole('button', { name: /abcd/ }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /abcd/ }).textContent).not.toContain('✓'),
  );
  expect(screen.getByRole('button', { name: /abcd/ }).textContent).toContain('⧉');
});

it('reveals only a selected entry’s recorded payload and uses the active color', () => {
  render(<LedgerStreamView entries={[recorded]} />);
  const toggle = screen.getByRole('button', { name: /View raw payload JSON/ });
  expect(toggle.className).toContain('#0FB5A5');
  expect(toggle.className).not.toContain('#C9A227');
  fireEvent.click(toggle);
  expect(screen.getByText(/"state": "started"/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /Hide raw payload JSON/ }));
  expect(screen.queryByText(/"state": "started"/)).toBeNull();
});
