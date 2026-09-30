// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LedgerFilters } from './ledger-filters';
import { LedgerPagination } from './ledger-pagination';

const nav = vi.hoisted(() => ({ push: vi.fn(), search: 'page=3&agent=drishti&result=failure' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push }),
  usePathname: () => '/ledger',
  useSearchParams: () => new URLSearchParams(nav.search),
}));
beforeEach(() => { nav.push.mockReset(); nav.search = 'page=3&agent=drishti&result=failure'; });
afterEach(cleanup);

it('changes a ledger filter while preserving other filters and resetting the page', async () => {
  render(<LedgerFilters totalCount={150} filteredCount={12} />);
  fireEvent.change(screen.getByRole('combobox', { name: 'Filter by Actor' }), { target: { value: 'lekha' } });
  await waitFor(() => expect(nav.push).toHaveBeenCalledOnce());
  const url = new URL(nav.push.mock.calls[0]![0], 'https://app.axiomproof.ai');
  expect(url.searchParams.get('agent')).toBe('lekha');
  expect(url.searchParams.get('result')).toBe('failure');
  expect(url.searchParams.has('page')).toBe(false);
});

it('clears all filters and does not preserve a stale search query', async () => {
  nav.search = 'page=8&q=target-1&agent=drishti';
  render(<LedgerFilters totalCount={150} filteredCount={2} />);
  fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
  await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/ledger'));
});

it('paginates within the filtered result and resets when page size changes', async () => {
  render(<LedgerPagination currentPage={3} pageSize={25} totalEntries={1000} filteredCount={83} totalPages={4} />);
  expect(screen.getByText('83')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Next ›' }));
  await waitFor(() => expect(nav.push).toHaveBeenCalledOnce());
  const next = new URL(nav.push.mock.calls[0]![0], 'https://app.axiomproof.ai');
  expect(next.searchParams.get('page')).toBe('4');
  expect(next.searchParams.get('agent')).toBe('drishti');
  nav.push.mockReset();
  fireEvent.change(screen.getByRole('combobox', { name: 'Entries per page' }), { target: { value: '50' } });
  await waitFor(() => expect(nav.push).toHaveBeenCalledOnce());
  const resized = new URL(nav.push.mock.calls[0]![0], 'https://app.axiomproof.ai');
  expect(resized.searchParams.get('page')).toBe('1');
  expect(resized.searchParams.get('limit')).toBe('50');
});

it('does not navigate to an out-of-range jump page', () => {
  render(<LedgerPagination currentPage={2} pageSize={25} totalEntries={100} filteredCount={100} totalPages={4} />);
  const jump = screen.getByPlaceholderText('2');
  fireEvent.change(jump, { target: { value: '9' } });
  fireEvent.click(screen.getByRole('button', { name: 'Go' }));
  expect(nav.push).not.toHaveBeenCalled();
  fireEvent.change(jump, { target: { value: '2.5' } });
  fireEvent.click(screen.getByRole('button', { name: 'Go' }));
  expect(nav.push).not.toHaveBeenCalled();
});
