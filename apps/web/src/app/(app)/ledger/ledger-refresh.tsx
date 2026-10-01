'use client';

import React, { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

interface LedgerRefreshProps {
  runningCount: number;
}

export function LedgerRefresh({ runningCount }: LedgerRefreshProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [lastRefreshed, setLastRefreshed] = useState<Date>(new Date());
  // Default to Off (0 = off)
  const [intervalSeconds, setIntervalSeconds] = useState<number>(0);

  // Handle auto-refresh interval when enabled (> 0) or when agents are actively running
  useEffect(() => {
    const activeInterval = intervalSeconds > 0 ? intervalSeconds : runningCount > 0 ? 4 : 0;
    if (activeInterval <= 0) return;

    const timer = setInterval(() => {
      startTransition(() => {
        router.refresh();
        setLastRefreshed(new Date());
      });
    }, activeInterval * 1000);

    return () => clearInterval(timer);
  }, [intervalSeconds, runningCount, router]);

  function handleManualRefresh() {
    startTransition(() => {
      router.refresh();
      setLastRefreshed(new Date());
    });
  }

  return (
    <div className="flex items-center gap-2">
      {/* Live Active Stream Indicator (if any agents currently executing) */}
      {runningCount > 0 && (
        <span className="flex items-center gap-1.5 rounded-full bg-teal-50 px-2.5 py-1 text-xs font-medium text-teal-700 border border-teal-200 shadow-xs">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-teal-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-teal-500" />
          </span>
          {runningCount} active run(s) reported · polling
        </span>
      )}

      {/* Unified Single UI Element: Manual Refresh + Auto-Refresh Dropdown */}
      <div className="inline-flex items-center rounded-lg border border-slate-300 bg-white shadow-xs text-xs">
        {/* Manual Refresh Button */}
        <button
          type="button"
          onClick={handleManualRefresh}
          disabled={isPending}
          title="Click for manual refresh"
          className="flex items-center gap-1.5 px-2.5 py-1.5 font-medium text-slate-700 hover:text-slate-950 transition-colors border-r border-slate-200 disabled:opacity-60 cursor-pointer"
        >
          <span
            className={`inline-block transition-transform ${isPending ? 'animate-spin text-teal-600' : ''}`}
          >
            ↻
          </span>
          <span>{isPending ? 'Refreshing…' : 'Refresh'}</span>
        </button>

        {/* Unified Auto-Refresh Selector (Default Off) */}
        <div className="flex items-center px-2 py-1.5 gap-1.5">
          {intervalSeconds > 0 && (
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-teal-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-teal-500" />
            </span>
          )}
          <select
            value={intervalSeconds}
            onChange={(e) => setIntervalSeconds(Number(e.target.value))}
            title="Auto-refresh interval"
            className="bg-transparent font-medium text-slate-700 hover:text-slate-950 cursor-pointer focus:outline-none pr-1"
            aria-label="Auto-refresh interval"
          >
            <option value={0}>Auto: Off</option>
            <option value={5}>Every 5s</option>
            <option value={10}>Every 10s</option>
            <option value={30}>Every 30s</option>
            <option value={60}>Every 60s</option>
          </select>
        </div>
      </div>

      {/* Subtle Timestamp */}
      <span
        className="hidden sm:inline-block text-[11px] text-slate-400"
        title={`Last updated at ${lastRefreshed.toISOString()}`}
      >
        Updated{' '}
        {lastRefreshed.toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })}
      </span>
    </div>
  );
}
