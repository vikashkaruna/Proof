/**
 * Tailwind preset: drop this into a consuming app's tailwind.config.ts.
 *
 * Usage:
 *   import preset from '@axiom/design-tokens/tailwind';
 *   export default { presets: [preset], content: [...] };
 */

import type { Config } from 'tailwindcss';
import twColors from 'tailwindcss/colors';
import { colors, agentAccents } from './colors';
import { fontFamily, fontSize, fontWeight } from './typography';
import { borderRadius, boxShadow, spacing, motion } from './spacing';

export const axiomPreset: Partial<Config> = {
  theme: {
    colors: {
      ...colors,
      // Status families. The product code was written against Tailwind's own red, green,
      // amber and friends for errors, successes and warnings, but a preset that sets
      // theme.colors replaces the default palette, so those utilities generated no CSS.
      // Gold stays reserved for sealed evidence; warnings use amber.
      red: twColors.red,
      green: twColors.green,
      amber: twColors.amber,
      emerald: twColors.emerald,
      yellow: twColors.yellow,
      orange: twColors.orange,
      blue: twColors.blue,
      rose: twColors.rose,
      // expose agent accents as a dedicated namespace
      agent: agentAccents,
    },
    fontFamily: {
      heading: fontFamily.heading,
      body: fontFamily.body,
      mono: fontFamily.mono,
      sans: fontFamily.body,
    },
    fontSize,
    fontWeight,
    extend: {
      borderRadius,
      boxShadow,
      spacing,
      transitionDuration: motion.duration,
      transitionTimingFunction: motion.easing,
    },
  },
};

export default axiomPreset;
