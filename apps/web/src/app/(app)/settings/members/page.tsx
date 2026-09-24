import { Capability } from '@axiom/types';
import { PageHeader } from '@axiom/ui';
import { requireCapabilityContext } from '@/lib/tenant-context';
import { MembersClient, type InvitationRow, type MemberRow } from './members-client';

export const dynamic = 'force-dynamic';

/** C-W1-3: tenant members and invitations. Reads run under the caller's RLS. */
export default async function MembersPage() {
  const ctx = await requireCapabilityContext(Capability.USER_MANAGE);
  const [members, invitations] = await Promise.all([
    ctx.supabase
      .from('tenant_users')
      .select('user_id, role, accepted_at, users:user_id(email)')
      .eq('tenant_id', ctx.tenantId)
      .order('invited_at'),
    ctx.supabase
      .from('tenant_invitations')
      .select(
        'id, email, role, approval_scopes, created_at, expires_at, accepted_at, revoked_at, delivery_status',
      )
      .eq('tenant_id', ctx.tenantId)
      .order('created_at', { ascending: false })
      .limit(100)
      .returns<InvitationRow[]>(),
  ]);
  const memberRows: MemberRow[] = (members.data ?? []).map((m) => {
    const user = Array.isArray(m.users) ? m.users[0] : m.users;
    return {
      userId: m.user_id,
      email: (user as { email?: string } | null)?.email ?? m.user_id,
      role: m.role,
      acceptedAt: m.accepted_at,
    };
  });
  return (
    <div className="mx-auto flex max-w-[1000px] flex-col gap-6">
      <PageHeader
        title="Members and invitations"
        description={`Invite people to ${ctx.tenantName}. An invitation grants its role only when accepted by the invited, signed-in email address.`}
      />
      {members.error || invitations.error ? (
        <p role="alert">Members could not be loaded. Refresh to try again.</p>
      ) : (
        <MembersClient
          key={ctx.tenantId}
          tenantId={ctx.tenantId}
          canInviteOwners={ctx.role === 'owner' || ctx.role === 'founder'}
          members={memberRows}
          invitations={invitations.data ?? []}
        />
      )}
    </div>
  );
}
