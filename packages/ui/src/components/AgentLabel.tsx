import { cn } from '../utils';
import { AgentIcon, type AgentIconState } from './AgentIcon';
import { AGENT_PERSONAS } from './AgentPill';

export interface AgentLabelProps {
  /** An agent key such as `drishti`; any string is accepted, as for AgentIcon. */
  agent: string;
  /**
   * `idle` is the static icon and the default. `thinking` and `working` animate it and
   * must come from a real run: a screen that is merely about an agent shows it static.
   */
  state?: AgentIconState;
  size?: 'xs' | 'sm';
  /** `dark` for indigo banners. */
  tone?: 'light' | 'dark';
  /** Append the agent's persona, for example "· Discovery". */
  showPersona?: boolean;
  className?: string;
}

/**
 * The one way to show an agent's identity in a header: its icon, then its name. Using it
 * everywhere keeps size, spacing and the static-versus-animated rule consistent.
 */
export function AgentLabel({
  agent,
  state = 'idle',
  size = 'sm',
  tone = 'light',
  showPersona = false,
  className,
}: AgentLabelProps) {
  const persona = AGENT_PERSONAS[agent as keyof typeof AGENT_PERSONAS]?.persona;
  const dark = tone === 'dark';
  return (
    <span
      data-testid="agent-label"
      data-agent={agent}
      data-state={state}
      className={cn('inline-flex items-center gap-2', className)}
    >
      <AgentIcon
        agent={agent}
        state={state}
        size={size}
        variant={dark ? 'on-dark' : 'default'}
        // A static icon names the persona; only a live state may say what the agent is doing.
        title={state === 'idle' ? (persona ?? agent) : `${agent} (${state})`}
      />
      <span
        className={cn(
          'font-heading font-semibold capitalize',
          dark ? 'text-white' : 'text-slate-800',
        )}
      >
        {agent}
      </span>
      {showPersona && persona && (
        <span className={cn('text-sm font-normal', dark ? 'text-slate-300' : 'text-slate-500')}>
          · {persona}
        </span>
      )}
    </span>
  );
}
