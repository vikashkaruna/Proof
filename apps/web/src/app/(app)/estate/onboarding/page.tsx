import Link from 'next/link';
import { Capability, can } from '@axiom/types';
import { PageHeader } from '@axiom/ui';
import { requireCapabilityContext } from '@/lib/tenant-context';
import { ProposalClient, type ProposalData } from './proposal-client';
import type { EstateRow } from '../estate-client';
export const dynamic = 'force-dynamic';
export default async function OnboardingProposalsPage() {
  const ctx = await requireCapabilityContext(Capability.POSTURE_READ);
  const {
    data: { session },
  } = await ctx.supabase.auth.getSession();
  const estates = await ctx.supabase
    .from('estates')
    .select('*')
    .eq('tenant_id', ctx.tenantId)
    .eq('status', 'active')
    .returns<EstateRow[]>();
  let data: ProposalData | null = null;
  if (session) {
    try {
      const res = await fetch(
        `${(process.env.BFF_PUBLIC_URL ?? 'http://localhost:4000').replace(/\/$/, '')}/v1/onboarding/proposals`,
        {
          headers: { Authorization: `Bearer ${session.access_token}`, 'X-Tenant-Id': ctx.tenantId },
          cache: 'no-store',
        },
      );
      if (res.ok) data = ((await res.json()) as { data: ProposalData }).data;
    } catch {
      /* Render a visible failure rather than a fabricated empty intake. */
    }
  }
  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-6">
      <PageHeader
        title="Onboarding proposals"
        description="Axiom staff prepare the inventory. A client owner or admin reviews the original intake and proposed mappings before systems are added."
      />
      <Link href="/estate" className="text-teal-700 underline">
        Back to estate inventory
      </Link>
      {!data || estates.error ? (
        <p role="alert">Onboarding proposals could not be loaded. Refresh to try again.</p>
      ) : (
        <ProposalClient
          key={ctx.tenantId}
          tenantId={ctx.tenantId}
          userId={ctx.userId}
          canPrepare={can(Capability.ONBOARDING_PREPARE, { role: ctx.role })}
          canReview={can(Capability.ONBOARDING_REVIEW, { role: ctx.role })}
          estates={estates.data ?? []}
          data={data}
        />
      )}
    </div>
  );
}
