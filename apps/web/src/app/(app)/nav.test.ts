import { describe, it, expect } from 'vitest';
import { Capability, UserRole, capabilitiesFor } from '@axiom/types';
import { APP_NAV_GROUPS, visibleNavGroups, visibleRoutes } from './nav';

/**
 * W1 · SEC-9 — persona render gating.
 *
 * The plan's exit criterion for W1 is that "a viewer in tenant A cannot see
 * tenant B, cannot reach an approve button, and cannot call the approve
 * endpoint. Proven by test, not inspection."
 *
 * The third is the BFF's, and is covered in `middleware/authorize.test.ts`.
 * This file covers the second, at the level where it is decidable: which
 * navigation a persona is offered, driven by the same capability matrix the
 * BFF enforces with.
 *
 * Every assertion is derived from `capabilitiesFor(role)` rather than from a
 * hand-written expectation, so a change to the matrix shows up here as a
 * failure rather than as two lists quietly disagreeing.
 */

const routesFor = (role: UserRole) => visibleRoutes(capabilitiesFor(role));

describe('nav configuration', () => {
  it('gives every item a capability, with no visible-to-everyone escape hatch', () => {
    const items = APP_NAV_GROUPS.flatMap((g) => g.items);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.capability, `${item.route} has no capability`).toBeTruthy();
    }
  });

  it('declares no duplicate routes', () => {
    const routes = APP_NAV_GROUPS.flatMap((g) => g.items.map((i) => i.route));
    expect(new Set(routes).size).toBe(routes.length);
  });
});

describe('visibleNavGroups', () => {
  it('drops a group once all of its items are filtered out', () => {
    // A heading with nothing beneath it advertises something withheld.
    const groups = visibleNavGroups([]);
    expect(groups).toHaveLength(0);
  });

  it('keeps only the items whose capability is held', () => {
    const groups = visibleNavGroups([Capability.LEDGER_READ]);
    expect(groups.flatMap((g) => g.items.map((i) => i.route))).toEqual(['/ledger']);
  });
});

describe('the viewer persona', () => {
  const routes = routesFor(UserRole.VIEWER);

  it('is not offered the approval console', () => {
    expect(routes).not.toContain('/approval');
  });

  it('is not offered execution, connectors, policies, workbench or the partner portal', () => {
    for (const route of ['/execution', '/connectors', '/policies', '/workbench', '/partner']) {
      expect(routes, `viewer should not see ${route}`).not.toContain(route);
    }
  });

  it('can still read plans, evidence, the ledger and their own settings', () => {
    for (const route of ['/plans', '/evidence', '/ledger', '/settings']) {
      expect(routes, `viewer should see ${route}`).toContain(route);
    }
  });

  it('holds no capability that changes anything', () => {
    const held = new Set<string>(capabilitiesFor(UserRole.VIEWER));
    for (const capability of [
      Capability.PLAN_APPROVE,
      Capability.PLAN_REJECT,
      Capability.PLAN_EXECUTE,
      Capability.PLAN_CREATE,
      Capability.KILL_SWITCH_ENGAGE_TENANT,
      Capability.TENANT_SETTINGS_WRITE,
      Capability.USER_MANAGE,
    ]) {
      expect(held.has(capability), `viewer must not hold ${capability}`).toBe(false);
    }
  });
});

describe('the reviewer persona', () => {
  const routes = routesFor(UserRole.REVIEWER);

  it('reads plans but is not offered the approval console', () => {
    // BR-1's maker-checker property: a reviewer comments, an approver decides.
    expect(routes).toContain('/plans');
    expect(routes).not.toContain('/approval');
  });
});

describe('the approver persona', () => {
  const routes = routesFor(UserRole.APPROVER);

  it('is offered the approval console', () => {
    expect(routes).toContain('/approval');
  });

  it('is not offered execution — approving and executing are separate acts', () => {
    expect(routes).not.toContain('/execution');
  });

  it('is not offered tenant configuration', () => {
    expect(routes).not.toContain('/connectors');
    expect(routes).not.toContain('/policies');
  });
});

describe('the partner persona', () => {
  const routes = routesFor(UserRole.PARTNER);

  it('is offered the partner portal and nothing that changes a client estate', () => {
    expect(routes).toContain('/partner');
    expect(routes).not.toContain('/approval');
    expect(routes).not.toContain('/execution');
    expect(routes).not.toContain('/connectors');
  });
});

describe('internal surfaces', () => {
  it('offers the workbench to Axiom staff and to no client role', () => {
    const clientRoles = [
      UserRole.OWNER,
      UserRole.ADMIN,
      UserRole.APPROVER,
      UserRole.REVIEWER,
      UserRole.VIEWER,
      UserRole.PARTNER,
    ];
    for (const role of [UserRole.FOUNDER, UserRole.AXIOM_ANALYST]) {
      expect(routesFor(role), `${role} should see /workbench`).toContain('/workbench');
    }
    for (const role of clientRoles) {
      expect(routesFor(role), `${role} should not see /workbench`).not.toContain('/workbench');
    }
  });

  it('offers an analyst no approval console and no execution', () => {
    // Render gating agreeing with the matrix: Axiom prepares, the client
    // authorises. An analyst seeing an Approve button would be the first sign
    // that boundary had slipped.
    const routes = routesFor(UserRole.AXIOM_ANALYST);
    expect(routes).not.toContain('/approval');
    expect(routes).not.toContain('/execution');
    expect(routes).toContain('/plans');
  });

  it('gives the agent identity no navigation at all', () => {
    // An agent's authority comes from its approval token, never from a seat.
    expect(routesFor(UserRole.AGENT)).toEqual([]);
  });
});

describe('every persona', () => {
  const personas = [
    UserRole.FOUNDER,
    UserRole.AXIOM_ANALYST,
    UserRole.OWNER,
    UserRole.ADMIN,
    UserRole.APPROVER,
    UserRole.REVIEWER,
    UserRole.VIEWER,
    UserRole.PARTNER,
  ];

  it('is offered settings, so a quarantined user can always reach enrolment', () => {
    for (const role of personas) {
      expect(routesFor(role), `${role} must reach /settings`).toContain('/settings');
    }
  });

  it('is offered only routes backed by a capability it holds', () => {
    for (const role of personas) {
      const held = new Set<string>(capabilitiesFor(role));
      for (const group of visibleNavGroups(capabilitiesFor(role))) {
        for (const item of group.items) {
          expect(held.has(item.capability), `${role} → ${item.route}`).toBe(true);
        }
      }
    }
  });
});
