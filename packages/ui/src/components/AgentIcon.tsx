'use client';

import React from 'react';
import { agentAccents, type AgentName } from '@axiom/design-tokens';
import { cn } from '../utils';

export type AgentIconState = 'idle' | 'thinking' | 'working';
export type AgentIconSize = 'xs' | 'sm' | 'md' | 'lg' | number;

export type AgentKey = AgentName | 'policy' | 'policy_engine' | 'incident' | 'dsar' | 'consent';

export interface AgentIconProps extends React.HTMLAttributes<HTMLSpanElement> {
  agent: AgentKey | string;
  state?: AgentIconState;
  size?: AgentIconSize;
  showBadge?: boolean;
  variant?: 'default' | 'on-dark';
  className?: string;
}

const SIZE_MAP: Record<'xs' | 'sm' | 'md' | 'lg', { box: number; icon: number }> = {
  xs: { box: 20, icon: 14 },
  sm: { box: 28, icon: 18 },
  md: { box: 40, icon: 26 },
  lg: { box: 56, icon: 36 },
};

const ON_DARK_ACCENTS: Record<string, string> = {
  parikshan: '#818CF8', // high-contrast light indigo on dark background
  lekha: '#94A3B8', // high-contrast slate on dark background
  drishti: '#0FB5A5',
  vibhaag: '#A78BFA',
  saakshi: '#FACC15',
  sudhaar: '#38BDF8',
  karya: '#F87171',
  nazar: '#4ADE80',
  prativedan: '#C084FC',
  sanket: '#FB923C',
  policy: '#0FB5A5',
  policy_engine: '#0FB5A5',
  incident: '#F87171',
  dsar: '#38BDF8',
  consent: '#0FB5A5',
};

const EXTRA_ACCENTS: Record<string, string> = {
  policy: '#0FB5A5',
  policy_engine: '#0FB5A5',
  incident: '#D9534F',
  dsar: '#0EA5E9',
  consent: '#0FB5A5',
};

