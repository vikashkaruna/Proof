import Link from 'next/link';
import { PageHeader } from '@axiom/ui';
import { requireTenantContext } from '@/lib/tenant-context';
import { moduleBarProps } from '@/lib/module-bar';
import { Notice } from '@/components/workflow-blocks';
import { LocalCustodyClient } from './local-custody-client';
export const dynamic = 'force-dynamic';
export default async function LocalCustodyPage() {
  const ctx = await requireTenantContext();
  if (
    ctx.role !== 'owner' &&
    !(ctx.isAxiomInternal && (ctx.role === 'founder' || ctx.role === 'axiom_analyst'))
  )
    return (
      <Notice tone="warning" role="alert">
        Local custody policies are available to customer owners, internal founders and nominated
        internal operators.
      </Notice>
    );
  return (
    <div className="flex w-full min-w-0 flex-col gap-5">
      <PageHeader
        module={moduleBarProps('settings')}
        title="Local dispatch-key custody"
        description="Review the custody policy for this organisation's dispatch keys, then request, approve, activate or review it. Every recorded step needs a fresh authenticator code."
        actions={<Link href="/settings/security">Manage authenticator and recovery codes</Link>}
      />
      <LocalCustodyClient
        key={ctx.tenantId + ':' + ctx.userId}
        tenantId={ctx.tenantId}
        actorId={ctx.userId}
        tenantSlug={ctx.tenantSlug}
      />
    </div>
  );
}
