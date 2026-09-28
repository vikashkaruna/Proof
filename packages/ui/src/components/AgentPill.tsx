import { agentAccents, type AgentName } from '@axiom/design-tokens';
import { cn } from '../utils';
import { AgentIcon, type AgentIconState } from './AgentIcon';

const AGENT_PERSONAS: Record<AgentName, { persona: string; emoji: string }> = {
  drishti: { persona: 'Discovery', emoji: '◎' },
  vibhaag: { persona: 'Classification', emoji: '◇' },
  parikshan: { persona: 'Assessment', emoji: '⊕' },
  saakshi: { persona: 'Evidence', emoji: '◈' },
  sudhaar: { persona: 'Remediation', emoji: '◊' },
  karya: { persona: 'Execution', emoji: '◆' },
  lekha: { persona: 'Audit', emoji: '▤' },
  nazar: { persona: 'Regulatory Watch', emoji: '◉' },
  prativedan: { persona: 'Reporting', emoji: '▥' },
  sanket: { persona: 'Market Signal', emoji: '◐' },
  samadhan: { persona: 'Reconciliation', emoji: '⚖' },
  pramaan: { persona: 'Closure Proof', emoji: '⊛' },
};

export interface AgentPillProps {
  agent: AgentName;
  state?: AgentIconState;
  showPersona?: boolean;
  className?: string;
}

export function AgentPill({
  agent,
  state = 'idle',
  showPersona = true,
  className,
}: AgentPillProps) {
  const accent = agentAccents[agent] || '#0FB5A5';
  const persona = AGENT_PERSONAS[agent];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border bg-white px-2 py-0.5 text-xs font-medium transition-all shadow-2xs',
        state === 'working' && 'ring-1 ring-offset-1',
        className,
      )}
      style={{
        borderColor: accent,
        color: accent,
        ...(state === 'working' ? { ringColor: accent } : {}),
      }}
    >
      <AgentIcon agent={agent} state={state} size="xs" className="border-0 bg-transparent" />
      <span className="font-heading capitalize text-slate-800">{agent}</span>
      {showPersona && <span className="text-slate-500 font-normal">· {persona?.persona}</span>}
    </span>
  );
}

export { AGENT_PERSONAS };
