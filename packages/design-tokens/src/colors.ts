/**
 * Axiom Proof brand color tokens.
 *
 * Source of truth for the entire product. Per the brand guidelines:
 *   - Deep Indigo (primary) = institutional trust
 *   - Signal Teal (accent)  = active machine intelligence / approvals
 *   - Seal Gold (proof)     = reserved EXCLUSIVELY for sealed evidence / attestations
 *   - Ember (alert)         = gaps, risks, overdue
 *   - Slate / Mist          = neutrals
 *
 * Gold is load-bearing: it always means "this is proven." Never used decoratively.
 */

export const colors = {
  // Brand
  indigo: {
    50: '#EEF0F7',
    100: '#D6DBE8',
    200: '#A6B0CC',
    300: '#7585B0',
    400: '#4A5C95',
    500: '#1E2A4A', // primary
    600: '#19223C',
    700: '#141A2E',
    800: '#0F131F',
    900: '#0A0D17',
    950: '#050710',
  },
  teal: {
    50: '#E5FAF7',
    100: '#BFF1EB',
    200: '#80E3D7',
    300: '#40D5C3',
    400: '#1DC7B0',
    500: '#0FB5A5', // accent / signal
    600: '#0C9184',
    700: '#096D63',
    800: '#064943',
    900: '#032522',
  },
  gold: {
    50: '#FBF6E7',
    100: '#F4E7B7',
    200: '#ECD687',
    300: '#E3C557',
    400: '#DBB43F',
    500: '#C9A227', // proof / seal — never decorative
    600: '#A0821F',
    700: '#776217',
    800: '#4F410F',
    900: '#262107',
  },
  ember: {
    50: '#FCEEEC',
    100: '#F8D2CD',
    200: '#F0A59B',
    300: '#E87869',
    400: '#E05A48',
    500: '#D9534F', // alert
    600: '#AE4240',
    700: '#823130',
    800: '#562120',
    900: '#2B1010',
  },
  slate: {
    50: '#F7F8FA',
    100: '#EDEFF3',
    200: '#D8DCE4',
    300: '#B0B7C5',
    400: '#7E879A',
    500: '#525B71',
    600: '#3D4458',
    700: '#2F3542', // body text
    800: '#21252F',
    900: '#14171D',
    950: '#0A0B0E',
  },
  mist: {
    50: '#FBFCFD',
    100: '#F4F6F8', // bg
    200: '#E8ECF0',
    300: '#D4DAE3',
    400: '#B6BFCB',
    500: '#8E99AB',
    600: '#6A7585',
    700: '#4F5869',
    800: '#383E4A',
    900: '#1F232B',
  },
  // Functional
  white: '#FFFFFF',
  black: '#000000',
  transparent: 'transparent',
  current: 'currentColor',
  inherit: 'inherit',
} as const;

export type ColorToken = typeof colors;

/** Agent accent colors (one per agent, never confused with brand roles). */
export const agentAccents = {
  drishti: '#0FB5A5', // teal — discovery / sight
  vibhaag: '#7C3AED', // violet — classification
  parikshan: '#1E2A4A', // indigo — assessment
  saakshi: '#C9A227', // gold — evidence / witness
  sudhaar: '#0EA5E9', // sky — planning
  karya: '#D9534F', // ember — execution (high-stakes; alert color intentional)
  samadhan: '#0D9488', // teal-green — maker-checker & reconciliation equilibrium
  lekha: '#525B71', // slate — ledger
  nazar: '#16A34A', // green — watch
  prativedan: '#9333EA', // purple — reporting (drafts & working registers)
  pramaan: '#C9A227', // gold — statutory closure proof & sealed attestation
  sanket: '#EA580C', // orange — signal
} as const;

export type AgentName = keyof typeof agentAccents;
