import { redirect } from 'next/navigation';
import { Capability, can } from '@axiom/types';
import { requireTenantContext } from '@/lib/tenant-context';

export const dynamic = 'force-dynamic';

/**
 * Landing after sign-in when no page was requested. The Axiom founder opens the
 * Agent Workbench; every client-organisation user, whatever their role, opens
 * the Client Portal. The same two checks as `requireInternalContext()`.
 *
 * A page, not a route handler: `redirect()` emits a relative location, whereas
 * a handler building `new URL(path, request.url)` used the container's own
 * origin behind a published port and sent the browser to a cookieless host.
 */
export default async function StartPage(): Promise<never> {
  const ctx = await requireTenantContext();
  const founder = ctx.isAxiomInternal && can(Capability.WORKBENCH_ACCESS, { role: ctx.role });
  redirect(founder ? '/workbench' : '/portal');
}
