import { type HTMLAttributes, forwardRef } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../utils';
import { agentAccents, type AgentName } from '@axiom/design-tokens';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
  {
    variants: {
      variant: {
        neutral: 'bg-mist-200 text-slate-700',
        info: 'bg-teal-50 text-teal-700',
        success: 'bg-green-50 text-green-700',
        warning: 'bg-amber-50 text-amber-800',
        danger: 'bg-ember-50 text-ember-700',
        proof: 'bg-gold-50 text-gold-700 border border-gold-500',
        indigo: 'bg-indigo-50 text-indigo-700',
      },
      size: {
        sm: 'text-[10px] px-1.5 py-0.5',
        md: 'text-xs px-2 py-0.5',
        lg: 'text-sm px-2.5 py-1',
      },
    },
    defaultVariants: {
      variant: 'neutral',
      size: 'md',
    },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {
  agent?: AgentName;
}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, variant, size, agent, children, style, ...props }, ref) => {
    if (agent) {
      return (
        <span
          ref={ref}
          className={cn(badgeVariants({ variant: 'neutral', size }), className)}
          style={{ borderLeft: `3px solid ${agentAccents[agent]}`, ...style }}
          {...props}
        >
          {children}
        </span>
      );
    }
    return (
      <span
        ref={ref}
        className={cn(badgeVariants({ variant, size }), className)}
        style={style}
        {...props}
      >
        {children}
      </span>
    );
  },
);
Badge.displayName = 'Badge';
