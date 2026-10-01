import { type ReactNode } from 'react';
import { cn } from '../utils';

export interface DataPlaceholderProps {
  title?: ReactNode;
  description?: ReactNode;
  className?: string;
}

/**
 * The state of a panel that has no recorded data yet. It states that plainly and never
 * stands in sample numbers: a placeholder is not a value.
 */
export function DataPlaceholder({
  title = 'Data yet to be populated',
  description,
  className,
}: DataPlaceholderProps) {
  return (
    <div
      role="status"
      data-testid="data-placeholder"
      className={cn(
        'rounded-xl border border-dashed border-slate-300 bg-slate-50 p-6 text-center',
        className,
      )}
    >
      <p className="font-heading text-sm font-semibold text-slate-700">{title}</p>
      {description && <p className="mx-auto mt-1 max-w-xl text-sm text-slate-500">{description}</p>}
    </div>
  );
}
