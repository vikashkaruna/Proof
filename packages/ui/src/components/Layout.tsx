import { type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '../utils';
import { ModuleBar, type ModuleBarProps } from './ModuleBar';

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  meta?: ReactNode;
  /** Breadcrumb, Hindi name, phase, module id and related agents under the title. */
  module?: ModuleBarProps;
  className?: string;
}

export function PageHeader({
  title,
  description,
  actions,
  meta,
  module,
  className,
}: PageHeaderProps) {
  return (
    <header
      className={cn(
        'rounded-2xl bg-gradient-to-br from-[#1E2A4A] via-[#1E2A4A] to-[#243356] p-6 text-white shadow-sm md:p-7',
        className,
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          {module?.phase && (
            <span className="inline-flex rounded bg-teal-500 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-teal-900">
              <span className="sr-only">Delivery phase </span>
              {module.phase}
            </span>
          )}
          <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 className="font-heading text-2xl font-bold tracking-tight text-white md:text-[26px]">
              {title}
            </h1>
            {module?.titleHi && (
              <span lang="hi" className="font-heading text-lg text-[#0FB5A5]">
                {module.titleHi}
              </span>
            )}
          </div>
          {module && (
            <ModuleBar
              {...module}
              phase={undefined}
              titleHi={undefined}
              moduleId={undefined}
              tone="dark"
              className="mt-2"
            />
          )}
          {description && (
            <div className="mt-2 max-w-3xl text-xs leading-relaxed text-[#c7cfe0]">
              {description}
            </div>
          )}
          {module?.moduleId && (
            <div className="mt-4 inline-flex rounded-full bg-white/10 px-3 py-1 font-mono text-xs text-white">
              Module {module.moduleId}
            </div>
          )}
          {meta && <div className="mt-3 flex flex-wrap items-center gap-2">{meta}</div>}
        </div>
        {actions && (
          <div className="flex flex-wrap items-center gap-2 rounded-xl bg-white p-1 text-slate-800 shadow-sm">
            {actions}
          </div>
        )}
      </div>
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
