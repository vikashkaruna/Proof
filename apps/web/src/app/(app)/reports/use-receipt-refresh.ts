import { useEffect, useRef } from 'react';
import { awaitsReceipt, nextReceiptRefreshDelay } from './retained-artifact-state';

type Awaiting = Parameters<typeof awaitsReceipt>[0];

/**
 * Re-reads the list, a bounded number of times, while a settled card still has
 * no PDF receipt. Each state update re-arms one timer; the budget resets as
 * soon as no card is waiting.
 */
export function useReceiptRefresh(requests: Awaiting, refresh: () => void) {
  const attempts = useRef(0);
  useEffect(() => {
    const waiting = awaitsReceipt(requests);
    if (!waiting) {
      attempts.current = 0;
      return;
    }
    const delay = nextReceiptRefreshDelay(attempts.current, waiting);
    if (delay === null) return;
    const timer = setTimeout(() => {
      attempts.current += 1;
      refresh();
    }, delay);
    return () => clearTimeout(timer);
  }, [requests, refresh]);
}
