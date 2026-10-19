import Link from 'next/link';
import { PageHeader } from '@axiom/ui';
import { requireTenantContext } from '@/lib/tenant-context';
import { moduleBarProps } from '@/lib/module-bar';
import { ownedDeploymentAccess } from '@/lib/owned-deployment-access';
import { Notice } from '@/components/workflow-blocks';
import { OwnedDeploymentClient } from './owned-deployment-client';
export const dynamic = 'force-dynamic';
export default async function OwnedTargetsPage() {
  const ctx = await requireTenantContext();
  const access = ownedDeploymentAccess(ctx.role, ctx.isAxiomInternal);
  if (!access.available)
    return (
      <Notice tone="warning">
        Demo execution setup is available to owners, administrators and internal founders on an
        enabled local stack.
      </Notice>
    );
  const result = await ctx.supabase
    .from('engagements')
    .select('id, title')
    .eq('tenant_id', ctx.tenantId)
    .neq('status', 'cancelled')
    .order('created_at', { ascending: false })
    .limit(20);
  return (
    <div className="flex w-full min-w-0 flex-col gap-5">
      <PageHeader
        module={moduleBarProps('settings')}
        title="Demo execution setup"
        description="Prepare a restricted synthetic target, review its checks, obtain founder approval, then confirm installation."
        actions={<Link href="/plans">View remediation plans</Link>}
      />
      <Notice>
        Setup prepares one synthetic audit setting for an approved demonstration. It does not change
        the setting, approve a remediation plan, or establish compliance.
      </Notice>
      {result.error && (
        <Notice tone="warning" role="alert">
          Engagements are unavailable. Existing setup requests can still be checked.
        </Notice>
      )}
      <OwnedDeploymentClient
        key={`${ctx.tenantId}:${ctx.userId}`}
        tenantId={ctx.tenantId}
        actorId={ctx.userId}
        founder={access.founder}
        engagements={result.data ?? []}
      />
    </div>
  );
}
