import Link from 'next/link';
import { DataFlowAvailability } from '../datamap/flows/flow-availability';
import { Capability, can } from '@axiom/types';
import { PageHeader } from '@axiom/ui';
import { requireCapabilityContext } from '@/lib/tenant-context';
import { EstateClient, type EstateRow, type SystemRow, type IntakeRow } from './estate-client';
import { routeCapability } from '@/app/(app)/nav';
import { moduleBarProps } from '@/lib/module-bar';

export const dynamic = 'force-dynamic';
export default async function EstatePage() {
  const ctx = await requireCapabilityContext(routeCapability('/estate'));
  const [estates, systems, intakes] = await Promise.all([
    ctx.supabase
      .from('estates')
      .select('*')
      .eq('tenant_id', ctx.tenantId)
      .order('created_at')
      .returns<EstateRow[]>(),
    ctx.supabase
      .from('estate_systems')
      .select('*,system_data_categories(category_key,source)')
      .eq('tenant_id', ctx.tenantId)
      .order('created_at')
      .returns<SystemRow[]>(),
    ctx.supabase
      .from('engagements')
      .select('id,title')
      .eq('tenant_id', ctx.tenantId)
      .is('estate_id', null)
      .eq('status', 'intake')
      .returns<IntakeRow[]>(),
  ]);
  return (
    <div className="flex w-full min-w-0 flex-col gap-6">
      <PageHeader
        module={moduleBarProps('estate')}
        title="Client Estate"
        description="Declare the systems in each assessment boundary. Inventory declarations do not establish connectivity or authorize agent execution."
      />
      <div className="flex flex-wrap gap-4">
        <DataFlowAvailability tenantId={ctx.tenantId} actorId={ctx.userId} />
        <Link href="/estate/setup" className="text-teal-700 underline">
          Onboarding setup
        </Link>
        <Link href="/estate/graph" className="text-teal-700 underline">
          Estate graph
        </Link>
        <Link href="/estate/onboarding" className="text-teal-700 underline">
          Review onboarding proposals
        </Link>
      </div>
      {estates.error ||
      systems.error ||
      intakes.error ||
      !Array.isArray(estates.data) ||
      !Array.isArray(systems.data) ||
      !Array.isArray(intakes.data) ? (
        <p role="alert">Estate inventory could not be loaded. Refresh to try again.</p>
      ) : (
        <EstateClient
          key={ctx.tenantId}
          tenantId={ctx.tenantId}
          canManage={can(Capability.ESTATE_MANAGE, { role: ctx.role })}
          estates={estates.data ?? []}
          systems={systems.data ?? []}
          intakes={intakes.data ?? []}
        />
      )}
    </div>
  );
}
