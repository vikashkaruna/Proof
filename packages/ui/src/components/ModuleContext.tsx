import { type ReactNode } from 'react';
import { type AgentName } from '@axiom/design-tokens';
import { cn } from '../utils';
import { Badge } from '../primitives/Badge';
import { RelatedAgents } from './RelatedAgents';

export type ModulePhase = 'P0' | 'P1' | 'P2' | 'P3' | 'P4' | 'P5';

export interface ModuleContextProps {
  /** Where this screen sits, for example the section it belongs to. */
  crumb?: ReactNode;
  /** The module name in Hindi, shown beside the phase tag. Not part of the heading. */
  titleHi?: string;
  phase?: ModulePhase;
  moduleId?: string;
  agents?: readonly AgentName[];
  /** `dark` for use on indigo or other dark banners. */
  tone?: 'light' | 'dark';
  className?: string;
}

/**
 * The shared "where am I" line under a page title: breadcrumb, Hindi name, delivery
 * phase, module id and the related-agents strip. It renders no heading, so a page's own
 * h1 keeps its accessible name.
 */
export function ModuleContext({
  crumb,
  titleHi,
  phase,
  moduleId,
  agents = [],
  tone = 'light',
  className,
}: ModuleContextProps) {
  const hasLine = Boolean(crumb || titleHi || phase || moduleId);
  if (!hasLine && agents.length === 0) return null;
  return (
    <div data-testid="module-context" className={cn('flex flex-col gap-2', className)}>
      {hasLine && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          {crumb && (
            <span className={tone === 'dark' ? 'text-slate-300' : 'text-slate-500'}>{crumb}</span>
          )}
          {titleHi && (
            <span
              lang="hi"
              className={cn('font-medium', tone === 'dark' ? 'text-white' : 'text-slate-700')}
            >
              {titleHi}
            </span>
          )}
          {phase && (
            <Badge
              variant={tone === 'dark' ? 'neutral' : 'indigo'}
              size="sm"
              aria-label={`Delivery phase ${phase}`}
            >
              {phase}
            </Badge>
          )}
          {moduleId && (
            <span
              className={cn('font-mono', tone === 'dark' ? 'text-slate-300' : 'text-slate-500')}
              aria-label={`Module ${moduleId}`}
            >
              {moduleId}
            </span>
          )}
        </div>
      )}
      <RelatedAgents agents={agents} tone={tone} />
    </div>
  );
}
