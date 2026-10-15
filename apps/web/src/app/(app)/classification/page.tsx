import { GenericModuleView, type ModuleTelemetryEvent } from '../generic-module-view';
import { requireCapabilityContext, Capability } from '@/lib/tenant-context';
import { can, UserRole } from '@axiom/types';
import { PublicSourceWorkflow } from '../public-source-workflow/source-workflow';
import { DataPlaceholder } from '@axiom/ui';
import { loadClassificationReviewHistory } from '@/lib/classification-reviews';
import { ClassificationReviewHistoryView } from './review-history';
import { routeCapability } from '@/app/(app)/nav';

export const dynamic = 'force-dynamic';

export default async function ClassificationPage({
  searchParams,
}: {
  searchParams?: Promise<{ reviewPage?: string | string[] }>;
} = {}) {
  const { supabase, tenantId, userId, role, isAxiomInternal } = await requireCapabilityContext(
    routeCapability('/classification'),
  );
  const reviewPage = (await searchParams)?.reviewPage;
  const [{ data, error }, history] = await Promise.all([
    supabase
      .from('audit_ledger')
      .select(
        'sequence_no, correlation_id, action_type, target_ref, occurred_at, entry_hash, result',
      )
      .eq('tenant_id', tenantId)
      .eq('actor_id', 'vibhaag')
      .order('sequence_no', { ascending: false })
      .limit(6),
    loadClassificationReviewHistory(supabase, tenantId, reviewPage),
  ]);
  const events: ModuleTelemetryEvent[] =
    error || !data
      ? []
      : data.map((row) => ({
          seq: row.sequence_no,
          title: row.action_type,
          detail: row.correlation_id
            ? `Correlation: ${row.correlation_id}`
            : 'No correlation ID recorded',
          time: row.occurred_at || 'Time unavailable',
          target: row.target_ref || undefined,
          hash: row.entry_hash || undefined,
          status: row.result || 'Result unavailable',
        }));
  return (
    <GenericModuleView
      meta={{
        moduleKey: 'classification',
        title: 'Data Classification',
        hi: 'वर्गीकरण',
        phase: 'P1',
        agent: 'Vibhaag',
        agentKey: 'vibhaag',
        autonomy: 'L1',
        moduleId: 'M2.3',
        desc: 'Review recorded classification activity. Field counts and categories require observed source data.',
        actionLabel: 'Review estate setup',
        actionHref: can(Capability.ESTATE_MANAGE, { role }) ? '/estate/setup' : undefined,
        cards: [],
        recentEvents: events,
        telemetryTitle: 'Recorded Classification Events',
      }}
    >
      <PublicSourceWorkflow
        tenantId={tenantId}
        actorId={userId}
        canCapture={
          can(Capability.CONNECTOR_MANAGE, { role }) &&
          (role !== UserRole.FOUNDER || isAxiomInternal)
        }
        canReview={
          can(Capability.ASSESSMENT_RUN, { role }) &&
          ((role !== UserRole.FOUNDER && role !== UserRole.AXIOM_ANALYST) || isAxiomInternal)
        }
        canInvoke={
          can(Capability.AGENT_INVOKE, { role }) &&
          ((role !== UserRole.FOUNDER && role !== UserRole.AXIOM_ANALYST) || isAxiomInternal)
        }
      />
      <ClassificationReviewHistoryView history={history} />
      {error || !data ? (
        <p role="alert">Classification ledger records are unavailable.</p>
      ) : events.length === 0 ? (
        <DataPlaceholder title="No classification events recorded for this tenant." />
      ) : null}
    </GenericModuleView>
  );
}
