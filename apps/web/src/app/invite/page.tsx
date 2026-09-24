import { InviteAccept } from './invite-accept';

export const dynamic = 'force-dynamic';

/**
 * C-W1-3 invitation acceptance. Public and client-only on purpose: the token
 * arrives in the URL fragment (never sent to a server), is moved to session
 * storage before any sign-in redirect could drop it, and is presented to the
 * BFF only by a signed-in user. Membership is decided by the accept RPC.
 */
export default function InvitePage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-mist-100 p-4">
      <InviteAccept />
    </div>
  );
}