export function AgentIcon({
  agent,
  state = 'idle',
  size = 'sm',
  showBadge = false,
  variant = 'default',
  className,
  ...props
}: AgentIconProps) {
  const accent =
    variant === 'on-dark'
      ? ON_DARK_ACCENTS[agent] || '#0FB5A5'
      : agentAccents[agent as AgentName] || EXTRA_ACCENTS[agent] || '#0FB5A5';

  const sizeConfig =
    typeof size === 'number'
      ? { box: size, icon: Math.round(size * 0.65) }
      : SIZE_MAP[size] || SIZE_MAP.sm;

  return (
    <span
      className={cn(
        'relative inline-flex items-center justify-center rounded-lg transition-all select-none',
        state === 'working' && 'shadow-sm',
        className,
      )}
      style={{
        width: `${sizeConfig.box}px`,
        height: `${sizeConfig.box}px`,
        backgroundColor: variant === 'on-dark' ? 'rgba(255,255,255,0.1)' : `${accent}15`,
        borderColor: variant === 'on-dark' ? 'rgba(255,255,255,0.2)' : `${accent}40`,
        borderWidth: '1px',
        borderStyle: 'solid',
      }}
      title={`${agent} (${state})`}
      {...props}
    >
      <svg
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        style={{
          width: `${sizeConfig.icon}px`,
          height: `${sizeConfig.icon}px`,
          color: accent,
        }}
        aria-hidden="true"
      >
        <AgentSvgContent agent={agent} state={state} accent={accent} />
      </svg>

      {/* Optional micro status badge */}
      {showBadge && (
        <span
          className={cn(
            'absolute -bottom-0.5 -right-0.5 rounded-full border border-white',
            state === 'working' && 'animate-ping',
          )}
          style={{
            width: `${Math.max(6, Math.round(sizeConfig.box * 0.22))}px`,
            height: `${Math.max(6, Math.round(sizeConfig.box * 0.22))}px`,
            backgroundColor:
              state === 'working' ? '#0FB5A5' : state === 'thinking' ? '#EAB308' : '#94A3B8',
          }}
        />
      )}

      {/* Embedded CSS animations for fluid, standalone rendering */}
      <style>{`
        @keyframes drishti-scan {
          0% {
            transform: rotate(0deg);
          }
          100% {
            transform: rotate(360deg);
          }
        }
        @keyframes drishti-pulse {
          0%,
          100% {
            transform: scale(1);
            opacity: 0.9;
          }
          50% {
            transform: scale(1.2);
            opacity: 1;
          }
        }
        @keyframes vibhaag-prism {
          0% {
            transform: rotate(0deg);
          }
          100% {
            transform: rotate(180deg);
          }
        }
        @keyframes parikshan-caliper {
          0%,
          100% {
            transform: translateY(0);
          }
          50% {
            transform: translateY(-2.5px);
          }
        }
        @keyframes saakshi-seal {
          0% {
            transform: scale(0.96) rotate(0deg);
            opacity: 0.85;
          }
          50% {
            transform: scale(1.08) rotate(15deg);
            opacity: 1;
          }
          100% {
            transform: scale(0.96) rotate(0deg);
            opacity: 0.85;
          }
        }
        @keyframes sudhaar-pivot {
          0%,
          100% {
            transform: rotate(-8deg);
          }
          50% {
            transform: rotate(8deg);
          }
        }
        @keyframes karya-gear-cw {
          0% {
            transform: rotate(0deg);
          }
          100% {
            transform: rotate(360deg);
          }
        }
        @keyframes karya-gear-ccw {
          0% {
            transform: rotate(0deg);
          }
          100% {
            transform: rotate(-360deg);
          }
        }
        @keyframes lekha-link {
          0% {
            stroke-dashoffset: 0;
          }
          100% {
            stroke-dashoffset: 16;
          }
        }
        @keyframes nazar-radar {
          0% {
            transform: rotate(0deg);
          }
          100% {
            transform: rotate(360deg);
          }
        }
        @keyframes prativedan-dossier {
          0%,
          100% {
            transform: translateY(0) rotate(0deg);
          }
          50% {
            transform: translateY(-1.5px) rotate(-3deg);
          }
        }
        @keyframes sanket-sonar {
          0% {
            r: 3;
            opacity: 1;
          }
          100% {
            r: 13;
            opacity: 0;
          }
        }
        @keyframes breath-slow {
          0%,
          100% {
            opacity: 0.5;
            transform: scale(0.97);
          }
          50% {
            opacity: 1;
            transform: scale(1.03);
          }
        }
      `}</style>
    </span>
  );
}

interface SvgContentProps {
  agent: AgentKey | string;
  state: AgentIconState;
  accent: string;
}

