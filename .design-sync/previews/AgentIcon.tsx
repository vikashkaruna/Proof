import { AgentIcon } from '@axiom/ui';

const AGENTS = [
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
  'samadhan',
  'pramaan',
] as const;

const cell = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 6,
  width: 84,
} as const;
const caption = { fontSize: 11, color: '#475569', textTransform: 'capitalize' } as const;

export const AllAgentsStatic = () => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, maxWidth: 520 }}>
    {AGENTS.map((a) => (
      <div key={a} style={cell}>
        <AgentIcon agent={a} size="md" />
        <span style={caption}>{a}</span>
      </div>
    ))}
  </div>
);

export const ThreeStates = () => (
  <div style={{ display: 'flex', gap: 28 }}>
    {(['idle', 'thinking', 'working'] as const).map((s) => (
      <div key={s} style={cell}>
        <AgentIcon agent="karya" size="lg" state={s} />
        <span style={caption}>{s === 'idle' ? 'static (idle)' : s}</span>
      </div>
    ))}
  </div>
);

export const OnDarkBanner = () => (
  <div style={{ background: '#1E2A4A', padding: 20, borderRadius: 12, display: 'flex', gap: 20 }}>
    {(['lekha', 'saakshi', 'sudhaar'] as const).map((a) => (
      <AgentIcon key={a} agent={a} size="md" variant="on-dark" />
    ))}
  </div>
);

export const Sizes = () => (
  <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
    <AgentIcon agent="drishti" size="xs" />
    <AgentIcon agent="drishti" size="sm" />
    <AgentIcon agent="drishti" size="md" />
    <AgentIcon agent="drishti" size="lg" />
  </div>
);
