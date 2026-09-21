import Link from 'next/link';
import { Capability, can } from '@axiom/types';
import { PageHeader } from '@axiom/ui';
import { requireCapabilityContext } from '@/lib/tenant-context';
import { EstateClient, type EstateRow, type SystemRow, type IntakeRow } from './estate-client';

export const dynamic = 'force-dynamic';
export default async function EstatePage() {
  const ctx = await requireCapabilityContext(Capability.POSTURE_READ);
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
    <div className="mx-auto flex max-w-[1100px] flex-col gap-6">
      <PageHeader
        title="Client estate"
        description="Declare the systems in each assessment boundary. Inventory declarations do not establish connectivity or authorize agent execution."
      />
      <Link href="/estate/onboarding" className="text-teal-700 underline">
        Review onboarding proposals
      </Link>
      {estates.error || systems.error || intakes.error ? (
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
