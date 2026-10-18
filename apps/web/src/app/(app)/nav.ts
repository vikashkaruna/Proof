import { Capability } from '@axiom/types';

/**
 * Navigation, gated by capability (W1 · SEC-9).
 *
 * Extracted from `app-shell.tsx` so the filter is a pure function that a test
 * can drive through every persona. Inside a 600-line client component it would
 * only be testable by rendering the shell, which is how gating rules end up
 * asserted by screenshot.
 *
 * Render gating is a **usability** concern and never the security boundary —
 * the BFF refuses regardless, and `requireCapabilityContext()` refuses at the
 * page. Its job is narrower and still worth doing: a user should not be shown
 * a door that will slam in their face, and an approval console that renders
 * for a viewer teaches them that the product is broken rather than that they
 * lack the authority.
 *
 * Every item carries a capability. There is no "visible to everyone" escape
 * hatch, because the first item that takes it becomes the precedent for the
 * next one, and the one after that is `/settings`.
 */

export interface NavItem {
  route: string;
  en: string;
  hi: string;
  phase: string;
  agentRole?: string;
  star?: boolean;
  gold?: boolean;
  /** The capability a persona must hold for this item to appear. */
  capability: Capability;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

/*
 * Who sees what (W1 persona menus).
 *
 * Every role used to hold `posture.read`, and 17 of the 27 items were gated on
 * it, so a viewer, a reviewer, an approver and an owner were all offered the
 * same menu. Each item is now gated on the capability that matches the work the
 * screen is for, taken from the role definitions in `packages/types/src/rbac.ts`:
 *
 *   - discovery, classification and assessment screens — `assessment.run`:
 *     the people who run or review agent output (founder, analyst, owner,
 *     admin, reviewer);
 *   - plans — `plan.comment`: everyone who takes part in the approval chain;
 *     the approval queue — `plan.approve`; execution — `plan.execute`;
 *   - rights, consent, monitoring and policies — `agent.invoke`: the operators
 *     who run those workflows (founder, analyst, owner, admin);
 *   - breach and incident — `incident.read`: the operators and the approver,
 *     who follows an incident without holding the emergency stop;
 *   - evidence, ledger, reports, the client portal and settings stay open to
 *     every reader, which is what a viewer is for.
 *
 * The page guard for each route requires the same capability (see
 * `nav.test.ts`, "page guards match the menu"), so a hidden item is also a
 * refused URL rather than a door left unlocked. The exceptions are listed in
 * that test with their reason — Connectors, for instance, keeps a read-only
 * inventory for every reader because Discovery links to it.
 */
export const APP_NAV_GROUPS: NavGroup[] = [
  {
    label: 'Overview',
    items: [
      {
        route: '/dashboard',
        en: 'Dashboard',
        hi: 'डैशबोर्ड',
        phase: 'P0',
        capability: Capability.POSTURE_READ,
      },
    ],
  },
  {
    label: 'Discover & Classify',
    items: [
      {
        route: '/estate',
        en: 'Client Estate',
        hi: 'क्लाइंट एस्टेट',
        phase: 'P1',
        capability: Capability.ASSESSMENT_RUN,
      },
      {
        route: '/discovery',
        en: 'Data Discovery',
        hi: 'डेटा खोज',
        phase: 'P1',
        capability: Capability.ASSESSMENT_RUN,
      },
      {
        route: '/classification',
        en: 'Classification',
        hi: 'वर्गीकरण',
        phase: 'P1',
        capability: Capability.ASSESSMENT_RUN,
      },
      {
        route: '/datamap',
        en: 'Data Map & RoPA',
        hi: 'डेटा मानचित्र',
        phase: 'P1',
        capability: Capability.ASSESSMENT_RUN,
      },
    ],
  },
  {
    label: 'Assess',
    items: [
      {
        route: '/assessment',
        en: 'Assessment',
        hi: 'मूल्यांकन',
        phase: 'P0',
        capability: Capability.ASSESSMENT_RUN,
      },
      {
        route: '/engagements',
        en: 'Engagements',
        hi: 'आकलन संलग्नताएँ',
        phase: 'P0',
        capability: Capability.ASSESSMENT_RUN,
      },
      {
        route: '/controls',
        en: 'Control Library',
        hi: 'नियंत्रण संग्रह',
        phase: 'P0',
        capability: Capability.ASSESSMENT_RUN,
      },
    ],
  },
  {
    label: 'Remediate',
    items: [
      {
        route: '/plans',
        en: 'Remediation Plans',
        hi: 'सुधार योजना',
        phase: 'P3',
        // Read-only members also need a route to recorded actions, dry runs
        // and rollback details. Mutation controls keep their own capabilities.
        capability: Capability.PLAN_READ,
      },
      {
        route: '/approval',
        en: 'Approval Queue',
        hi: 'अनुमोदन कतार',
        phase: 'P3',
        star: true,
        // Offered only to those who can decide. Someone who can only read a
        // plan follows it from Remediation Plans.
        capability: Capability.PLAN_APPROVE,
      },
      {
        route: '/execution',
        en: 'Execution & Rollback',
        hi: 'निष्पादन',
        phase: 'P3',
        capability: Capability.PLAN_EXECUTE,
      },
    ],
  },
  {
    label: 'Evidence & Audit',
    items: [
      {
        route: '/evidence',
        en: 'Evidence Explorer',
        hi: 'साक्ष्य',
        phase: 'P2',
        capability: Capability.EVIDENCE_READ,
      },
      {
        route: '/ledger',
        en: 'Audit Ledger',
        hi: 'अंकेक्षण बही',
        phase: 'P2',
        capability: Capability.LEDGER_READ,
      },
    ],
  },
  {
    label: 'Rights & Consent',
    items: [
      {
        route: '/dsars',
        en: 'DSAR / Rights',
        hi: 'अधिकार अनुरोध',
        phase: 'P3',
        capability: Capability.AGENT_INVOKE,
      },
      {
        route: '/consent',
        en: 'Consent Manager',
        hi: 'सहमति प्रबंधन',
        phase: 'P3',
        capability: Capability.AGENT_INVOKE,
      },
    ],
  },
  {
    label: 'Incident',
    items: [
      {
        route: '/breaches',
        en: 'Breach & Incident',
        hi: 'उल्लंघन',
        phase: 'P3',
        // The approver follows incidents but no longer holds the kill switch.
        capability: Capability.INCIDENT_READ,
      },
    ],
  },
  {
    label: 'Monitor',
    items: [
      {
        route: '/monitoring',
        en: 'Continuous Monitoring',
        hi: 'सतत निगरानी',
        phase: 'P3',
        capability: Capability.AGENT_INVOKE,
      },
      {
        route: '/regwatch',
        en: 'Regulatory Watch',
        hi: 'नियामक निगरानी',
        phase: 'P2',
        capability: Capability.ASSESSMENT_RUN,
      },
    ],
  },
  {
    label: 'Reporting & Proof',
    items: [
      {
        route: '/reports',
        en: 'Working Reports & Registers',
        agentRole: 'Prativedan · Clerical Drafter',
        hi: 'कार्यकारी रिपोर्ट',
        phase: 'P2',
        capability: Capability.REPORT_READ,
      },
      {
        route: '/reports?tab=pramaan',
        en: 'Statutory Proof Dossiers',
        agentRole: 'Pramaan · Closure Seal',
        hi: 'वैधानिक प्रमाण',
        phase: 'Final Proof',
        star: true,
        gold: true,
        capability: Capability.REPORT_READ,
      },
    ],
  },
  {
    label: 'Operate',
    items: [
      {
        route: '/workbench',
        en: 'Agent Workbench',
        hi: 'एजेंट कार्यक्षेत्र',
        phase: 'P0',
        // Axiom-internal surface. It renders across tenants, so it is not
        // something a client-side role reaches at all.
        capability: Capability.WORKBENCH_ACCESS,
      },
      {
        route: '/portal',
        en: 'Client Portal',
        hi: 'क्लाइंट पोर्टल',
        phase: 'P0',
        // The tenant's own read-only summary, for every seated reader.
        capability: Capability.POSTURE_READ,
      },
      {
        route: '/partner',
        en: 'Partner Portal',
        hi: 'भागीदार पोर्टल',
        phase: 'P4',
        capability: Capability.PARTNER_PORTAL_ACCESS,
      },
      {
        route: '/connectors',
        en: 'Connectors',
        hi: 'कनेक्टर',
        phase: 'P2',
        // Binding a connector is a change to how the platform reaches a
        // client estate, which is tenant configuration rather than reading.
        capability: Capability.TENANT_SETTINGS_WRITE,
      },
      {
        route: '/policies',
        en: 'Policies & Notices',
        hi: 'स्थायी नीतियाँ',
        phase: 'P4',
        capability: Capability.AGENT_INVOKE,
      },
      {
        route: '/settings',
        en: 'Settings',
        hi: 'सेटिंग्स',
        phase: 'P0',
        // Everyone with a seat: `/settings/security` is where a quarantined
        // user enrols their factor, so it cannot be gated behind anything
        // they might not hold.
        capability: Capability.POSTURE_READ,
      },
    ],
  },
];

/**
 * The navigation a persona actually sees.
 *
 * Groups that empty out are dropped rather than rendered as a bare heading —
 * a section label with nothing under it advertises the existence of something
 * withheld, which is worse than useful.
 */
export function visibleNavGroups(
  capabilities: readonly string[],
  groups: NavGroup[] = APP_NAV_GROUPS,
  canViewClosureDossiers = false,
): NavGroup[] {
  const held = new Set(capabilities);
  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter(
        (i) =>
          held.has(i.capability) && (i.route !== '/reports?tab=pramaan' || canViewClosureDossiers),
      ),
    }))
    .filter((group) => group.items.length > 0);
}

/** Every route reachable by a persona, for tests and for breadcrumbs. */
export function visibleRoutes(
  capabilities: readonly string[],
  canViewClosureDossiers = false,
): string[] {
  return visibleNavGroups(capabilities, APP_NAV_GROUPS, canViewClosureDossiers).flatMap((g) =>
    g.items.map((i) => i.route),
  );
}

/**
 * The capability a route's page guard requires — the same one that decides
 * whether the menu offers it. Pages call `requireCapabilityContext(
 * routeCapability('/estate'))` so the menu and the guard cannot drift apart:
 * a screen hidden from a persona is also refused when they type its URL.
 */
export function routeCapability(route: string): Capability {
  const item = APP_NAV_GROUPS.flatMap((g) => g.items).find((i) => i.route === route);
  if (!item) throw new Error(`No navigation item declares ${route}`);
  return item.capability;
}
