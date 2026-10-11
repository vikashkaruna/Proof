import { RegWatchClient } from './regwatch-client';
import { requireCapabilityContext } from '@/lib/tenant-context';
import { routeCapability } from '@/app/(app)/nav';

export const dynamic = 'force-dynamic';

export default async function RegWatchPage() {
  await requireCapabilityContext(routeCapability('/regwatch'));
  return <RegWatchClient />;
}
