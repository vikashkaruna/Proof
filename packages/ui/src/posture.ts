/**
 * Posture score bands: one scale for every place a 0-100 posture score is shown.
 *
 * Ember marks risk (brand rule), amber is the warning family, teal the moderate
 * band and green a good score. Gold is reserved for sealed proof and never used
 * here. Class strings are literal so Tailwind can see them.
 */
export type PostureBandKey = 'critical' | 'weak' | 'moderate' | 'good';

export interface PostureBand {
  key: PostureBandKey;
  label: string;
  /** Lowest score (inclusive) in the band. */
  min: number;
  /** Score text on a light surface. */
  text: string;
  /** Score text on the indigo page-header band. */
  onDark: string;
  /** Band chip on a light surface. */
  chip: string;
  /** Band chip on the indigo page-header band. */
  chipOnDark: string;
}

export const POSTURE_BANDS: readonly PostureBand[] = [
  {
    key: 'good',
    label: 'Good',
    min: 80,
    text: 'text-green-700',
    onDark: 'text-green-300',
    chip: 'bg-green-50 text-green-800 ring-green-200',
    chipOnDark: 'bg-green-400/15 text-green-200 ring-green-300/40',
  },
  {
    key: 'moderate',
    label: 'Moderate',
    min: 60,
    text: 'text-teal-700',
    onDark: 'text-teal-300',
    chip: 'bg-teal-50 text-teal-800 ring-teal-200',
    chipOnDark: 'bg-teal-400/15 text-teal-100 ring-teal-300/40',
  },
  {
    key: 'weak',
    label: 'Weak',
    min: 40,
    text: 'text-amber-700',
    onDark: 'text-amber-300',
    chip: 'bg-amber-50 text-amber-800 ring-amber-200',
    chipOnDark: 'bg-amber-400/15 text-amber-200 ring-amber-300/40',
  },
  {
    key: 'critical',
    label: 'Critical',
    min: 0,
    text: 'text-ember-700',
    onDark: 'text-ember-300',
    chip: 'bg-ember-50 text-ember-800 ring-ember-200',
    chipOnDark: 'bg-ember-400/15 text-ember-100 ring-ember-300/40',
  },
];

/** The band for a 0-100 score, or null when there is no valid score to classify. */
export function postureBand(score: number | null | undefined): PostureBand | null {
  if (score === null || score === undefined || !Number.isFinite(score)) return null;
  if (score < 0 || score > 100) return null;
  return POSTURE_BANDS.find((band) => score >= band.min) ?? null;
}
