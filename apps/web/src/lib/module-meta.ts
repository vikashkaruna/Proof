import type { AgentName } from '@axiom/design-tokens';
import type { ModulePhase } from '@axiom/ui';

/**
 * Module metadata behind the shared page-header context (Hindi name, phase, module id,
 * related agents). Titles, Hindi names, phases and sections come from the design project
 * "Axiom Proof Design System" (Axiom Proof App.dc.html: navDef and genericMeta). Module ids
 * for approval (M3.3) and assessment (M0.3) come from docs/02_Phase_Wise_Implementation_Plan.md;
 * the design has none for them and the dashboard has no module id. A module with no named
 * agent lists none.
 */
export type ModuleKey =
  | 'dashboard'
  | 'discovery'
  | 'classification'
  | 'datamap'
  | 'assessment'
  | 'controls'
  | 'remediation'
  | 'approval'
  | 'execution'
  | 'evidence'
  | 'ledger'
  | 'dsar'
  | 'consent'
  | 'breach'
  | 'monitoring'
  | 'regwatch'
  | 'reports'
  | 'workbench'
  | 'partner'
  | 'connectors'
  | 'policies';

export interface ModuleMeta {
  title: string;
  hi: string;
  phase: ModulePhase;
  section: string;
  moduleId?: string;
  agents: readonly AgentName[];
}

export const MODULES: Record<ModuleKey, ModuleMeta> = {
  dashboard: {
    title: 'Dashboard',
    hi: 'डैशबोर्ड',
    phase: 'P0',
    section: 'Overview',
    agents: [],
  },
  discovery: {
    title: 'Data Discovery',
    hi: 'डेटा खोज',
    phase: 'P1',
    section: 'Discover & Classify',
    moduleId: 'M2.2',
    agents: ['drishti'],
  },
  classification: {
    title: 'Classification',
    hi: 'वर्गीकरण',
    phase: 'P1',
    section: 'Discover & Classify',
    moduleId: 'M2.3',
    agents: ['vibhaag'],
  },
  datamap: {
    title: 'Data Map & RoPA',
    hi: 'डेटा मानचित्र',
    phase: 'P1',
    section: 'Discover & Classify',
    moduleId: 'M1.3',
    agents: ['vibhaag'],
  },
  assessment: {
    title: 'Assessment',
    hi: 'मूल्यांकन',
    phase: 'P0',
    section: 'Assess',
    moduleId: 'M0.3',
    agents: ['parikshan'],
  },
  controls: {
    title: 'Control Library',
    hi: 'नियंत्रण संग्रह',
    phase: 'P0',
    section: 'Assess',
    moduleId: 'M0.2',
    agents: ['parikshan'],
  },
  remediation: {
    title: 'Remediation Plans',
    hi: 'सुधार योजना',
    phase: 'P3',
    section: 'Remediate',
    moduleId: 'M3.1',
    agents: ['sudhaar'],
  },
  approval: {
    title: 'Approval Console',
    hi: 'अनुमोदन कंसोल',
    phase: 'P3',
    section: 'Remediate',
    moduleId: 'M3.3',
    agents: ['sudhaar', 'karya'],
  },
  execution: {
    title: 'Execution & Rollback',
    hi: 'निष्पादन',
    phase: 'P3',
    section: 'Remediate',
    moduleId: 'M3.4',
    agents: ['karya'],
  },
  evidence: {
    title: 'Evidence Explorer',
    hi: 'साक्ष्य',
    phase: 'P2',
    section: 'Evidence & Audit',
    moduleId: 'M2.4',
    agents: ['saakshi'],
  },
  ledger: {
    title: 'Audit Ledger',
    hi: 'अंकेक्षण बही',
    phase: 'P2',
    section: 'Evidence & Audit',
    moduleId: 'M2.5',
    agents: ['lekha'],
  },
  dsar: {
    title: 'DSAR / Rights',
    hi: 'अधिकार अनुरोध',
    phase: 'P3',
    section: 'Rights & Consent',
    moduleId: 'M2.8',
    agents: [],
  },
  consent: {
    title: 'Consent Manager',
    hi: 'सहमति प्रबंधन',
    phase: 'P3',
    section: 'Rights & Consent',
    moduleId: 'M3.8',
    agents: [],
  },
  breach: {
    title: 'Breach & Incident',
    hi: 'उल्लंघन',
    phase: 'P3',
    section: 'Incident',
    moduleId: 'M3.9',
    agents: [],
  },
  monitoring: {
    title: 'Continuous Monitoring',
    hi: 'सतत निगरानी',
    phase: 'P3',
    section: 'Monitor',
    moduleId: 'M3.10',
    agents: ['drishti', 'parikshan'],
  },
  regwatch: {
    title: 'Regulatory Watch',
    hi: 'नियामक निगरानी',
    phase: 'P2',
    section: 'Monitor',
    moduleId: 'M2.9',
    agents: ['nazar'],
  },
  reports: {
    title: 'Reports',
    hi: 'रिपोर्ट',
    phase: 'P2',
    section: 'Report',
    moduleId: 'M2.7',
    agents: ['prativedan'],
  },
  workbench: {
    title: 'Agent Workbench',
    hi: 'एजेंट कार्यक्षेत्र',
    phase: 'P0',
    section: 'Operate',
    moduleId: 'M0.6',
    agents: [
      'drishti',
      'vibhaag',
      'parikshan',
      'saakshi',
      'sudhaar',
      'karya',
      'lekha',
      'nazar',
      'prativedan',
      'sanket',
    ],
  },
  partner: {
    title: 'Partner Portal',
    hi: 'भागीदार पोर्टल',
    phase: 'P4',
    section: 'Operate',
    moduleId: 'M4.7',
    agents: [],
  },
  connectors: {
    title: 'Connectors',
    hi: 'कनेक्टर',
    phase: 'P2',
    section: 'Operate',
    moduleId: 'M2.1',
    agents: [],
  },
  policies: {
    title: 'Standing Policies',
    hi: 'स्थायी नीतियाँ',
    phase: 'P4',
    section: 'Operate',
    moduleId: 'M4.1',
    agents: [],
  },
};

export function moduleMeta(key: ModuleKey): ModuleMeta {
  return MODULES[key];
}
