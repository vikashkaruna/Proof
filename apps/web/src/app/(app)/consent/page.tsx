import { Capability, can } from '@axiom/types';
import { requireTenantContext } from '@/lib/tenant-context';
import { ConsentClient } from './consent-client';

export const dynamic = 'force-dynamic';

export default async function ConsentPage() {
  const { tenantId, role } = await requireTenantContext();
  if (!can(Capability.POSTURE_READ, { role }))
    return <p role="alert">Your role cannot view consent records.</p>;
  return (
    <ConsentClient
      key={tenantId}
      tenantId={tenantId}
      canManage={can(Capability.ESTATE_MANAGE, { role })}
    />
  );
}
