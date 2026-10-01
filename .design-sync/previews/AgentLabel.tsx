import { AgentLabel } from '@axiom/ui';

export const Canonical = () => (
  <div style={{ width: 360 }}>
    <AgentLabel agent="drishti" showPersona />
  </div>
);

export const SizesAndPersona = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: 360 }}>
    <AgentLabel agent="sudhaar" size="sm" showPersona />
    <AgentLabel agent="sudhaar" size="xs" showPersona />
    <AgentLabel agent="lekha" size="sm" />
    <AgentLabel agent="pramaan" size="xs" />
  </div>
);

export const OnDarkBanner = () => (
  <div
    style={{
      background: '#1E2A4A',
      padding: 20,
      borderRadius: 12,
      width: 360,
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
    }}
  >
    <AgentLabel agent="saakshi" tone="dark" showPersona />
    <AgentLabel agent="karya" tone="dark" size="xs" />
  </div>
);

export const StatesCaptioned = () => (
  <div style={{ width: 360, display: 'flex', flexDirection: 'column', gap: 10 }}>
    <div style={{ fontSize: 11, color: '#475569' }}>
      States (animated only for a real run): idle, thinking, working
    </div>
    {(['idle', 'thinking', 'working'] as const).map((s) => (
      <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ width: 64, fontSize: 11, color: '#475569' }}>{s}</span>
        <AgentLabel agent="karya" state={s} />
      </div>
    ))}
  </div>
);
