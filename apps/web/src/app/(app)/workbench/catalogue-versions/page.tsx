import Link from 'next/link';
import { PageHeader } from '@axiom/ui';
import { requireInternalContext } from '@/lib/tenant-context';
import { CatalogueVersionsClient } from './versions-client';
export const dynamic = 'force-dynamic';
export default async function CatalogueVersionsPage() {
  const ctx = await requireInternalContext();
  if (ctx.role !== 'founder')
    return <p role="alert">Catalogue approval requires an internal founder.</p>;
  return (
    <section className="space-y-4">
      <PageHeader
        title="Catalogue versions"
        description="Review published controls and approve a specific version with your authenticator. Approval enables that version for assessment provenance; changing the current version and adopting it for an organisation are separate steps."
        actions={<Link href="/workbench">Back to Workbench</Link>}
      />
      <CatalogueVersionsClient
        key={`${ctx.tenantId}/${ctx.userId}`}
        tenantId={ctx.tenantId}
        actorId={ctx.userId}
      />
    </section>
  );
}
