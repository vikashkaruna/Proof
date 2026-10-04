/**
 * Regulatory updates need an authoritative source, observation time, and
 * retained citation before they can be shown as compliance intelligence.
 * No such feed is connected to this page yet. Do not substitute examples or
 * simulate a scan: a fabricated legal change could cause a real control or
 * remediation decision.
 */
import { PageHeader } from '@axiom/ui';
import { moduleBarProps } from '@/lib/module-bar';

export function RegWatchClient() {
  return (
    <section className="w-full min-w-0 space-y-6">
      <PageHeader
        module={moduleBarProps('regwatch')}
        title="Regulatory Watch"
        description="Verified statutory updates and their recorded impact on controls."
      />
      <p className="mt-3 text-sm text-slate-700" role="status" data-testid="regwatch-unavailable">
        No verified regulatory feed is connected. Statutory updates, source citations, and control
        impact assessments are unavailable until an authoritative feed and review workflow are
        configured.
      </p>
      <p className="mt-2 text-sm text-slate-600">
        Check the official authority publications directly before making a legal or compliance
        decision.
      </p>
    </section>
  );
}
