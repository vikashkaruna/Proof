import type { Config } from 'tailwindcss';
import preset from '@axiom/design-tokens/tailwind';

// Same preset the web app uses, scanning only this package, so dist/ui.css holds exactly
// the utilities the components need.
export default {
  presets: [preset],
  content: ['./src/**/*.{ts,tsx}', '../design-tokens/src/**/*.{ts,tsx}'],
} satisfies Config;
