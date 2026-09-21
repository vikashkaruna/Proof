/**
 * The personas the browser journeys drive, and what each one should find.
 *
 * Shared by the seed and the specs so a journey cannot drift from the account
 * it signs in as. The expectations here are written against the capability
 * matrix in `@axiom/types`, but they are deliberately *restated* rather than
 * imported and iterated: a test that derives its expectations from the same
 * table the application reads passes whatever that table says, including
 * after someone widens it by mistake. These are the answers a human agreed
 * to, and they have to be changed by hand.
 */

export type PersonaKey =
  | 'founder'
  | 'owner'
  | 'approver'
  | 'reviewer'
  | 'viewer'
  | 'partner'
  | 'analyst'
  | 'approverScoped'
  | 'approverReplay'
  | 'ownerInMfaTenant';

export interface Persona {
  key: PersonaKey;
  /** The `user_role` value this account holds in the tenant it belongs to. */
  role: string;
  /** Which seeded tenant they are a member of. `both` means one row in each. */
  membership: 'a' | 'b' | 'both';
  /** Stable local-part; the seed appends a run-scoped suffix. */
  emailPrefix: string;
  /** Whether the plan detail page should offer this persona an approve control. */
  canApprove: boolean;
  /**
   * Whether it should offer a reject control. Deliberately separate from
   * `canApprove`: `SCOPE_NARROWED` in `@axiom/types` covers PLAN_APPROVE and
   * PLAN_EXECUTE and **not** PLAN_REJECT, so an approver narrowed to a class
   * this plan is not in keeps the ability to refuse it. Saying no is not
   * authority over a client estate; saying yes is.
   */
  canReject: boolean;
  /** Whether the workbench (internal Axiom surface) should be reachable. */
  workbench: boolean;
  /**
   * `users.is_axiom_internal`. `requireInternalContext` asks two separate
   * questions — who employs you, and what you may do — and needs both. The
   * capability alone lands on the client portal.
   */
  axiomInternal: boolean;
  /** Whether the partner portal should be reachable. */
  partnerPortal: boolean;
  /**
   * True when the seed enrols a real, active TOTP factor for this account.
   *
   * Approving ALWAYS requires a fresh step-up, whatever the tenant's login
   * policy says, so the approver needs one to complete an approval in a
   * browser at all. `mfaQuarantined` is about *login*; this is about being
   * able to satisfy a challenge once signed in.
   */
  totpEnrolled: boolean;
  /**
   * True when signing in should land on enrolment instead of the app,
   * because the tenant (or the role, for `founder`) demands a second factor
   * this account does not hold.
   */
  mfaQuarantined: boolean;
  /**
   * `approval_scopes`. **Empty means unrestricted**, matching the column
   * default and `authorize()` in `@axiom/types` — a scoped approver is one
   * with a NON-empty list that must cover the action's class.
   */
  approvalScopes: string[];
}

