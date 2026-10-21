import { describe, it, expect } from 'vitest';
import { Capability, UserRole, capabilitiesFor } from '@axiom/types';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { APP_NAV_GROUPS, routeCapability, visibleNavGroups, visibleRoutes } from './nav';
import { canAccessClosureDossiers } from '@/lib/closure-dossier-access';

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

const routesFor = (role: UserRole) =>
  visibleRoutes(capabilitiesFor(role), canAccessClosureDossiers(role, role === UserRole.FOUNDER));

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

/**
 * The menu each persona is offered, written out by hand on purpose.
 *
 * Every other assertion in this file derives from the matrix; this one is the
 * product decision itself, so that a change to who sees what shows up in
 * review as a change to this table rather than as a side effect.
 */
const MENUS: Record<string, string[]> = {
  [UserRole.AXIOM_ANALYST]: [
    '/dashboard',
    '/estate',
    '/discovery',
    '/classification',
    '/datamap',
    '/datamap/flows',
    '/assessment',
    '/engagements',
    '/controls',
    '/catalogue',
    '/plans',
    '/evidence',
    '/ledger',
    '/dsars',
    '/consent',
    '/breaches',
    '/monitoring',
    '/regwatch',
    '/reports',
    '/portal',
    '/policies',
    '/settings',
  ],
  [UserRole.OWNER]: [
    '/dashboard',
    '/estate',
    '/discovery',
    '/classification',
    '/datamap',
    '/datamap/flows',
    '/assessment',
    '/engagements',
    '/controls',
    '/catalogue',
    '/plans',
    '/approval',
    '/execution',
    '/evidence',
    '/ledger',
    '/dsars',
    '/consent',
    '/breaches',
    '/monitoring',
    '/regwatch',
    '/reports',
    '/reports?tab=pramaan',
    '/portal',
    '/connectors',
    '/policies',
    '/settings',
  ],
  [UserRole.VIEWER]: [
    '/dashboard',
    '/datamap/flows',
    '/catalogue',
    '/plans',
    '/evidence',
    '/ledger',
    '/reports',
    '/portal',
    '/settings',
  ],
  [UserRole.PARTNER]: [
    '/dashboard',
    '/datamap/flows',
    '/catalogue',
    '/plans',
    '/evidence',
    '/reports',
    '/portal',
    '/partner',
    '/settings',
  ],
  [UserRole.APPROVER]: [
    '/dashboard',
    '/datamap/flows',
    '/catalogue',
    '/plans',
    '/approval',
    '/evidence',
    '/ledger',
    '/breaches',
    '/reports',
    '/portal',
    '/settings',
  ],
  [UserRole.REVIEWER]: [
    '/dashboard',
    '/estate',
    '/discovery',
    '/classification',
    '/datamap',
    '/datamap/flows',
    '/assessment',
    '/engagements',
    '/controls',
    '/catalogue',
    '/plans',
    '/evidence',
    '/ledger',
    '/regwatch',
    '/reports',
    '/portal',
    '/settings',
  ],
};

describe('persona menus', () => {
  it.each(Object.entries(MENUS))('offers %s exactly its own menu', (role, expected) => {
    expect(routesFor(role as UserRole)).toEqual(expected);
  });

  it('gives each client persona a different menu', () => {
    const menus = [
      UserRole.OWNER,
      UserRole.APPROVER,
      UserRole.REVIEWER,
      UserRole.VIEWER,
      UserRole.PARTNER,
    ].map((role) => routesFor(role).join(','));
    expect(new Set(menus).size).toBe(menus.length);
  });
});

