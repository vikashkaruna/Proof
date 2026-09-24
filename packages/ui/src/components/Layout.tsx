import { type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '../utils';

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  meta?: ReactNode;
  className?: string;
}

export function PageHeader({ title, description, actions, meta, className }: PageHeaderProps) {
  return (
    <header className={cn('flex flex-col gap-4 border-b border-slate-200 pb-6', className)}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <h1 className="font-heading text-2xl font-semibold tracking-tight text-indigo-500">
            {title}
          </h1>
          {description && (
            <div className="mt-1 max-w-3xl text-sm text-slate-600">{description}</div>
          )}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {meta && <div className="flex flex-wrap items-center gap-2">{meta}</div>}
    </header>
  );
}

export function StatGrid({
  children,
  className,
}: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) {
  return (
    <div className={cn('grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4', className)}>
      {children}
    </div>
  );
}

export function Stat({
  label,
  value,
  hint,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('rounded-xl border border-slate-200 bg-white p-4 shadow-sm', className)}>
      <p className="text-xs font-medium uppercase tracking-wider text-slate-500">{label}</p>
      <p className="mt-1 font-heading text-2xl font-semibold text-indigo-500">{value}</p>
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}
