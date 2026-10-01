// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LedgerRefresh } from './ledger-refresh';

const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  refresh.mockReset();
});

it('defaults automatic refresh off and permits an explicit manual refresh', () => {
  render(<LedgerRefresh runningCount={0} />);
  expect(
    (screen.getByRole('combobox', { name: 'Auto-refresh interval' }) as HTMLSelectElement).value,
  ).toBe('0');
  fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
  expect(refresh).toHaveBeenCalledOnce();
  expect(document.body.textContent).not.toContain('Live streaming');
});

it('polls only while a run is reported active and labels the behavior accurately', () => {
  vi.useFakeTimers();
  render(<LedgerRefresh runningCount={1} />);
  expect(document.body.textContent).toContain('1 active run(s) reported · polling');
  vi.advanceTimersByTime(4000);
  expect(refresh).toHaveBeenCalledOnce();
});
