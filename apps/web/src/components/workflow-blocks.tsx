import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@axiom/ui';

/**
 * Presentational building blocks shared by the step-by-step workflow screens
 * (local custody, MFA recovery, evidence). They carry no behaviour: every
 * screen keeps its own state machine and passes plain children in.
 *
 * Colour follows the brand rules: teal for actions and approvals, indigo for
 * trust and structure, ember for risk, amber for caution. Gold is reserved for
 * sealed evidence and is deliberately absent here.
 */

export type NoticeTone = 'info' | 'success' | 'warning' | 'error' | 'neutral';

const noticeTones: Record<NoticeTone, string> = {
  info: 'border-teal-200 bg-teal-50 text-teal-900',
  success: 'border-teal-300 bg-teal-50 text-teal-900',
  warning: 'border-amber-300 bg-amber-50 text-amber-900',
  error: 'border-ember-500/40 bg-ember-50 text-ember-700',
  neutral: 'border-slate-200 bg-mist-50 text-slate-700',
};

/** A tinted message box. Rendered as a `<p>` so callers can give it a live-region role. */
export function Notice({
  tone = 'info',
  className,
  ...props
}: HTMLAttributes<HTMLParagraphElement> & { tone?: NoticeTone }) {
  return (
    <p
      className={cn(
        'rounded-lg border px-3.5 py-2.5 text-sm leading-relaxed break-words',
        noticeTones[tone],
        className,
      )}
      {...props}
    />
  );
}

/** A section of a workflow page: an indigo-titled card with an optional action slot. */
export function SectionCard({
  title,
  description,
  actions,
  children,
  className,
  ...props
}: Omit<HTMLAttributes<HTMLElement>, 'title'> & {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section
      className={cn('min-w-0 rounded-xl border border-slate-200 bg-white shadow-sm', className)}
      {...props}
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-4 py-3.5 sm:px-5">
        <div className="min-w-0 flex-1">
          <h2 className="font-heading text-base font-semibold leading-tight text-indigo-500">
            {title}
          </h2>
          {description && (
            <div className="mt-1 max-w-3xl text-sm leading-relaxed text-slate-600">
              {description}
            </div>
          )}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      <div className="flex min-w-0 flex-col gap-4 px-4 py-4 sm:px-5">{children}</div>
    </section>
  );
}

/** An ordered list of numbered steps. */
export function StepList({ className, ...props }: HTMLAttributes<HTMLOListElement>) {
  return <ol className={cn('flex min-w-0 flex-col gap-3', className)} {...props} />;
}

/** One numbered step. `state` only changes the marker colour; it never gates anything. */
export function Step({
  n,
  title,
  state = 'todo',
  children,
  className,
}: {
  n: number;
  title: ReactNode;
  state?: 'todo' | 'current' | 'done';
  children?: ReactNode;
  className?: string;
}) {
  return (
    <li
      className={cn(
        'flex min-w-0 gap-3 rounded-lg border p-3.5',
        state === 'current' ? 'border-teal-300 bg-teal-50/40' : 'border-slate-200 bg-white',
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
          state === 'done'
            ? 'bg-teal-500 text-white'
            : state === 'current'
              ? 'border-2 border-teal-500 text-teal-700'
              : 'border border-slate-300 text-slate-500',
        )}
      >
        {state === 'done' ? '✓' : n}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        <p className="text-sm font-semibold text-indigo-500">{title}</p>
        {children}
      </div>
    </li>
  );
}

/** Secondary guidance under a field. */
export function FieldHint({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('text-xs leading-relaxed text-slate-500', className)} {...props} />;
}

/** Label/value pairs for identifiers, hashes and receipts. */
export function FactList({
  items,
  className,
}: {
  items: { label: ReactNode; value: ReactNode; mono?: boolean }[];
  className?: string;
}) {
  return (
    <dl className={cn('grid min-w-0 gap-x-4 gap-y-2 text-sm sm:grid-cols-[11rem_1fr]', className)}>
      {items.map((item, i) => (
        <div key={i} className="contents">
          <dt className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 sm:pt-0.5">
            {item.label}
          </dt>
          <dd className={cn('min-w-0 break-all text-slate-800', item.mono && 'font-mono text-xs')}>
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Shared class names for native controls that have no @axiom/ui primitive. */
export const selectClass =
  'block h-10 w-full min-w-0 rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-800 focus-visible:border-teal-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500';
export const checkboxClass =
  'mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 accent-teal-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-1';
export const checkLabelClass =
  'flex min-w-0 items-start gap-2.5 rounded-lg border border-slate-200 bg-mist-50 px-3 py-2.5 text-sm font-normal text-slate-700';
