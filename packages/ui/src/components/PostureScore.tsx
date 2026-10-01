import { cn } from '../utils';
import { ProgressBar } from '../primitives/Progress';

export interface PostureScoreProps {
  /** 0-100 */
  score: number | null | undefined;
  /** Estimated max statutory exposure in INR. */
  exposureInr?: number | null;
  /** Display variant: 'large' for hero, 'compact' for tables. */
  variant?: 'large' | 'compact';
  className?: string;
}

function formatExposure(n: number): string {
  if (n >= 10_00_00_000) return `₹${(n / 10_00_00_000).toFixed(2)} Cr`;
  if (n >= 1_00_000) return `₹${(n / 1_00_000).toFixed(2)} L`;
  if (n >= 1_000) return `₹${(n / 1_000).toFixed(1)}k`;
  return `₹${n}`;
}

export function PostureScore({
  score,
  exposureInr,
  variant = 'large',
  className,
}: PostureScoreProps) {
  const s = score ?? 0;
  const verdict = s >= 85 ? 'Strong' : s >= 65 ? 'Acceptable' : s >= 40 ? 'At Risk' : 'Critical';
  const verdictColor =
    s >= 85
      ? 'text-teal-700'
      : s >= 65
        ? 'text-indigo-700'
        : s >= 40
          ? 'text-amber-700'
          : 'text-ember-700';

  if (variant === 'compact') {
    return (
      <div className={cn('flex items-center gap-2', className)}>
        <span className={cn('font-mono text-sm font-semibold', verdictColor)}>{s.toFixed(0)}</span>
        <ProgressBar value={s} size="sm" className="w-20" />
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="flex items-baseline gap-2">
        <span className={cn('font-heading text-4xl font-semibold', verdictColor)}>
          {s.toFixed(0)}
        </span>
        <span className="text-sm text-slate-500">/ 100 · {verdict}</span>
      </div>
      <ProgressBar value={s} size="lg" />
      {exposureInr != null && exposureInr > 0 && (
        <p className="font-mono text-xs text-slate-500">
          Estimated max statutory exposure:{' '}
          <span className="font-semibold text-ember-700">{formatExposure(exposureInr)}</span>
        </p>
      )}
    </div>
  );
}
