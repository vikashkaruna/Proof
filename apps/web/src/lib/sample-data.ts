/**
 * Illustrative sample figures for module pages (W3 decision, E.2).
 *
 * The ten module shells ship hardcoded numbers — "12.4M rows", "47 tables",
 * "8,210 files" — that render whenever the underlying query returns nothing.
 * For a demo that is useful. For a real client it is the most damaging
 * possible default: they see invented figures presented as their own
 * compliance posture, with nothing distinguishing them from a genuine
 * finding, on a product whose entire proposition is that its output can be
 * shown to a regulator.
 *
 * So sample data is opt-in per tenant (`tenants.is_demo`) and carries its
 * provenance wherever it is rendered — the same treatment simulated connector
 * bindings get. A non-demo tenant with no data sees an empty state, which is
 * the honest answer.
 */

export type Provenance = 'measured' | 'simulated';

export interface Figure<T> {
  value: T;
  provenance: Provenance;
}

/** A measured value: something actually read from this tenant's data. */
export function measured<T>(value: T): Figure<T> {
  return { value, provenance: 'measured' };
}

/** An illustrative value. Only reachable for a demo tenant. */
export function simulated<T>(value: T): Figure<T> {
  return { value, provenance: 'simulated' };
}

/**
 * Pick between a real value and an illustrative one.
 *
 * `real` being null/undefined/0-length means "nothing measured". For a demo
 * tenant that falls back to the sample; for everyone else it returns the
 * empty state, never the sample.
 */
export function figure<T>(
  real: T | null | undefined,
  sample: T,
  isDemo: boolean,
  emptyValue: T,
): Figure<T> {
  const hasReal =
    real !== null && real !== undefined && !(Array.isArray(real) && real.length === 0);
  if (hasReal) return measured(real as T);
  return isDemo ? simulated(sample) : measured(emptyValue);
}

/** Suffix for a rendered figure, so simulated numbers are visibly so. */
export function provenanceLabel(provenance: Provenance): string | null {
  return provenance === 'simulated' ? 'sample data' : null;
}
