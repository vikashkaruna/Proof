import { describe, it, expect } from 'vitest';
import { UserRole } from './enums';
import { Capability, authorize, can, capabilitiesFor, rolesWith } from './rbac';

/**
 * W1 · SEC-9 — RBAC was four inline string comparisons in the BFF and zero
 * checks in the web app.
 *
 * The matrix is data, so it can be asserted exhaustively. These tests are the
 * readable statement of who can do what: if the matrix changes, the diff here
 * says exactly which authority moved.
 */

const ALL_ROLES = Object.values(UserRole);

describe('the approval chain — the capabilities that matter', () => {
  // The single most important assertion in the file.
  it('lets only founder, owner, admin and approver approve a plan', () => {
    expect(rolesWith(Capability.PLAN_APPROVE).sort()).toEqual(
      ['admin', 'approver', 'founder', 'owner'].sort(),
    );
  });

  it.each(['viewer', 'reviewer', 'partner', 'agent'] as const)(
    'refuses plan approval to %s',
    (role) => {
      expect(can(Capability.PLAN_APPROVE, { role })).toBe(false);
    },
  );

  // A reviewer's entire purpose is to review without approving. If this ever
  // passes, the maker-checker property is gone.
  it('lets a reviewer comment but never approve', () => {
    expect(can(Capability.PLAN_COMMENT, { role: UserRole.REVIEWER })).toBe(true);
    expect(can(Capability.PLAN_APPROVE, { role: UserRole.REVIEWER })).toBe(false);
  });

  it('does not let an approver create the plan it approves (BR-1)', () => {
    expect(can(Capability.PLAN_APPROVE, { role: UserRole.APPROVER })).toBe(true);
    expect(can(Capability.PLAN_CREATE, { role: UserRole.APPROVER })).toBe(false);
  });
});

describe('the kill switch — SEC-4', () => {
  it('lets only the founder engage or release globally', () => {
    expect(rolesWith(Capability.KILL_SWITCH_ENGAGE_GLOBAL)).toEqual(['founder']);
    expect(rolesWith(Capability.KILL_SWITCH_RELEASE_GLOBAL)).toEqual(['founder']);
  });

  // The specific SEC-4 defect: a tenant owner could release a founder's
  // platform-wide halt. `owner` is a per-tenant role and is not authority over
  // other tenants' execution.
  it('does not let a tenant owner touch the global kill switch', () => {
    expect(can(Capability.KILL_SWITCH_ENGAGE_GLOBAL, { role: UserRole.OWNER })).toBe(false);
    expect(can(Capability.KILL_SWITCH_RELEASE_GLOBAL, { role: UserRole.OWNER })).toBe(false);
    // But they retain authority over their own tenant.
    expect(can(Capability.KILL_SWITCH_ENGAGE_TENANT, { role: UserRole.OWNER })).toBe(true);
  });
});

describe('approval_scopes — the column defined in migration 0001 and never read', () => {
  const approver = { role: UserRole.APPROVER } as const;

  it('treats an empty scope list as unrestricted, matching the column default', () => {
    expect(authorize(Capability.PLAN_APPROVE, { ...approver, approvalScopes: [] })).toEqual({
      allowed: true,
    });
  });

  it('permits an action class within scope', () => {
    expect(
      authorize(Capability.PLAN_APPROVE, {
        ...approver,
        approvalScopes: ['data-deletion', 'policy'],
        actionClass: 'data-deletion',
      }),
    ).toEqual({ allowed: true });
  });

  it('refuses an action class outside scope', () => {
    const result = authorize(Capability.PLAN_APPROVE, {
      ...approver,
      approvalScopes: ['data-deletion'],
      actionClass: 'cross-border-transfer',
    });
    expect(result.allowed).toBe(false);
    expect(result).toMatchObject({ reason: 'scope_forbidden' });
  });

  it('refuses when a scoped approver names no action class', () => {
    const result = authorize(Capability.PLAN_APPROVE, {
      ...approver,
      approvalScopes: ['data-deletion'],
    });
    expect(result.allowed).toBe(false);
    expect(result).toMatchObject({ reason: 'scope_forbidden' });
  });

  // A scope cannot grant what the role does not have.
  it('does not let scopes widen a role', () => {
    expect(
      can(Capability.PLAN_APPROVE, {
        role: UserRole.VIEWER,
        approvalScopes: ['data-deletion'],
        actionClass: 'data-deletion',
      }),
    ).toBe(false);
  });

  it('distinguishes a role refusal from a scope refusal', () => {
    const roleRefusal = authorize(Capability.PLAN_APPROVE, { role: UserRole.VIEWER });
    expect(roleRefusal).toMatchObject({ reason: 'role_forbidden' });
  });
});

describe('tenant isolation and surfaces', () => {
  it('grants cross-tenant read only to founder and partner', () => {
    expect(rolesWith(Capability.MULTI_TENANT_READ).sort()).toEqual(['founder', 'partner'].sort());
  });

  it('grants workbench access only to the founder', () => {
    expect(rolesWith(Capability.WORKBENCH_ACCESS)).toEqual(['founder']);
  });

  it('grants the partner portal only to a partner', () => {
    expect(rolesWith(Capability.PARTNER_PORTAL_ACCESS)).toEqual(['partner']);
  });
});

describe('matrix integrity', () => {
  it('defines a capability list for every role', () => {
    for (const role of ALL_ROLES) {
      expect(Array.isArray(capabilitiesFor(role)), `${role} missing from the matrix`).toBe(true);
    }
  });

  it('grants a machine identity nothing by seat', () => {
    // An agent's authority comes from its approval token and workload
    // identity, never from a role.
    expect(capabilitiesFor(UserRole.AGENT)).toEqual([]);
  });

  it('never lets a viewer mutate anything', () => {
    const mutating = [
      Capability.PLAN_CREATE,
      Capability.PLAN_APPROVE,
      Capability.PLAN_REJECT,
      Capability.PLAN_EXECUTE,
      Capability.TENANT_SETTINGS_WRITE,
      Capability.USER_MANAGE,
      Capability.BILLING_MANAGE,
      Capability.KILL_SWITCH_ENGAGE_TENANT,
    ];
    for (const capability of mutating) {
      expect(can(capability, { role: UserRole.VIEWER }), `viewer can ${capability}`).toBe(false);
    }
  });

  it('refuses an unknown role rather than defaulting to permissive', () => {
    const result = authorize(Capability.POSTURE_READ, { role: 'nonsense' as UserRole });
    expect(result.allowed).toBe(false);
  });

  it('lists no duplicate capabilities within a role', () => {
    for (const role of ALL_ROLES) {
      const caps = capabilitiesFor(role);
      expect(new Set(caps).size, `${role} lists a duplicate`).toBe(caps.length);
    }
  });
});