function AgentSvgContent({ agent, state, accent }: SvgContentProps) {
  const isWorking = state === 'working';
  const isThinking = state === 'thinking';

  switch (agent) {
    // ── 1. Drishti (Discovery & Sight) ──────────────────────────────
    // Cybernetic scanner aperture + reticle
    case 'drishti':
      return (
        <g>
          {/* Outer reticle */}
          <circle
            cx="16"
            cy="16"
            r="13"
            stroke={accent}
            strokeWidth="1.75"
            strokeDasharray={isWorking ? '6 3' : isThinking ? '4 2' : 'none'}
            style={{
              transformOrigin: '16px 16px',
              animation: isWorking ? 'drishti-scan 3s linear infinite' : undefined,
            }}
          />
          {/* Eye aperture arcs */}
          <path
            d="M5 16C8 10 24 10 27 16C24 22 8 22 5 16Z"
            stroke={accent}
            strokeWidth="1.5"
            strokeLinejoin="round"
            fill={isWorking ? `${accent}25` : 'none'}
          />
          {/* Scanner pupil */}
          <circle
            cx="16"
            cy="16"
            r={isWorking ? '4.5' : '3.5'}
            fill={accent}
            style={{
              transformOrigin: '16px 16px',
              animation: isWorking
                ? 'drishti-pulse 1.2s ease-in-out infinite'
                : isThinking
                  ? 'breath-slow 2s ease-in-out infinite'
                  : undefined,
            }}
          />
          {/* Reticle ticks */}
          <line x1="16" y1="3" x2="16" y2="7" stroke={accent} strokeWidth="1.5" />
          <line x1="16" y1="25" x2="16" y2="29" stroke={accent} strokeWidth="1.5" />
          <line x1="3" y1="16" x2="7" y2="16" stroke={accent} strokeWidth="1.5" />
          <line x1="25" y1="16" x2="29" y2="16" stroke={accent} strokeWidth="1.5" />
        </g>
      );

    // ── 2. Vibhaag (Classification & Tagging) ────────────────────────
    // Crystalline data prism / faceted diamond
    case 'vibhaag':
      return (
        <g
          style={{
            transformOrigin: '16px 16px',
            animation: isWorking
              ? 'vibhaag-prism 4s ease-in-out infinite alternate'
              : isThinking
                ? 'breath-slow 2.5s ease-in-out infinite'
                : undefined,
          }}
        >
          {/* Outer diamond envelope */}
          <polygon
            points="16,3 28,16 16,29 4,16"
            stroke={accent}
            strokeWidth="1.75"
            fill={`${accent}15`}
          />
          {/* Internal crystalline facet dividing lines */}
          <line
            x1="16"
            y1="3"
            x2="16"
            y2="29"
            stroke={accent}
            strokeWidth="1.25"
            strokeDasharray={isWorking ? '3 1' : 'none'}
          />
          <line x1="4" y1="16" x2="28" y2="16" stroke={accent} strokeWidth="1.25" />
          <polygon
            points="16,9 23,16 16,23 9,16"
            fill={isWorking ? accent : `${accent}40`}
            stroke={accent}
            strokeWidth="1"
            style={{
              transformOrigin: '16px 16px',
              animation: isWorking ? 'drishti-pulse 1.5s ease-in-out infinite' : undefined,
            }}
          />
        </g>
      );

    // ── 3. Parikshan (Assessment & Gap Measurement) ──────────────────
    // Inspection shield with precision gauge and verified tick
    case 'parikshan':
      return (
        <g>
          {/* Shield crest */}
          <path
            d="M16 3L27 7V16C27 22.5 22.2 27.5 16 29C9.8 27.5 5 22.5 5 16V7L16 3Z"
            stroke={accent}
            strokeWidth="1.75"
            fill={`${accent}18`}
          />
          {/* Caliper gauge indicator */}
          <g
            style={{
              transformOrigin: '16px 16px',
              animation: isWorking
                ? 'parikshan-caliper 1.5s ease-in-out infinite'
                : isThinking
                  ? 'breath-slow 2s ease-in-out infinite'
                  : undefined,
            }}
          >
            {/* Calibration scale arc */}
            <path
              d="M10 15C10 11.7 12.7 9 16 9C19.3 9 22 11.7 22 15"
              stroke={accent}
              strokeWidth="1.5"
              strokeDasharray="2 2"
              fill="none"
            />
            {/* Checkmark needle */}
            <path
              d="M11 16L14.5 19.5L21 12"
              stroke={isWorking ? '#0FB5A5' : accent}
              strokeWidth="2.25"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </g>
        </g>
      );

    // ── 4. Saakshi (Evidence & WORM Sealer) ───────────────────────────
    // Eight-point starburst wax seal stamp with vault padlock (Gold)
    case 'saakshi':
      return (
        <g
          style={{
            transformOrigin: '16px 16px',
            animation: isWorking
              ? 'saakshi-seal 2.5s ease-in-out infinite'
              : isThinking
                ? 'breath-slow 2s ease-in-out infinite'
                : undefined,
          }}
        >
          {/* Eight-point starburst rosette seal */}
          <path
            d="M16 3L19.5 6.5L24.5 6L25.5 11L30 13.5L28.5 18.5L31 23L26.5 25L25 30L20 29L16 32L12 29L7 30L5.5 25L1 23L3.5 18.5L2 13.5L6.5 11L7.5 6L12.5 6.5L16 3Z"
            fill={`${accent}25`}
            stroke={accent}
            strokeWidth="1.5"
          />
          {/* Inner lock body */}
          <rect
            x="11"
            y="14"
            width="10"
            height="9"
            rx="2"
            fill={accent}
            stroke={accent}
            strokeWidth="1.25"
          />
          {/* Shackle */}
          <path
            d="M13 14V11C13 9.3 14.3 8 16 8C17.7 8 19 9.3 19 11V14"
            stroke={accent}
            strokeWidth="1.75"
            fill="none"
            strokeLinecap="round"
          />
          {/* Cryptographic keyhole */}
          <circle cx="16" cy="17.5" r="1.2" fill="#FFFFFF" />
          <path d="M15.4 18.5H16.6L17 21H15L15.4 18.5Z" fill="#FFFFFF" />
        </g>
      );

    // ── 5. Sudhaar (Remediation Planner - Read-Only) ──────────────────
    // Drafting compass & branching blueprint circuit
    case 'sudhaar':
      return (
        <g>
          {/* Blueprint circuit path */}
          <path
            d="M6 25L12 19M26 25L20 19"
            stroke={accent}
            strokeWidth="1.5"
            strokeDasharray={isWorking ? '2 2' : 'none'}
          />
          {/* Compass apex circle */}
          <circle cx="16" cy="7" r="3" stroke={accent} strokeWidth="1.75" fill={`${accent}20`} />
          {/* Compass legs pivoting */}
          <g
            style={{
              transformOrigin: '16px 7px',
              animation: isWorking
                ? 'sudhaar-pivot 2s ease-in-out infinite'
                : isThinking
                  ? 'breath-slow 2s ease-in-out infinite'
                  : undefined,
            }}
          >
            <line
              x1="14.5"
              y1="9.5"
              x2="8"
              y2="25"
              stroke={accent}
              strokeWidth="2"
              strokeLinecap="round"
            />
            <line
              x1="17.5"
              y1="9.5"
              x2="24"
              y2="25"
              stroke={accent}
              strokeWidth="2"
              strokeLinecap="round"
            />
            <path d="M10 19H22" stroke={accent} strokeWidth="1.5" />
          </g>
          {/* Dual branch nodes (Action & Rollback) */}
          <circle cx="8" cy="25" r="2.5" fill={accent} />
          <circle cx="24" cy="25" r="2.5" fill={isWorking ? '#0FB5A5' : accent} />
        </g>
      );

    // ── 6. Karya (Execution Engine - Mutator) ─────────────────────────
    // High-voltage lightning core inside dual planetary gears
    case 'karya':
      return (
        <g>
          {/* Primary gear */}
          <g
            style={{
              transformOrigin: '16px 16px',
              animation: isWorking
                ? 'karya-gear-cw 3s linear infinite'
                : isThinking
                  ? 'karya-gear-cw 8s linear infinite'
                  : undefined,
            }}
          >
            <circle
              cx="16"
              cy="16"
              r="11"
              stroke={accent}
              strokeWidth="1.5"
              strokeDasharray="4 2.5"
            />
            <circle cx="16" cy="16" r="8" stroke={accent} strokeWidth="1.25" fill={`${accent}15`} />
          </g>
          {/* Counter gear ticks */}
          <g
            style={{
              transformOrigin: '16px 16px',
              animation: isWorking ? 'karya-gear-ccw 2s linear infinite' : undefined,
            }}
          >
            <circle
              cx="16"
              cy="16"
              r="13"
              stroke={accent}
              strokeWidth="1"
              strokeDasharray="1 7"
              opacity="0.6"
            />
          </g>
          {/* Central high-voltage execution lightning bolt */}
          <path
            d="M17.5 7L11.5 16H16.5L14.5 25L21.5 15H16.5L17.5 7Z"
            fill={accent}
            stroke={isWorking ? '#FFFFFF' : accent}
            strokeWidth="0.75"
            style={{
              transformOrigin: '16px 16px',
              animation: isWorking ? 'drishti-pulse 0.8s ease-in-out infinite' : undefined,
            }}
          />
        </g>
      );

    // ── 7. Lekha (Audit Ledger & Hash Chain) ─────────────────────────
    // Merkle block chain with sequential cryptographic link rings
    case 'lekha':
      return (
        <g>
          {/* Interlocking chain links */}
          <rect
            x="5"
            y="7"
            width="10"
            height="11"
            rx="3"
            stroke={accent}
            strokeWidth="2"
            fill={`${accent}15`}
            style={{
              transformOrigin: '10px 12.5px',
              animation: isWorking ? 'breath-slow 1.6s ease-in-out infinite' : undefined,
            }}
          />
          <rect
            x="17"
            y="14"
            width="10"
            height="11"
            rx="3"
            stroke={accent}
            strokeWidth="2"
            fill={`${accent}15`}
            style={{
              transformOrigin: '22px 19.5px',
              animation: isWorking ? 'breath-slow 1.6s ease-in-out infinite 0.8s' : undefined,
            }}
          />
          {/* Dynamic cryptographic connector line */}
          <line
            x1="12"
            y1="15"
            x2="20"
            y2="17"
            stroke={accent}
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={isWorking ? '3 3' : 'none'}
            style={{
              animation: isWorking ? 'lekha-link 1s linear infinite' : undefined,
            }}
          />
          {/* Micro-hash blocks */}
          <circle cx="10" cy="12.5" r="1.5" fill={accent} />
          <circle cx="22" cy="19.5" r="1.5" fill={accent} />
          <circle cx="7" cy="25" r="1.5" fill={accent} opacity="0.5" />
          <circle cx="25" cy="7" r="1.5" fill={accent} opacity="0.5" />
        </g>
      );

    // ── 8. Nazar (Regulatory Watchdog) ────────────────────────────────
    // Observatory dish + perimeter surveillance radar sweep
    case 'nazar':
      return (
        <g>
          {/* Concentric radar rings */}
          <circle cx="16" cy="16" r="13" stroke={accent} strokeWidth="1.5" fill={`${accent}10`} />
          <circle cx="16" cy="16" r="8" stroke={accent} strokeWidth="1" strokeDasharray="3 2" />
          <circle cx="16" cy="16" r="3" fill={accent} />
          {/* Radar sweep beam */}
          <g
            style={{
              transformOrigin: '16px 16px',
              animation: isWorking
                ? 'nazar-radar 2s linear infinite'
                : isThinking
                  ? 'nazar-radar 5s linear infinite'
                  : undefined,
            }}
          >
            <line
              x1="16"
              y1="16"
              x2="27"
              y2="7"
              stroke={accent}
              strokeWidth="2"
              strokeLinecap="round"
            />
            <path d="M16 16L27 7A13 13 0 0 0 16 3V16Z" fill={`${accent}35`} />
          </g>
          {/* Regulatory beacon blips */}
          <circle cx="24" cy="14" r="1.75" fill={isWorking ? '#EAB308' : accent} />
          <circle cx="10" cy="22" r="1.25" fill={accent} opacity="0.7" />
        </g>
      );

    // ── 9. Prativedan (Reporting & Dossiers) ──────────────────────────
    // Executive dossier scroll with wax seal ribbon and stylus
    case 'prativedan':
      return (
        <g
          style={{
            transformOrigin: '16px 16px',
            animation: isWorking
              ? 'prativedan-dossier 2s ease-in-out infinite'
              : isThinking
                ? 'breath-slow 2.5s ease-in-out infinite'
                : undefined,
          }}
        >
          {/* Background report page */}
          <path
            d="M9 5H21C22.1 5 23 5.9 23 7V23C23 24.1 22.1 25 21 25H9C7.9 25 7 24.1 7 23V7C7 5.9 7.9 5 9 5Z"
            stroke={accent}
            strokeWidth="1.75"
            fill={`${accent}15`}
          />
          {/* Text lines */}
          <line
            x1="11"
            y1="10"
            x2="19"
            y2="10"
            stroke={accent}
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <line
            x1="11"
            y1="14"
            x2="19"
            y2="14"
            stroke={accent}
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <line
            x1="11"
            y1="18"
            x2="16"
            y2="18"
            stroke={accent}
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          {/* Certified ribbon seal on report corner */}
          <circle cx="20" cy="22" r="3.5" fill={accent} />
          <path d="M19 25L20 29L21 25" stroke={accent} strokeWidth="1.5" strokeLinejoin="round" />
        </g>
      );

    // ── 10. Sanket (Signal & Early Warning) ───────────────────────────
    // Transmission tower with radiating spherical waves
    case 'sanket':
      return (
        <g>
          {/* Antenna tower legs */}
          <path
            d="M12 28L15 13H17L20 28M13.5 21H18.5"
            stroke={accent}
            strokeWidth="1.75"
            strokeLinecap="round"
          />
          {/* Spire tip */}
          <line
            x1="16"
            y1="13"
            x2="16"
            y2="8"
            stroke={accent}
            strokeWidth="2"
            strokeLinecap="round"
          />
          <circle cx="16" cy="8" r="2.5" fill={accent} />

          {/* Sonar radiating waves */}
          <circle
            cx="16"
            cy="8"
            r="6"
            stroke={accent}
            strokeWidth="1.25"
            fill="none"
            style={{
              animation: isWorking
                ? 'sanket-sonar 1.8s cubic-bezier(0, 0.2, 0.8, 1) infinite'
                : isThinking
                  ? 'breath-slow 2s ease-in-out infinite'
                  : undefined,
            }}
          />
          <circle
            cx="16"
            cy="8"
            r="10"
            stroke={accent}
            strokeWidth="1"
            fill="none"
            opacity="0.6"
            style={{
              animation: isWorking
                ? 'sanket-sonar 1.8s cubic-bezier(0, 0.2, 0.8, 1) infinite 0.6s'
                : undefined,
            }}
          />
        </g>
      );

    // ── 11. Policy Engine (Standing Architectural Guardrails) ───────────
    case 'policy':
    case 'policy_engine':
      return (
        <g>
          {/* Shield frame */}
          <path
            d="M16 3L27 7V15C27 21.5 22.2 26.5 16 28.5C9.8 26.5 5 21.5 5 15V7L16 3Z"
            stroke={accent}
            strokeWidth="1.75"
            fill={`${accent}18`}
          />
          {/* Central scale balance */}
          <line x1="16" y1="9" x2="16" y2="22" stroke={accent} strokeWidth="1.5" />
          <line
            x1="10"
            y1="13"
            x2="22"
            y2="13"
            stroke={accent}
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <path d="M8 17L10 13L12 17H8Z" fill={accent} opacity="0.8" />
          <path d="M20 17L22 13L24 17H20Z" fill={accent} opacity="0.8" />
          <circle cx="16" cy="13" r="2" fill={accent} />
        </g>
      );

    // ── 12. Incident Ops (Emergency & Breach Response) ───────────────────
    case 'incident':
      return (
        <g>
          {/* Hexagonal hazard crest */}
          <polygon
            points="16,3 27,9 27,23 16,29 5,23 5,9"
            stroke={accent}
            strokeWidth="1.75"
            fill={`${accent}18`}
          />
          {/* Alert flash */}
          <path
            d="M17 8L10 17H16L15 24L22 15H16L17 8Z"
            fill={accent}
            stroke={accent}
            strokeWidth="0.5"
            strokeLinejoin="round"
          />
        </g>
      );

    // ── 13. DSAR (Data Principal Rights Engine) ─────────────────────────
    case 'dsar':
      return (
        <g>
          {/* ID card frame */}
          <rect
            x="4"
            y="6"
            width="24"
            height="20"
            rx="3"
            stroke={accent}
            strokeWidth="1.75"
            fill={`${accent}15`}
          />
          <circle cx="12" cy="13" r="3" stroke={accent} strokeWidth="1.5" fill={`${accent}30`} />
          <path
            d="M7 21C7 18.5 9.2 17.5 12 17.5C14.8 17.5 17 18.5 17 21"
            stroke={accent}
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <line
            x1="19"
            y1="12"
            x2="24"
            y2="12"
            stroke={accent}
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <line
            x1="19"
            y1="16"
            x2="24"
            y2="16"
            stroke={accent}
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </g>
      );

    // ── 14. Consent Manager (Dual Bilingual Notice & Seals) ─────────────
    case 'consent':
      return (
        <g>
          {/* Agreement seal ring */}
          <circle
            cx="16"
            cy="16"
            r="12"
            stroke={accent}
            strokeWidth="1.75"
            fill={`${accent}15`}
            strokeDasharray={isWorking ? '4 2' : 'none'}
          />
          <path
            d="M10 16L14 20L22 11"
            stroke={accent}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
      );

    default:
      return <circle cx="16" cy="16" r="10" stroke={accent} strokeWidth="2" fill={`${accent}20`} />;
  }
}
