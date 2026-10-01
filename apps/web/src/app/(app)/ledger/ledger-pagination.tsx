'use client';

import React, { useTransition, useState } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';

export interface LedgerPaginationProps {
  currentPage: number;
  pageSize: number;
  totalEntries: number;
  filteredCount: number;
  totalPages: number;
}

export function LedgerPagination({
  currentPage,
  pageSize,
  totalEntries,
  filteredCount,
  totalPages,
}: LedgerPaginationProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const [jumpPage, setJumpPage] = useState<string>('');

  const from = filteredCount > 0 ? (currentPage - 1) * pageSize + 1 : 0;
  const to = Math.min(currentPage * pageSize, filteredCount);

  const navigateTo = (newPage: number, newLimit?: number) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('page', String(newPage));
    if (newLimit) {
      params.set('limit', String(newLimit));
    }
    startTransition(() => {
      router.push(`${pathname}?${params.toString()}`);
    });
  };

  const handlePageSizeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newSize = parseInt(e.target.value, 10);
    // Reset to page 1 on page size change
    navigateTo(1, newSize);
  };

  const handleJumpSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const entered = jumpPage.trim();
    const p = Number(entered);
    if (/^\d+$/.test(entered) && Number.isSafeInteger(p) && p >= 1 && p <= totalPages) {
      navigateTo(p);
      setJumpPage('');
    }
  };

  // Generate pagination items with ellipses
  const getPageNumbers = () => {
    const pages: (number | string)[] = [];
    const delta = 1; // Number of pages around current page

    const left = Math.max(2, currentPage - delta);
    const right = Math.min(totalPages - 1, currentPage + delta);

    pages.push(1);

    if (left > 2) {
      pages.push('…');
    }

    for (let i = left; i <= right; i++) {
      pages.push(i);
    }

    if (right < totalPages - 1) {
      pages.push('…');
    }

    if (totalPages > 1) {
      pages.push(totalPages);
    }

    return pages;
  };

  return (
    <div className="flex flex-col sm:flex-row items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white p-3.5 shadow-2xs text-xs text-slate-600">
      {/* Left: Summary & Per-page selector */}
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-medium text-slate-700">
          Showing <b className="text-slate-900">{from}</b>–<b className="text-slate-900">{to}</b> of{' '}
          <b className="text-[#0FB5A5]">{filteredCount.toLocaleString()}</b> entries
          {filteredCount !== totalEntries && (
            <span className="text-slate-400 ml-1 font-normal">
              (filtered from {totalEntries.toLocaleString()} total)
            </span>
          )}
        </span>

        {/* Loading Indicator */}
        {isPending && (
          <span className="inline-flex items-center gap-1.5 rounded-md bg-[#E5FAF7] px-2 py-0.5 text-[11px] font-medium text-[#0a6b61] border border-teal-200">
            <span className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-teal-600 border-t-transparent" />
            Loading page…
          </span>
        )}

        <div className="flex items-center gap-1.5 pl-2 border-l border-slate-200">
          <span className="text-slate-500">Show:</span>
          <select
            value={pageSize}
            onChange={handlePageSizeChange}
            disabled={isPending}
            className="rounded border border-slate-300 bg-slate-50 px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-white focus:border-teal-500 focus:outline-none cursor-pointer"
            aria-label="Entries per page"
          >
            <option value={10}>10 / page</option>
            <option value={25}>25 / page</option>
            <option value={50}>50 / page</option>
            <option value={100}>100 / page</option>
          </select>
        </div>
      </div>

      {/* Right: Page Navigation Controls */}
      <div className="flex flex-wrap items-center gap-1.5">
        {/* First Button */}
        <button
          type="button"
          onClick={() => navigateTo(1)}
          disabled={currentPage <= 1 || isPending}
          title="First page"
          className="rounded border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 hover:text-slate-900 disabled:opacity-40 disabled:hover:bg-white cursor-pointer"
        >
          « First
        </button>

        {/* Previous Button */}
        <button
          type="button"
          onClick={() => navigateTo(currentPage - 1)}
          disabled={currentPage <= 1 || isPending}
          title="Previous page"
          className="rounded border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 hover:text-slate-900 disabled:opacity-40 disabled:hover:bg-white cursor-pointer"
        >
          ‹ Prev
        </button>

        {/* Page Numbers */}
        <div className="flex items-center gap-1">
          {getPageNumbers().map((num, idx) =>
            typeof num === 'number' ? (
              <button
                key={idx}
                type="button"
                onClick={() => navigateTo(num)}
                disabled={isPending}
                className={`min-w-[28px] h-7 rounded text-xs font-semibold transition-colors cursor-pointer ${
                  num === currentPage
                    ? 'bg-[#1E2A4A] text-white shadow-xs'
                    : 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                }`}
              >
                {num}
              </button>
            ) : (
              <span key={idx} className="px-1 text-slate-400 select-none">
                {num}
              </span>
            ),
          )}
        </div>

        {/* Next Button */}
        <button
          type="button"
          onClick={() => navigateTo(currentPage + 1)}
          disabled={currentPage >= totalPages || isPending}
          title="Next page"
          className="rounded border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 hover:text-slate-900 disabled:opacity-40 disabled:hover:bg-white cursor-pointer"
        >
          Next ›
        </button>

        {/* Last Button */}
        <button
          type="button"
          onClick={() => navigateTo(totalPages)}
          disabled={currentPage >= totalPages || isPending}
          title="Last page"
          className="rounded border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 hover:text-slate-900 disabled:opacity-40 disabled:hover:bg-white cursor-pointer"
        >
          Last »
        </button>

        {/* Direct Jump to Page Form */}
        {totalPages > 3 && (
          <form
            onSubmit={handleJumpSubmit}
            className="flex items-center gap-1 pl-2 border-l border-slate-200"
          >
            <span className="text-[11px] text-slate-400">Go to:</span>
            <input
              type="number"
              min={1}
              max={totalPages}
              value={jumpPage}
              onChange={(e) => setJumpPage(e.target.value)}
              placeholder={String(currentPage)}
              disabled={isPending}
              className="w-12 rounded border border-slate-300 bg-slate-50 px-1.5 py-1 text-center text-xs font-mono text-slate-800 placeholder-slate-400 focus:border-teal-500 focus:bg-white focus:outline-none"
            />
            <button
              type="submit"
              disabled={isPending || !jumpPage}
              className="rounded bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-200 disabled:opacity-40 cursor-pointer"
            >
              Go
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
