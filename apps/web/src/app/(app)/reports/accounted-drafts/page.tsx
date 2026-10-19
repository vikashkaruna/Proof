import { requireTenantContext } from '@/lib/tenant-context';
import { AccountedDraftClient } from './draft-client';
export const dynamic = 'force-dynamic';
export default async function AccountedDraftPage() {
  const context = await requireTenantContext();
  if (context.role !== 'founder' || !context.isAxiomInternal)
    return <p role="alert">A current internal founder session is required.</p>;
  return (
    <AccountedDraftClient
      key={`${context.tenantId}:${context.userId}`}
      tenantId={context.tenantId}
      actorId={context.userId}
    />
  );
}
