import Link from 'next/link';
import { PageHeader } from '@axiom/ui';
import { UserRole } from '@axiom/types';
import { requireCapabilityContext } from '@/lib/tenant-context';
import { routeCapability } from '../nav';
import { CatalogueEngagementClient } from './catalogue-client';

export const dynamic = 'force-dynamic';

export default async function CataloguePage() {
  const context = await requireCapabilityContext(routeCapability('/catalogue'));
  return (
    <section className="space-y-5">
      <PageHeader
        title="Catalogue & re-audit"
        description="See the catalogue recorded by your completed audits, review released changes, and follow a re-audit request. A new release never rewrites an existing assessment or report."
        actions={<Link href="/assessment">Open saved assessments</Link>}
      />
      <CatalogueEngagementClient
        key={`${context.tenantId}/${context.userId}`}
        tenantId={context.tenantId}
        actorId={context.userId}
        canRequest={context.role === UserRole.OWNER}
        canDecide={false}
      />
    </section>
  );
}
