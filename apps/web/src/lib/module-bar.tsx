import { ModuleBar, type ModuleBarProps } from '@axiom/ui';
import { moduleMeta, type ModuleKey } from './module-meta';

export function moduleBarProps(module: ModuleKey): ModuleBarProps {
  const meta = moduleMeta(module);
  return {
    crumb: meta.section,
    titleHi: meta.hi,
    phase: meta.phase,
    moduleId: meta.moduleId,
    agents: meta.agents,
  };
}

/** The shared context line for a module: section, Hindi name, phase, id and related agents. */
export function ModuleBarFor({
  module,
  tone,
  omit = [],
  className,
}: {
  module: ModuleKey;
  tone?: 'light' | 'dark';
  /** Leave out parts the page already shows in its own banner, so nothing prints twice. */
  omit?: readonly ('hi' | 'moduleId')[];
  className?: string;
}) {
  const context = moduleBarProps(module);
  return (
    <ModuleBar
      {...context}
      titleHi={omit.includes('hi') ? undefined : context.titleHi}
      moduleId={omit.includes('moduleId') ? undefined : context.moduleId}
      tone={tone}
      className={className}
    />
  );
}
