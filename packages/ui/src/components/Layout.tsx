import { type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '../utils';
import { ModuleBar, type ModuleBarProps } from './ModuleBar';

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Small status chips shown on the context line (autonomy, citation, freshness). */
  meta?: ReactNode;
  /** Breadcrumb, Hindi name, phase, module id and related agents. */
  module?: ModuleBarProps;
  /** Content that belongs inside the band, such as headline figures or a stepper. */
  children?: ReactNode;
  className?: string;
}

/**
 * The one page header every workbench screen uses.
 *
 * Top to bottom: a context line (section, phase, module id, related agents and
 * any `meta` chips), the h1 with the Hindi name beside it, a one-line
 * description, then optional `children` inside the band. Actions sit top-right
 * and wrap under the title on narrow screens.
 *
 * The h1 sets its own colour. The global heading rule paints headings indigo,
 * which is invisible on this indigo band — the dashboard's tenant name was
 * rendered that way. The teal rule on the left edge is the brand's "machine at
 * work" accent; gold stays reserved for sealed proof.
 */
export function PageHeader({
  title,
  description,
  actions,
  meta,
  module,
  children,
  className,
}: PageHeaderProps) {
  return (
    <header
      data-testid="page-header"
      className={cn(
        'relative overflow-hidden rounded-xl bg-gradient-to-br from-[#1E2A4A] via-[#1E2A4A] to-[#26365F] px-4 py-4 text-white shadow-sm sm:px-5',
        className,
      )}
    >
      <span aria-hidden className="absolute inset-y-0 left-0 w-1 bg-[#0FB5A5]" />
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1">
          {(module || meta) && (
            <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
              {module && <ModuleBar {...module} titleHi={undefined} tone="dark" />}
              {meta && <div className="flex flex-wrap items-center gap-1.5 text-xs">{meta}</div>}
            </div>
          )}
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <h1 className="font-heading text-[22px] font-semibold leading-tight tracking-tight text-white">
              {title}
            </h1>
            {module?.titleHi && (
              <span lang="hi" className="font-heading text-base font-normal text-[#40D5C3]">
                {module.titleHi}
              </span>
            )}
          </div>
          {description && (
            <div className="mt-1.5 max-w-3xl text-[13px] leading-relaxed text-[#D6DBE8]">
              {description}
            </div>
          )}
        </div>
        {actions && (
          // Header actions share one on-dark treatment whatever classes the
          // page gave them: translucent secondary buttons, and teal for the one
          // primary action, which the page marks with `data-primary`. Teal is
          // the brand's action colour; indigo-on-indigo and white trays were
          // how the same idea looked different on every screen.
          <div
            data-testid="page-header-actions"
            className={cn(
              'flex flex-wrap items-center gap-2',
              '[&_:is(a,button)]:inline-flex [&_:is(a,button)]:min-h-9 [&_:is(a,button)]:items-center [&_:is(a,button)]:gap-1.5 [&_:is(a,button)]:rounded-md [&_:is(a,button)]:border [&_:is(a,button)]:border-white/25 [&_:is(a,button)]:bg-white/10 [&_:is(a,button)]:px-3.5 [&_:is(a,button)]:py-2 [&_:is(a,button)]:text-xs [&_:is(a,button)]:font-semibold [&_:is(a,button)]:text-white [&_:is(a,button)]:no-underline [&_:is(a,button)]:shadow-none [&_:is(a,button)]:transition-colors [&_:is(a,button):hover]:bg-white/20 [&_:is(a,button):disabled]:cursor-not-allowed [&_:is(a,button):disabled]:opacity-50',
              '[&_[data-primary]]:border-[#0FB5A5] [&_[data-primary]]:bg-[#0FB5A5] [&_[data-primary]:hover]:bg-[#0C9184]',
              '[&_label]:text-xs [&_label]:text-[#D6DBE8] [&_select]:rounded-md [&_select]:border [&_select]:border-white/25 [&_select]:bg-white/10 [&_select]:px-2 [&_select]:py-1.5 [&_select]:text-xs [&_select]:text-white [&_option]:text-slate-900',
            )}
          >
            {actions}
          </div>
        )}
      </div>
      {children && <div className="mt-4">{children}</div>}
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
