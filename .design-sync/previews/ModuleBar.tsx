import { ModuleBar } from '@axiom/ui';

export const Canonical = () => (
  <div style={{ width: 640 }}>
    <ModuleBar
      crumb="Remediate"
      titleHi="अनुमोदन कंसोल"
      phase="P3"
      moduleId="M3.3"
      agents={['sudhaar', 'karya']}
    />
  </div>
);

export const PhaseSweep = () => (
  <div style={{ width: 640, display: 'flex', flexDirection: 'column', gap: 16 }}>
    <ModuleBar crumb="Discover" phase="P1" moduleId="M1.1" agents={['drishti']} />
    <ModuleBar
      crumb="Evidence"
      titleHi="साक्ष्य तिजोरी"
      phase="P4"
      moduleId="M4.2"
      agents={['saakshi', 'pramaan']}
    />
    <ModuleBar crumb="Settings" />
  </div>
);

export const OnDarkBanner = () => (
  <div style={{ background: '#1E2A4A', padding: 20, borderRadius: 12, width: 640 }}>
    <ModuleBar
      crumb="Report"
      titleHi="प्रतिवेदन"
      phase="P5"
      moduleId="M5.1"
      agents={['prativedan']}
      tone="dark"
    />
  </div>
);
