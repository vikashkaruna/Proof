import { AxiomMark } from '@axiom/ui';

export const Canonical = () => <AxiomMark size="lg" />;

export const SizeSweep = () => (
  <div style={{ display: 'flex', gap: 20, alignItems: 'center' }}>
    {(['xs', 'sm', 'md', 'lg', 'xl'] as const).map((s) => (
      <AxiomMark key={s} size={s} />
    ))}
  </div>
);

export const Variants = () => (
  <div style={{ display: 'flex', gap: 16 }}>
    <div
      style={{
        padding: 20,
        borderRadius: 12,
        border: '1px solid #E2E8F0',
        display: 'flex',
        gap: 20,
      }}
    >
      <AxiomMark size="lg" variant="gradient" />
      <AxiomMark size="lg" variant="monochrome-dark" />
    </div>
    <div style={{ background: '#1E2A4A', padding: 20, borderRadius: 12 }}>
      <AxiomMark size="lg" variant="monochrome-light" />
    </div>
  </div>
);
