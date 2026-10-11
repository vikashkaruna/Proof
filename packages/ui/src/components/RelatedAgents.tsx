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
 * The agents that work on a module. Names and icons only: this strip states which
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
      className={cn(
        'flex min-w-0 max-w-full flex-wrap items-center',
        tone === 'dark' ? 'text-slate-300' : 'text-slate-500',
        className,
      )}
    >
      <ul className="flex min-w-0 flex-wrap items-center gap-2">
        {agents.map((agent) => (
          <li key={agent}>
            <AgentPill
              agent={agent}
              showPersona={false}
              title={AGENT_PERSONAS[agent]?.persona ?? agent}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