describe('the viewer persona', () => {
  const routes = routesFor(UserRole.VIEWER);

  it('is not offered the approval queue, execution, connectors, workbench or the partner portal', () => {
    for (const route of ['/approval', '/execution', '/connectors', '/workbench', '/partner']) {
      expect(routes, `viewer should not see ${route}`).not.toContain(route);
    }
  });

  it('is not offered operational workflows it cannot run', () => {
    for (const route of ['/dsars', '/consent', '/breaches', '/monitoring', '/policies', '/estate'])
      expect(routes, `viewer should not see ${route}`).not.toContain(route);
  });

  it('can still read evidence, the ledger, reports and their own settings', () => {
    for (const route of ['/plans', '/evidence', '/ledger', '/reports', '/settings']) {
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

  it('reads and comments on plans but is not offered the approval queue', () => {
    // BR-1's maker-checker property: a reviewer comments, an approver decides.
    expect(routes).toContain('/plans');
    expect(routes).not.toContain('/approval');
  });
});

describe('the approver persona', () => {
  const routes = routesFor(UserRole.APPROVER);

  it('is offered the approval queue', () => {
    expect(routes).toContain('/approval');
  });

  it('is not offered execution — approving and executing are separate acts', () => {
    expect(routes).not.toContain('/execution');
  });

  it('is not offered tenant configuration', () => {
    expect(routes).not.toContain('/connectors');
    expect(routes).not.toContain('/integrations');
    expect(routes).not.toContain('/policies');
  });
});

describe('the partner persona', () => {
  const routes = routesFor(UserRole.PARTNER);

  it('is offered the partner portal and no routes that change a client estate', () => {
    expect(routes).toContain('/partner');
    expect(routes).not.toContain('/approval');
    expect(routes).not.toContain('/execution');
    expect(routes).not.toContain('/connectors');
  });
});

describe('internal surfaces', () => {
  it('offers the workbench to the founder only', () => {
    const clientRoles = [
      UserRole.AXIOM_ANALYST,
      UserRole.OWNER,
      UserRole.ADMIN,
      UserRole.APPROVER,
      UserRole.REVIEWER,
      UserRole.VIEWER,
      UserRole.PARTNER,
    ];
    expect(routesFor(UserRole.FOUNDER)).toContain('/workbench');
    for (const role of clientRoles) {
      expect(routesFor(role), `${role} should not see /workbench`).not.toContain('/workbench');
    }
  });

  it('offers an analyst plans but no approval queue and no execution', () => {
    // Render gating agreeing with the matrix: Axiom prepares, the client
    // authorises. An analyst offered the approval queue would be the first
    // sign that boundary had slipped.
    const routes = routesFor(UserRole.AXIOM_ANALYST);
    expect(routes).not.toContain('/approval');
    expect(routes).not.toContain('/execution');
    expect(routes).toContain('/plans');
  });

  it('gives the agent identity no navigation at all', () => {
    // An agent's authority comes from its approval token, never from a seat.
    expect(routesFor(UserRole.AGENT)).toEqual([]);
  });

  it('offers the Pramaan route only where the dossier tab can render', () => {
    for (const role of [
      UserRole.FOUNDER,
      UserRole.AXIOM_ANALYST,
      UserRole.OWNER,
      UserRole.ADMIN,
      UserRole.APPROVER,
      UserRole.REVIEWER,
      UserRole.VIEWER,
      UserRole.PARTNER,
    ]) {
      expect(routesFor(role).includes('/reports?tab=pramaan')).toBe(
        canAccessClosureDossiers(role, role === UserRole.FOUNDER),
      );
    }
    expect(visibleRoutes(capabilitiesFor(UserRole.FOUNDER), false)).not.toContain(
      '/reports?tab=pramaan',
    );
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

  it('offers engagement records to the roles that run or review assessments', () => {
    for (const role of personas) {
      expect(routesFor(role).includes('/engagements'), role).toBe(
        capabilitiesFor(role).includes(Capability.ASSESSMENT_RUN),
      );
    }
    expect(routesFor(UserRole.AGENT)).not.toContain('/engagements');
    expect(visibleRoutes([])).not.toContain('/engagements');
  });

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

describe('Audit Ledger and Client Portal are separate menu items', () => {
  // Regression: the design-sync rebuild dropped the Client Portal item, and the
  // ledger page redirected client roles to /portal, so "Audit Ledger" opened
  // the Client Portal.
  const tenantRoles = [
    UserRole.OWNER,
    UserRole.ADMIN,
    UserRole.APPROVER,
    UserRole.REVIEWER,
    UserRole.VIEWER,
  ];

  it.each(tenantRoles)('offers %s both /ledger and /portal', (role: UserRole) => {
    const routes = routesFor(role);
    expect(routes).toContain('/ledger');
    expect(routes).toContain('/portal');
  });

  it('labels each route with its own screen', () => {
    const items = APP_NAV_GROUPS.flatMap((g) => g.items);
    expect(items.find((i) => i.route === '/ledger')?.en).toBe('Audit Ledger');
    expect(items.find((i) => i.route === '/portal')?.en).toBe('Client Portal');
  });
});

describe('page guards match the menu', () => {
  // A hidden menu item with an open page is a door left unlocked; an offered
  // item whose page refuses is a door that slams. Each page states its guard
  // as `routeCapability('<its route>')`, so the two read the same table.
  const pageRoutes = APP_NAV_GROUPS.flatMap((g) => g.items)
    .map((i) => i.route)
    .filter((route) => !route.includes('?'));
  const exempt: Record<string, string> = {
    '/dashboard': 'requireTenantContext: every seated reader',
    '/portal': 'requireTenantContext: every seated reader',
    '/settings': 'requireTenantContext: enrolment must stay reachable',
    '/evidence': 'checks evidence.read in the page',
    '/ledger': 'checks ledger.read in the page',
    '/reports': 'checks report.read in the page',
    '/execution': 'requires plan.execute directly',
    '/workbench': 'requireInternalContext',
    '/partner': 'partner portal checks its own access',
    '/connectors':
      'read-only inventory for every reader (linked from Discovery); registering needs tenant settings',
  };

  it.each(pageRoutes.filter((r) => !(r in exempt)))('%s guards with routeCapability', (route) => {
    const file = resolve(__dirname, `.${route}/page.tsx`);
    expect(existsSync(file), file).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain(`routeCapability('${route}')`);
  });

  it('resolves every declared route and refuses an undeclared one', () => {
    for (const route of pageRoutes) expect(routeCapability(route)).toBeTruthy();
    expect(() => routeCapability('/nowhere')).toThrow();
  });
});

describe('declared data flow history navigation', () => {
  it('offers the independently guarded read page without exposing legacy map access', () => {
    for (const role of [UserRole.VIEWER, UserRole.REVIEWER])
      expect(routesFor(role)).toContain('/datamap/flows');
    expect(routesFor(UserRole.VIEWER)).not.toContain('/datamap');
    expect(routesFor(UserRole.VIEWER)).not.toContain('/estate');
    expect(routesFor(UserRole.AGENT)).not.toContain('/datamap/flows');
    expect(visibleRoutes([])).not.toContain('/datamap/flows');
    expect(routeCapability('/datamap/flows')).toBe(Capability.POSTURE_READ);
    expect(
      APP_NAV_GROUPS.find((group) => group.label === 'Discover & Classify')?.items.find(
        (item) => item.route === '/datamap/flows',
      )?.en,
    ).toBe('Declared data flows');
  });
});

describe('live-founder report workspace navigation', () => {
  it('does not infer live designation from a founder label or any other role', () => {
    for (const role of Object.values(UserRole)) {
      expect(visibleRoutes(capabilitiesFor(role), true)).not.toContain('/reports/founder-review');
    }
    expect(visibleRoutes(capabilitiesFor(UserRole.OWNER), true, true)).not.toContain(
      '/reports/founder-review',
    );
    expect(visibleRoutes([], true, true)).not.toContain('/reports/founder-review');
  });
  it('offers the workspace only with founder capabilities plus the separately server-verified live designation', () => {
    expect(visibleRoutes(capabilitiesFor(UserRole.FOUNDER), true, true)).toContain(
      '/reports/founder-review',
    );
    expect(routeCapability('/reports/founder-review')).toBe(Capability.WORKBENCH_ACCESS);
  });
});
