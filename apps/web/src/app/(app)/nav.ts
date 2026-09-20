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
  star?: boolean;
  /** The capability a persona must hold for this item to appear. */
  capability: Capability;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

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
    label: 'Discover & Classify · Drishti + Vibhaag',
    items: [
      {
        route: '/discovery',
        en: 'Data Discovery',
        hi: 'डेटा खोज',
        phase: 'P1',
        capability: Capability.POSTURE_READ,
      },
      {
        route: '/classification',
        en: 'Classification',
        hi: 'वर्गीकरण',
        phase: 'P1',
        capability: Capability.POSTURE_READ,
      },
      {
        route: '/datamap',
        en: 'Data Map & RoPA',
        hi: 'डेटा मानचित्र',
        phase: 'P1',
        capability: Capability.POSTURE_READ,
      },
    ],
  },
  {
    label: 'Assess · Parikshan',
    items: [
      {
        route: '/assessment',
        en: 'Assessment',
        hi: 'मूल्यांकन',
        phase: 'P0',
        capability: Capability.POSTURE_READ,
      },
      {
        route: '/controls',
        en: 'Control Library',
        hi: 'नियंत्रण संग्रह',
        phase: 'P0',
        capability: Capability.POSTURE_READ,
      },
    ],
  },
  {
    label: 'Remediate · Sudhaar + Karya',
    items: [
      {
        route: '/plans',
        en: 'Remediation Plans',
        hi: 'सुधार योजना',
        phase: 'P3',
        // A viewer may read a plan. What they may not do is approve it, which
        // is gated on the buttons inside and at the BFF.
        capability: Capability.PLAN_READ,
      },
      {
        route: '/approval',
        en: 'Approval Console',
        hi: 'अनुमोदन कंसोल',
        phase: 'P3',
        star: true,
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
    label: 'Evidence & Audit · Saakshi + Lekha',
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
        capability: Capability.POSTURE_READ,
      },
      {
        route: '/consent',
        en: 'Consent Manager',
        hi: 'सहमति प्रबंधन',
        phase: 'P3',
        capability: Capability.POSTURE_READ,
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
        capability: Capability.POSTURE_READ,
      },
    ],
  },
  {
    label: 'Monitor · Nazar',
    items: [
      {
        route: '/monitoring',
        en: 'Continuous Monitoring',
        hi: 'सतत निगरानी',
        phase: 'P3',
        capability: Capability.POSTURE_READ,
      },
      {
        route: '/regwatch',
        en: 'Regulatory Watch',
        hi: 'नियामक निगरानी',
        phase: 'P2',
        capability: Capability.POSTURE_READ,
      },
    ],
  },
  {
    label: 'Report · Prativedan',
    items: [
      {
        route: '/reports',
        en: 'Reports',
        hi: 'रिपोर्ट',
        phase: 'P2',
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
        en: 'Standing Policies',
        hi: 'स्थायी नीतियाँ',
        phase: 'P4',
        capability: Capability.TENANT_SETTINGS_WRITE,
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
): NavGroup[] {
  const held = new Set(capabilities);
  return groups
    .map((group) => ({ ...group, items: group.items.filter((i) => held.has(i.capability)) }))
    .filter((group) => group.items.length > 0);
}

/** Every route reachable by a persona, for tests and for breadcrumbs. */
export function visibleRoutes(capabilities: readonly string[]): string[] {
  return visibleNavGroups(capabilities).flatMap((g) => g.items.map((i) => i.route));
}
