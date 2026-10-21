import Link from 'next/link';
import { PageHeader } from '@axiom/ui';
import { requireInternalContext } from '@/lib/tenant-context';
import { CatalogueVersionsClient } from './versions-client';
import { CatalogueEngagementClient } from '../../catalogue/catalogue-client';
export const dynamic = 'force-dynamic';
export default async function CatalogueVersionsPage() {
  const ctx = await requireInternalContext();
  if (ctx.role !== 'founder')
    return <p role="alert">Catalogue approval requires an internal founder.</p>;
  return (
    <section className="space-y-4">
      <PageHeader
        title="Catalogue versions"
        description="Review published controls and approve a specific version with your authenticator. Approval releases that exact version globally; changing the default for first assessments remains separate. Audited organizations retain their basis until an owner-requested re-audit is approved."
        actions={<Link href="/workbench">Back to Workbench</Link>}
      />
      <CatalogueVersionsClient
        key={`${ctx.tenantId}/${ctx.userId}`}
        tenantId={ctx.tenantId}
        actorId={ctx.userId}
      />
      <section className="border-t border-slate-200 pt-5" aria-label="Company re-audit decisions">
        <p className="mb-4 text-sm text-slate-600">
          Use the company selector to review each organization’s audited basis and owner requests.
          Approving a re-audit opens a separate engagement; new reports follow actual audit results
          and their own review and release.
        </p>
        <CatalogueEngagementClient
          key={`${ctx.tenantId}/${ctx.userId}/engagement`}
          tenantId={ctx.tenantId}
          actorId={ctx.userId}
          canRequest={false}
          canDecide
        />
      </section>
    </section>
  );
}
