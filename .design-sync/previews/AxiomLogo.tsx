import { AxiomLogo } from '@axiom/ui';

const dark = { background: '#1E2A4A', padding: 20, borderRadius: 12 } as const;

export const Canonical = () => <AxiomLogo size="lg" />;

export const SizeSweep = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'flex-start' }}>
    {(['xs', 'sm', 'md', 'lg', 'xl'] as const).map((s) => (
      <AxiomLogo key={s} size={s} />
    ))}
  </div>
);

export const WithSubtitle = () => (
  <AxiomLogo size="lg" showSubtitle subtitleText="Agentic DPDPA compliance" />
);

export const MonochromeVariants = () => (
  <div style={{ display: 'flex', gap: 16 }}>
    <div style={{ padding: 20, borderRadius: 12, border: '1px solid #E2E8F0' }}>
      <AxiomLogo size="md" variant="monochrome-dark" />
    </div>
    <div style={dark}>
      <AxiomLogo size="md" variant="monochrome-light" theme="dark" />
    </div>
  </div>
);
