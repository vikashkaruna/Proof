# Revision 78 — C-W1-3 tenant invitations

## Scope and decisions

C-W1-3 is the remaining W1 engineering item. The plan (Doc 16, W1-2) gates _real email delivery_ on provider/domain evidence, not on the internal workflow and adapter contract. This revision delivers the workflow and the contract. Delivery stays disabled by default.

Operator input was not received. These choices follow the recommended options and are recorded here:

1. **Invitable roles** are `owner`, `admin`, `approver`, `reviewer` and `viewer`.
   - Owners and the founder may grant any of them.
   - Admins may grant `approver`, `reviewer` and `viewer`, but not `owner` or `admin`.
   - Internal roles (`founder`, `axiom_analyst`, `agent`) and `partner` are provisioned explicitly and are never granted by invitation. Partner access belongs to W6.5 assigned-client work.
2. **Approval scopes** may be set only for approvers.
3. **Lifetime** defaults to 72 hours and is bounded to 14 days.
4. **Acceptance** requires signing in as the invited, **confirmed** email address.
5. **When mail is disabled or fails,** the inviter receives the one-time link once, to share out of band. The server stores only the SHA-256 of the token.
6. Email OTP remains deferred. An invitation is not an authentication factor or a magic link.

## Change

**Migration 0053** adds `tenant_invitations`.

- The table stores the token hash, never the token.
- The email must be lower-case. The role set is restricted, and the lifetime and delivery status are bounded by check constraints.
- A partial unique index allows one open invitation per tenant and address.
- A trigger makes invitation content immutable and settles acceptance and revocation once. Delete is refused, including for privileged sessions.
- The service role can only read the table and settle delivery columns on `pending` rows.
- Owners and admins can read their tenant's invitations in session. Column grants exclude `token_hash`.

**RPCs.** Three security-definer functions, callable only by the service role, each write their ledger event in the same transaction:

- **`create_tenant_invitation`**
  - Locks and re-checks the inviter's membership, then applies role grantability and scope rules.
  - Refuses existing members.
  - Serializes creation per tenant and address, and closes an expired open invitation before creating its replacement.
  - The ledger entry records a SHA-256 of the address, not the address itself.
- **`revoke_tenant_invitation`**
  - Checks the same authority rules; an admin cannot revoke an owner invitation.
- **`accept_tenant_invitation`**
  - Locks the invitation by token hash.
  - Checks the invited address before revealing any status, and requires a confirmed email.
  - Creates the missing `public.users` mirror; production sign-ups previously had none.
  - Inserts the membership with the invited role and scopes, and marks the invitation accepted.
  - A replay by the same user is idempotent; any other account is refused.

**BFF.**

- `GET` / `POST /v1/tenant/invitations` and `POST /v1/tenant/invitations/:id/revoke` require `USER_MANAGE`.
- `POST /v1/invitations/accept` is tenantless: it takes no tenant scope and no role from headers. Attempts are rate-limited to 20 per user per hour, and the route fails closed when the rate budget is unavailable.
- Mail adapter (`AXIOM_INVITATION_EMAIL_MODE=delivery` opt-in):
  - One provider attempt; `sent` only with a provider receipt, and then the token is withheld from the response.
  - The link carries the token in the URL fragment.

**Web.**

- `/settings/members` lists members and invitations, sends invitations, shows the one-time link, and supports revocation. It is linked from Settings for `USER_MANAGE` roles.
- `/invite` is a public, client-only page.
  - It moves the fragment token into session storage and strips it from the address bar.
  - It sends a signed-out user to sign in and accepts on return.
  - It calls the BFF with `redirect: 'manual'`, because the auth middleware answers signed-out API calls with a redirect rather than a 401.
- The BFF proxy treats `POST /v1/invitations/accept` as tenantless.

**Security hardening found on the way.** After sign-in, the login action passed the `redirect` form value straight to `redirect()`, which is an open redirect. It and the already-signed-in branch of the login page now use `safeRedirectPath`, which allows only same-origin absolute paths. It rejects `//host`, backslashes and control characters, and has unit tests.

**Deployment.**

- New BFF settings `AXIOM_INVITATION_EMAIL_MODE`, via Terraform variable `invitation_email_mode` (default `disabled`), and `AXIOM_WEB_APP_URL`.
- Wired through Cloud Run, Helm, Compose, `sync-env.sh` and the environment examples. The tfvars coverage gate now counts 31 preprod variables.

## Verification

All results below come from the isolated Docker/Supabase parity stack in the session container.

| Check                                                                                                                                           | Result                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full database suite                                                                                                                             | **pass**. Includes the new `tenant-invitations.test.sql` (authority, escalation, scopes, membership, audit without address or token, email binding, confirmation, revocation, expiry replacement, immutability, session column privileges) and `concurrent-invitation.sh` (two real sessions: one open invitation per address; one acceptance, membership and audit event, with a replayed second accept). |
| BFF tests                                                                                                                                       | **1,038** (15 new invitation route cases, 1 new tenantless-middleware case)                                                                                                                                                                                                                                                                                                                                |
| Web tests                                                                                                                                       | 85 (new `safeRedirectPath` cases)                                                                                                                                                                                                                                                                                                                                                                          |
| Workspace typecheck, lint, test and Prettier; `terraform fmt`; tfvars, env-security, MFA-ring and auth-wiring gates; deployment unittests (214) | **pass**                                                                                                                                                                                                                                                                                                                                                                                                   |
| Playwright on the real stack                                                                                                                    | **70 journeys** (2 new invitation journeys)                                                                                                                                                                                                                                                                                                                                                                |

The two new invitation journeys cover:

- **Admin invites, invitee accepts.** An admin invites; the invitee (an auth identity with no profile or membership) opens the link while signed out, signs in, accepts, and becomes a member. A replay by the invitee is harmless, and the admin sees "Accepted".
- **Refusals.** Another account is refused, an admin is not offered the owner role, and a revoked invitation grants nothing.

In one full run, the pre-existing MFA recovery journey hit an `ECONNRESET` from the local `next dev` server. That spec then passed 18/18 across two repeats.

## Limits

- Real provider delivery and sending-domain SPF/DKIM remain the operator's W1-2 evidence gate.
- Deployed acceptance of invitations is part of W1 remote acceptance.
- Membership removal and role changes for existing members are not part of this item.
