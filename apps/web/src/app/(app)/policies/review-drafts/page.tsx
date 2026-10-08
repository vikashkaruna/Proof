import Link from 'next/link';
import { Capability, can } from '@axiom/types';
import { PageHeader } from '@axiom/ui';
import { requireCapabilityContext } from '@/lib/tenant-context';
import { moduleBarProps } from '@/lib/module-bar';
import { ReviewDraftPanel } from './panel';
export const dynamic = 'force-dynamic';
export default async function ReviewDraftsPage() {
  const { tenantId, userId, role } = await requireCapabilityContext(Capability.AGENT_INVOKE);
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader
        module={moduleBarProps('policies')}
        title="Agent review drafts"
        description="Prepare review artifacts from retained human processing declarations and reported task time."
      />
      <nav aria-label="Review draft navigation" className="flex flex-wrap gap-4 text-sm">
        <Link className="text-indigo-700 underline" href="/datamap">
          Record processing activities and reported tasks
        </Link>
        <Link className="text-indigo-700 underline" href="/policies">
          Review saved policy drafts
        </Link>
      </nav>
      <ReviewDraftPanel
        tenantId={tenantId}
        actorId={userId}
        canSavePolicy={can(Capability.ESTATE_MANAGE, { role })}
      />
    </div>
  );
}
