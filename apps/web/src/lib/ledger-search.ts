/** Search terms become values inside a PostgREST OR expression. Refuse its grammar. */
export function isSafeLedgerSearch(term: string): boolean {
  return term.length > 0 && term.length <= 128 && /^[A-Za-z0-9 _./:-]+$/.test(term);
}

export function ledgerPageNumber(raw: string | undefined | null, fallback: number, maximum?: number): number {
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  const number = Number(raw);
  if (!Number.isSafeInteger(number) || number < 1) return fallback;
  return maximum === undefined ? number : Math.min(number, maximum);
}
