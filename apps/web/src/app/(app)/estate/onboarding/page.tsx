import Link from 'next/link';
import { Capability, can } from '@axiom/types';
import { PageHeader } from '@axiom/ui';
import { requireCapabilityContext } from '@/lib/tenant-context';
import { ProposalClient, type ProposalData } from './proposal-client';
import type { EstateRow } from '../estate-client';
import { z } from 'zod';
export const dynamic = 'force-dynamic';

const intakeSystemSchema = z.object({
  name: z.string(),
  type: z.string(),
  description: z.string().optional(),
  region: z.string().optional(),
  hosts_personal_data: z.boolean().optional(),
  data_categories: z.array(z.string()).optional(),
});
const proposalDataSchema: z.ZodType<ProposalData> = z.object({
  intake: z.array(intakeSystemSchema),
  proposals: z.array(
    z.object({
      id: z.string().uuid(),
      estate_id: z.string().uuid(),
      prepared_by: z.string().uuid(),
      estate_snapshot: z.object({
        id: z.string().uuid(),
        name: z.string(),
        slug: z.string(),
        description: z.string(),
        status: z.enum(['active', 'archived']),
        version: z.number().int().nonnegative(),
      }),
      source_snapshot: z.array(intakeSystemSchema),
      systems: z.array(
        z.object({
          name: z.string(),
          systemKind: z.string(),
          description: z.string(),
          externalRef: z.string().nullable(),
          dataCategories: z.array(z.string()),
        }),
      ),
      content_sha256: z.string().regex(/^[a-f0-9]{64}$/),
      status: z.enum(['pending', 'approved', 'rejected']),
      review_reason: z.string().nullable(),
      reviewed_by: z.string().nullable(),
      onboarding_proposal_systems: z.array(
        z.object({ source_index: z.number().int().nonnegative(), system_id: z.string().uuid() }),
      ),
    }),
  ),
});
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
      if (res.ok) {
        const parsed = z.object({ data: proposalDataSchema }).safeParse(await res.json());
        if (parsed.success) data = parsed.data.data;
      }
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
      {!data || estates.error || !Array.isArray(estates.data) ? (
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