export const PERSONAS: readonly Persona[] = [
  {
    key: 'founder',
    role: 'founder',
    membership: 'both',
    emailPrefix: 'persona-founder',
    axiomInternal: true,
    totpEnrolled: true,
    canReject: true,
    mfaQuarantined: true,
    approvalScopes: [],
    canApprove: true,
    workbench: true,
    partnerPortal: false,
  },
  {
    key: 'owner',
    role: 'owner',
    membership: 'a',
    emailPrefix: 'persona-owner',
    axiomInternal: false,
    totpEnrolled: true,
    canReject: true,
    mfaQuarantined: false,
    approvalScopes: [],
    canApprove: true,
    workbench: false,
    partnerPortal: false,
  },
  {
    key: 'approver',
    role: 'approver',
    membership: 'a',
    emailPrefix: 'persona-approver',
    axiomInternal: false,
    totpEnrolled: true,
    canReject: true,
    mfaQuarantined: false,
    canApprove: true,
    workbench: false,
    partnerPortal: false,
    // Empty is unrestricted. This is the ordinary approver.
    approvalScopes: [],
  },
  {
    /**
     * The same role, narrowed by `approval_scopes` to a class the seeded
     * action is not in. Doc 11 recorded this column as "defined and never
     * read"; this persona is what makes that claim falsifiable, because the
     * only difference between them and `approver` is the scope list.
     */
    key: 'approverScoped',
    role: 'approver',
    membership: 'a',
    emailPrefix: 'persona-approver-scoped',
    axiomInternal: false,
    totpEnrolled: false,
    canReject: true,
    mfaQuarantined: false,
    canApprove: false,
    workbench: false,
    partnerPortal: false,
    approvalScopes: ['identity.deprovision'],
  },
  {
    key: 'reviewer',
    role: 'reviewer',
    membership: 'a',
    emailPrefix: 'persona-reviewer',
    axiomInternal: false,
    totpEnrolled: false,
    canReject: false,
    mfaQuarantined: false,
    approvalScopes: [],
    canApprove: false,
    workbench: false,
    partnerPortal: false,
  },
  {
    key: 'viewer',
    role: 'viewer',
    membership: 'a',
    emailPrefix: 'persona-viewer',
    axiomInternal: false,
    totpEnrolled: false,
    canReject: false,
    mfaQuarantined: false,
    approvalScopes: [],
    canApprove: false,
    workbench: false,
    partnerPortal: false,
  },
  {
    key: 'partner',
    role: 'partner',
    membership: 'a',
    emailPrefix: 'persona-partner',
    axiomInternal: false,
    totpEnrolled: false,
    canReject: false,
    mfaQuarantined: false,
    approvalScopes: [],
    canApprove: false,
    workbench: false,
    partnerPortal: true,
  },
  {
    key: 'analyst',
    role: 'axiom_analyst',
    membership: 'a',
    emailPrefix: 'persona-analyst',
    axiomInternal: true,
    totpEnrolled: true,
    canReject: false,
    mfaQuarantined: true,
    approvalScopes: [],
    // The maker-checker property: Axiom prepares the change, the client
    // authorises it. An analyst who could approve their own plan would
    // collapse BR-1 into a single party, and that party would be Axiom.
    canApprove: false,
    workbench: true,
    partnerPortal: false,
  },
  {
    /**
     * A second, identical approver with its own TOTP factor.
     *
     * `last_used_counter` replay defence is per FACTOR, not per challenge, so
     * two journeys approving inside the same 30-second TOTP step with one
     * account have the second correctly refused as a replay. That is the
     * product working; it is not what the replay journey is trying to
     * demonstrate, so it gets its own authenticator.
     */
    key: 'approverReplay',
    role: 'approver',
    membership: 'a',
    emailPrefix: 'persona-approver-replay',
    axiomInternal: false,
    approvalScopes: [],
    canApprove: true,
    canReject: true,
    workbench: false,
    partnerPortal: false,
    totpEnrolled: true,
    mfaQuarantined: false,
  },
  {
    /**
     * The same owner role, in the tenant that keeps the default
     * `mfa_required_roles`. Signing in lands on enrolment, not the dashboard.
     */
    key: 'ownerInMfaTenant',
    role: 'owner',
    membership: 'b',
    emailPrefix: 'persona-owner-mfa',
    axiomInternal: false,
    totpEnrolled: false,
    canReject: true,
    approvalScopes: [],
    canApprove: true,
    workbench: false,
    partnerPortal: false,
    mfaQuarantined: true,
  },
] as const;

export const personaByKey = (key: PersonaKey): Persona => {
  const found = PERSONAS.find((p) => p.key === key);
  if (!found) throw new Error(`Unknown persona: ${key}`);
  return found;
};

/** Written by the seed, read by the specs. Lives under `.axiom-runtime`. */
export interface PersonaState {
  supabaseUrl: string;
  anonKey: string;
  publishableKey: string;
  /** Needed to drive the app's own server-side client in the harness. */
  serviceKey: string;
  tenantA: { id: string; slug: string; name: string };
  tenantB: { id: string; slug: string; name: string };
  /** So tests can create their own plans in the same engagement. */
  engagementA: string;
  libraryVersion: string;
  /** A plan in tenant A with one approvable action. */
  planA: { id: string; title: string; actionId: string };
  /** A plan in tenant B, which nobody scoped to A may see. */
  planB: { id: string; title: string };
  accounts: Record<
    PersonaKey,
    {
      id: string;
      email: string;
      password: string;
      /** Base32 TOTP secret, present when `totpEnrolled`. */
      totpSecret?: string;
    }
  >;
}

export const PERSONA_STATE_PATH = '.axiom-runtime/personas/state.json';

/**
 * The MFA encryption key the harness pins.
 *
 * The seed writes `user_mfa_factors.secret_encrypted` with it and the BFF is
 * started with it, so both ends of the ring agree. It is a fixture value for a
 * disposable local stack and is never a deployed key — `loadEnv()` refuses a
 * placeholder outside local/test, and the seeded accounts live only in the
 * parity database.
 */
export const HARNESS_MFA_KEY = 'axiom-e2e-persona-harness-mfa-key-32chars';
