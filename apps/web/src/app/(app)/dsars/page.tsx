import { Capability, can } from '@axiom/types';
import { z } from 'zod';
import { requireTenantContext } from '@/lib/tenant-context';
import { DsarClient } from './dsar-client';
import { dsarRowSchema, type DsarRow } from './dsar-workflow';

export const dynamic = 'force-dynamic';

export default async function DsarPage() {
  const { supabase, tenantId, role } = await requireTenantContext();
  const canRead = can(Capability.POSTURE_READ, { role });
  const canManage = can(Capability.ESTATE_MANAGE, { role });
  let rows: DsarRow[] = [];
  let error: string | null = canRead ? null : 'Your role cannot view rights requests.';
  let hasMore = false;
  if (canRead) {
    try {
      const result = await supabase
        .from('dsars')
        .select(
          'id, kind, status, data_principal_name, data_principal_email, data_principal_phone, identity_verified, identity_verification_method, due_by, received_at, completed_at, rejection_reason, notes',
        )
        .eq('tenant_id', tenantId)
        .order('due_by', { ascending: true })
        .order('id', { ascending: true })
        .limit(201);
      const parsed = z.array(dsarRowSchema).safeParse(result.data);
      if (result.error || !parsed.success)
        error = 'Rights requests could not be loaded. Refresh to try again.';
      else {
        rows = parsed.data.slice(0, 200);
        hasMore = parsed.data.length > 200;
      }
    } catch {
      error = 'Rights requests could not be loaded. Refresh to try again.';
    }
  }
  // A single request-time snapshot keeps the server HTML and hydrated deadline labels identical.
  // eslint-disable-next-line react-hooks/purity -- async, force-dynamic server page, not a client render clock
  const asOf = Date.now();
  return (
    <DsarClient
      key={tenantId}
      tenantId={tenantId}
      rows={rows}
      canManage={canManage && !error}
      loadError={error}
      hasMore={hasMore}
      asOf={asOf}
    />
  );
}
