import { ModuleContext } from '@axiom/ui';
import { moduleMeta, type ModuleKey } from './module-meta';

/** The shared context line for a module: section, Hindi name, phase, id and related agents. */
export function ModuleContextFor({
  module,
  tone,
  className,
}: {
  module: ModuleKey;
  tone?: 'light' | 'dark';
  className?: string;
}) {
  const meta = moduleMeta(module);
  return (
    <ModuleContext
      crumb={meta.section}
      titleHi={meta.hi}
      phase={meta.phase}
      moduleId={meta.moduleId}
      agents={meta.agents}
      tone={tone}
      className={className}
    />
  );
}
