import { ModuleContext } from '@axiom/ui';
import { moduleMeta, type ModuleKey } from './module-meta';

/** The shared context line for a module: section, Hindi name, phase, id and related agents. */
export function ModuleContextFor({
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
  const meta = moduleMeta(module);
  return (
    <ModuleContext
      crumb={meta.section}
      titleHi={omit.includes('hi') ? undefined : meta.hi}
      phase={meta.phase}
      moduleId={omit.includes('moduleId') ? undefined : meta.moduleId}
      agents={meta.agents}
      tone={tone}
      className={className}
    />
  );
}
