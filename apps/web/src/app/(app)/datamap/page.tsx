import { DataFlowAvailability } from './flows/flow-availability';
import { GenericModuleView } from '../generic-module-view';
import { Capability, can } from '@axiom/types';
import { requireCapabilityContext } from '@/lib/tenant-context';
import { WorkflowPanel } from '../operator-workflows/panel';
import { routeCapability } from '@/app/(app)/nav';

export const dynamic = 'force-dynamic';

export default async function DataMapPage() {
  const { tenantId, userId, role } = await requireCapabilityContext(routeCapability('/datamap'));
  return (
    <GenericModuleView
      meta={{
        moduleKey: 'datamap',
        title: 'Data Map & RoPA',
        hi: 'डेटा मानचित्र',
        phase: 'P1',
        agent: 'Vibhaag + Drishti',
        agentKey: 'vibhaag',
        autonomy: 'L1',
        moduleId: 'M1.3',
        desc: 'Capture reviewable processing activities with explicit unknowns and retained sources. Record delivery work and time to prioritise the automation backlog.',
        cards: [],
      }}
    >
      <DataFlowAvailability tenantId={tenantId} actorId={userId} />
      <WorkflowPanel
        tenantId={tenantId}
        actorId={userId}
        kind="ropa"
        canWrite={can(Capability.ESTATE_MANAGE, { role })}
      />
      <WorkflowPanel
        tenantId={tenantId}
        actorId={userId}
        kind="delivery_task"
        canWrite={can(Capability.ESTATE_MANAGE, { role })}
      />
    </GenericModuleView>
  );
}
