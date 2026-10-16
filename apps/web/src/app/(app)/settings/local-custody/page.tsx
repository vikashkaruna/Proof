import { requireTenantContext } from '@/lib/tenant-context';
import { LocalCustodyClient } from './local-custody-client';
export const dynamic = 'force-dynamic';
export default async function LocalCustodyPage() {
  const ctx = await requireTenantContext();
  if (
    ctx.role !== 'owner' &&
    !(ctx.isAxiomInternal && (ctx.role === 'founder' || ctx.role === 'axiom_analyst'))
  )
    return (
      <p role="alert">
        Local custody policies are available to customer owners, internal founders and nominated
        internal operators.
      </p>
    );
  return (
    <main className="space-y-5">
      <h1>Local dispatch-key custody</h1>
      <LocalCustodyClient
        key={ctx.tenantId + ':' + ctx.userId}
        tenantId={ctx.tenantId}
        actorId={ctx.userId}
      />
    </main>
  );
}
