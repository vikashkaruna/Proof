import { type AgentName } from '@axiom/design-tokens';
import { cn } from '../utils';
import { AGENT_PERSONAS, AgentPill } from './AgentPill';

export interface RelatedAgentsProps {
  agents: readonly AgentName[];
  label?: string;
  /** `dark` for use on indigo or other dark banners. */
  tone?: 'light' | 'dark';
  className?: string;
}

/**
 * The agents that work on a module. Names and personas only: this strip states which
 * agents are involved, never whether they are online, running or healthy.
 */
export function RelatedAgents({
  agents,
  label = 'Agents on this module',
  tone = 'light',
  className,
}: RelatedAgentsProps) {
  if (agents.length === 0) return null;
  return (
    <section
      aria-label={label}
      data-testid="related-agents"
      className={cn('flex flex-wrap items-center gap-2', className)}
    >
      <span
        className={cn(
          'text-xs font-medium uppercase tracking-wider',
          tone === 'dark' ? 'text-slate-300' : 'text-slate-500',
        )}
      >
        {label}
      </span>
      <ul className="flex flex-wrap items-center gap-2">
        {agents.map((agent) => (
          <li key={agent}>
            <AgentPill agent={agent} title={AGENT_PERSONAS[agent]?.persona ?? agent} />
          </li>
        ))}
      </ul>
      <span className={cn('text-xs', tone === 'dark' ? 'text-slate-300' : 'text-slate-500')}>
        Agents propose; nothing changes without a recorded human approval.
      </span>
    </section>
  );
}
