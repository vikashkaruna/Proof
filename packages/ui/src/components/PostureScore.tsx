import { cn, formatINRCrore } from '../utils';
import { postureBand } from '../posture';
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

export function PostureScore({
  score,
  exposureInr,
  variant = 'large',
  className,
}: PostureScoreProps) {
  const band = postureBand(score);
  const s = band ? (score as number) : 0;
  const verdict = band?.label ?? 'Not assessed';
  const verdictColor = band?.text ?? 'text-slate-500';

  if (variant === 'compact') {
    return (
      <div className={cn('flex items-center gap-2', className)}>
        <span className={cn('font-mono text-sm font-semibold', verdictColor)}>
          {band ? s.toFixed(0) : '—'}
        </span>
        <ProgressBar value={s} size="sm" className="w-20" />
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="flex items-baseline gap-2">
        <span className={cn('font-heading text-4xl font-semibold', verdictColor)}>
          {band ? s.toFixed(0) : '—'}
        </span>
        <span className="text-sm text-slate-500">/ 100 · {verdict}</span>
      </div>
      <ProgressBar value={s} size="lg" />
      {exposureInr != null && exposureInr > 0 && (
        <p className="font-mono text-xs text-slate-500">
          Estimated max statutory exposure:{' '}
          <span className="font-semibold text-ember-700">{formatINRCrore(exposureInr)}</span>
        </p>
      )}
    </div>
  );
}
