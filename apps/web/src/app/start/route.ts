import { NextResponse, type NextRequest } from 'next/server';
import { Capability, can } from '@axiom/types';
import { requireTenantContext } from '@/lib/tenant-context';

export const dynamic = 'force-dynamic';

/**
 * Landing after sign-in when no page was requested. The Axiom founder opens the
 * Agent Workbench; every client-organisation user, whatever their role, opens
 * the Client Portal. The same two checks as `requireInternalContext()`.
 */
export async function GET(request: NextRequest) {
  const ctx = await requireTenantContext();
  const founder = ctx.isAxiomInternal && can(Capability.WORKBENCH_ACCESS, { role: ctx.role });
  return NextResponse.redirect(new URL(founder ? '/workbench' : '/portal', request.url));
}
