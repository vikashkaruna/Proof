import { type HTMLAttributes, forwardRef } from 'react';
import { cn } from '../utils';

export interface ProgressBarProps extends HTMLAttributes<HTMLDivElement> {
  value: number; // 0-100
  variant?: 'default' | 'proof' | 'danger' | 'warning';
  size?: 'sm' | 'md' | 'lg';
  showValue?: boolean;
}

export const ProgressBar = forwardRef<HTMLDivElement, ProgressBarProps>(
  ({ value, variant = 'default', size = 'md', showValue = false, className, ...props }, ref) => {
    const v = Math.max(0, Math.min(100, value));
    const heightClass = size === 'sm' ? 'h-1.5' : size === 'lg' ? 'h-3' : 'h-2';
    const fillColor =
      variant === 'proof'
        ? 'bg-gold-500'
        : variant === 'danger'
          ? 'bg-ember-500'
          : variant === 'warning'
            ? 'bg-amber-500'
            : v >= 80
              ? 'bg-teal-500'
              : v >= 50
                ? 'bg-indigo-500'
                : v >= 30
                  ? 'bg-amber-500'
                  : 'bg-ember-500';

    return (
      <div ref={ref} className={cn('flex items-center gap-2', className)} {...props}>
        <div
          className={cn('flex-1 overflow-hidden rounded-full bg-mist-200', heightClass)}
          role="progressbar"
          aria-valuenow={v}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className={cn('h-full transition-all duration-300', fillColor)}
            style={{ width: `${v}%` }}
          />
        </div>
        {showValue && (
          <span className="min-w-[3ch] text-right font-mono text-xs text-slate-500">
            {v.toFixed(0)}%
          </span>
        )}
      </div>
    );
  },
);
ProgressBar.displayName = 'ProgressBar';
