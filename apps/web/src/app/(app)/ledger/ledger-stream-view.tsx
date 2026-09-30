'use client';

import React, { useState } from 'react';
import { useSearchParams } from 'next/navigation';

export interface LedgerStreamEntry {
  id: string;
  seq: number;
  type: string;
  actor: string;
  actorType: string;
  time: string;
  corr: string;
  fullCorr: string;
  target: string;
  entryHash: string;
  fullEntryHash?: string;
  prevHash: string;
  fullPrevHash?: string;
  result: string;
  detail?: unknown;
  dot: string;
  actorStyle: string;
  chainHead?: boolean;
}

export interface LedgerStreamViewProps {
  entries: LedgerStreamEntry[];
  currentPage?: number;
  totalPages?: number;
  pageSize?: number;
  filteredCount?: number;
}

export function LedgerStreamView({
  entries: initialEntries,
  currentPage = 1,
  totalPages = 1,
  pageSize = 25,
  filteredCount = 0,
}: LedgerStreamViewProps) {
  const searchParams = useSearchParams();
  const [extraEntries, setExtraEntries] = useState<LedgerStreamEntry[]>([]);
  const [loadedPage, setLoadedPage] = useState<number>(currentPage);
  const [prevPage, setPrevPage] = useState<number>(currentPage);
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState<boolean>(false);
  const [loadError, setLoadError] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [showRawJson, setShowRawJson] = useState<boolean>(false);

  // Sync state during render when currentPage prop changes (React recommended pattern)
  if (prevPage !== currentPage) {
    setPrevPage(currentPage);
    setLoadedPage(currentPage);
    setExtraEntries([]);
    setSelectedSeq(null);
    setLoadError(false);
  }

  const streamList = [...initialEntries, ...extraEntries];

  // Derive active selected entry
  const activeEntry =
    (selectedSeq !== null ? streamList.find((e) => e.seq === selectedSeq) : null) || streamList[0];
  const activeCorr = activeEntry?.fullCorr;

  const hasMoreToLazyLoad = loadedPage < totalPages;

  // Lazy Load More Entries via client-side fetch without full page reload
  const handleLoadMore = async () => {
    if (isLoadingMore || !hasMoreToLazyLoad) return;
    setIsLoadingMore(true);
    setLoadError(false);

    try {
      const nextPage = loadedPage + 1;
      const params = new URLSearchParams(searchParams.toString());
      params.set('page', String(nextPage));
      params.set('limit', String(pageSize));

      const res = await fetch(`/api/ledger?${params.toString()}`);
      if (!res.ok) throw new Error('Failed to load more entries');
      const data = await res.json();

      if (!Array.isArray(data.entries)) throw new Error('Unreadable ledger page');
      setExtraEntries((prev) => [...prev, ...data.entries]);
      setLoadedPage(nextPage);
    } catch {
      setLoadError(true);
    } finally {
      setIsLoadingMore(false);
    }
  };

  const copyToClipboard = async (text: string, fieldName: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(fieldName);
      setTimeout(() => setCopiedField(null), 2000);
    } catch {
      setCopiedField(null);
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_440px] gap-4 items-start">
      {/* Left Column: Ledger Stream Table & Lazy Loading */}
      <div className="rounded-2xl border border-[#e4e8ee] bg-white overflow-hidden shadow-2xs">
        {/* Table Header */}
        <div className="grid grid-cols-[60px_1fr_90px] gap-3 px-4 py-2.5 bg-[#F4F6F8] border-b border-[#e4e8ee] text-[10px] font-semibold tracking-wider uppercase text-[#8a909b]">
          <span>Seq</span>
          <span>Event · actor</span>
          <span>Result</span>
        </div>

        {/* Stream Rows */}
        {streamList.length === 0 ? (
          <div className="p-8 text-center">
            <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-slate-400">
              🔍
            </div>
            <h3 className="mt-2 text-sm font-semibold text-slate-800">
              No matching ledger entries
            </h3>
            <p className="mt-1 text-xs text-slate-500">
              No immutable records matched your filter criteria. Try adjusting or clearing your
              filters.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-[#eef1f5]">
            {streamList.map((l) => {
              const isSelected = activeEntry?.seq === l.seq;

              return (
                <button
                  key={l.id}
                  type="button"
                  onClick={() => setSelectedSeq(l.seq)}
                  aria-label={`Inspect ledger entry ${l.seq}: ${l.type}`}
                  aria-pressed={isSelected}
                  className={`grid w-full text-left grid-cols-[60px_1fr_90px] gap-3 px-4 py-3 cursor-pointer transition-colors focus-visible:outline-2 focus-visible:outline-teal-500 ${
                    isSelected
                      ? 'bg-[#E5FAF7]/60 border-l-4 border-l-[#0FB5A5]'
                      : 'hover:bg-slate-50/70'
                  }`}
                >
                  <span className="font-mono text-[11px] text-slate-400 font-medium self-center">
                    #{l.seq}
                  </span>

                  <div className="min-w-0 flex flex-col justify-center">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span
                        style={{ backgroundColor: l.dot }}
                        className="h-2 w-2 rounded-xs shrink-0"
                      />
                      <span className="text-[12.5px] font-semibold text-[#2F3542] truncate">
                        {l.type}
                      </span>
                      <span
                        className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${l.actorStyle}`}
                      >
                        {l.actor}
                      </span>
                      {l.chainHead && (
                        <span className="text-[9px] text-[#0a8d80] font-mono">◆ chain root</span>
                      )}
                    </div>
                    <div className="font-mono text-[10px] text-slate-400 mt-1 truncate">
                      {l.time} · {l.corr} · {l.target} · H:{l.entryHash}←{l.prevHash}
                    </div>
                  </div>

                  <div className="self-center">
                    <span
                      className={`text-[11px] font-semibold ${
                        l.result === 'success'
                          ? 'text-[#0a8d80]'
                          : l.result === 'failure'
                            ? 'text-[#D9534F]'
                            : 'text-[#8a6d10]'
                      }`}
                    >
                      {l.result === 'success' ? '✓ ' : l.result === 'failure' ? '✕ ' : ''}
                      {l.result}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {/* Lazy Loading Skeleton when fetching more */}
        {isLoadingMore && (
          <div className="p-4 space-y-3 bg-slate-50/50 border-t border-[#eef1f5] animate-pulse">
            <div className="h-4 bg-slate-200 rounded w-3/4" />
            <div className="h-3 bg-slate-200 rounded w-1/2" />
          </div>
        )}

        {/* Lazy Load More Button */}
        {loadError && (
          <p
            role="alert"
            className="border-t border-red-200 bg-red-50 px-4 py-2 text-xs text-red-800"
          >
            More ledger entries could not be loaded. Retry the same page.
          </p>
        )}
        {hasMoreToLazyLoad && (
          <div className="p-3 border-t border-[#e4e8ee] bg-[#F8FAFC] text-center">
            <button
              type="button"
              onClick={handleLoadMore}
              disabled={isLoadingMore}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 shadow-2xs hover:bg-slate-50 hover:border-[#0FB5A5] transition-all cursor-pointer disabled:opacity-60"
            >
              {isLoadingMore ? (
                <>
                  <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-teal-600 border-t-transparent" />
                  <span>Loading next batch…</span>
                </>
              ) : (
                <>
                  <span>↓ Lazy load more entries (+{pageSize})</span>
                  <span className="text-[10px] text-slate-400 font-normal">
                    (Page {loadedPage + 1} of {totalPages})
                  </span>
                </>
              )}
            </button>
          </div>
        )}
      </div>

      {/* Right Column: Recorded Entry Inspector (Sticky) */}
      <div className="sticky top-4 rounded-2xl bg-[#1E2A4A] text-white overflow-hidden shadow-sm">
        {/* Header */}
        <div className="px-5 py-4 border-b border-white/10">
          <div className="flex items-center justify-between">
            <div className="text-[10px] font-semibold text-[#0FB5A5] uppercase tracking-wider">
              Correlation · {activeCorr ? `${activeCorr.slice(0, 8)}…` : 'not recorded'}
            </div>
            {activeEntry && (
              <span className="font-mono text-[10px] text-teal-300 bg-white/10 px-2 py-0.5 rounded">
                Seq #{activeEntry.seq}
              </span>
            )}
          </div>
          <h2 className="font-heading text-base font-semibold text-white mt-1">Recorded entry</h2>
          <div className="text-[11px] text-[#a9b3ce] mt-0.5">
            Only recorded fields are shown; this entry does not prove a complete lifecycle.
          </div>
        </div>

        {/* Selected Entry Quick Detail Bar */}
        {activeEntry && (
          <div className="px-5 py-3 bg-white/5 border-b border-white/10 text-xs space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[#8a97b8] text-[11px]">Action:</span>
              <span className="font-semibold text-white font-mono text-[11px]">
                {activeEntry.type}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[#8a97b8] text-[11px]">Actor:</span>
              <span className="text-white text-[11px]">
                {activeEntry.actor} ({activeEntry.actorType})
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[#8a97b8] text-[11px]">Target:</span>
              <span className="text-slate-300 font-mono text-[10.5px] truncate max-w-[220px]">
                {activeEntry.target}
              </span>
            </div>
            <div className="flex items-center justify-between pt-1 border-t border-white/5">
              <span className="text-[#8a97b8] text-[10px]">Entry SHA-256:</span>
              <button
                type="button"
                onClick={() =>
                  copyToClipboard(activeEntry.fullEntryHash || activeEntry.entryHash, 'entryHash')
                }
                title="Copy hash"
                className="font-mono text-[10px] text-teal-300 hover:text-white flex items-center gap-1 cursor-pointer"
              >
                <span>{activeEntry.entryHash}</span>
                <span>{copiedField === 'entryHash' ? '✓' : '⧉'}</span>
              </button>
            </div>

            {/* Toggle Raw Detail JSON */}
            {activeEntry.detail != null && (
              <div className="pt-1">
                <button
                  type="button"
                  onClick={() => setShowRawJson(!showRawJson)}
                  className="text-[10px] text-[#0FB5A5] hover:underline cursor-pointer flex items-center gap-1"
                >
                  <span>{showRawJson ? '▼ Hide raw payload JSON' : '▶ View raw payload JSON'}</span>
                </button>
                {showRawJson && (
                  <pre className="mt-1.5 p-2 rounded bg-black/40 text-[9.5px] font-mono text-teal-200 overflow-x-auto max-h-36">
                    {JSON.stringify(activeEntry.detail, null, 2)}
                  </pre>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
