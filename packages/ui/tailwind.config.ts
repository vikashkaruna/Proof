import type { Config } from 'tailwindcss';
import preset from '@axiom/design-tokens/tailwind';

const scale = '0|0\\.5|1|1\\.5|2|2\\.5|3|4|5|6|8|10|12|16|20|24';
const palette = 'indigo|teal|gold|ember|slate|mist|red|green|amber|emerald|yellow|orange|blue|rose';
const steps = '50|100|200|300|400|500|600|700|800|900';

// Same preset the web app uses. Scanning only this package would leave dist/ui.css with
// just the utilities the components themselves use, so a design built WITH the library
// could not lay itself out; the safelist adds the everyday layout, spacing, type and
// colour utilities that glue code around the components needs.
export default {
  presets: [preset],
  content: ['./src/**/*.{ts,tsx}', '../design-tokens/src/**/*.{ts,tsx}'],
  safelist: [
    { pattern: new RegExp(`^(bg|text|border|ring|fill|stroke)-(${palette})-(${steps})$`) },
    { pattern: /^(bg|text|border)-(white|transparent)$/ },
    {
      pattern: new RegExp(
        `^(p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|gap-x|gap-y|space-x|space-y)-(${scale})$`,
      ),
    },
    {
      pattern:
        /^(w|h)-(full|screen|fit|auto|px|1\/2|1\/3|2\/3|1\/4|3\/4|4|5|6|8|10|12|16|20|24|32|48|64)$/,
    },
    { pattern: /^max-w-(xs|sm|md|lg|xl|2xl|3xl|4xl|5xl|6xl|full)$/ },
    { pattern: /^(flex|inline-flex|grid|block|inline-block|hidden)$/ },
    { pattern: /^(flex-col|flex-row|flex-wrap|flex-1|shrink-0|grow)$/ },
    { pattern: /^(items|justify|self)-(start|center|end|between|stretch|baseline)$/ },
    { pattern: /^grid-cols-(1|2|3|4|6|12)$/, variants: ['sm', 'md', 'lg'] },
    { pattern: /^col-span-(1|2|3|4|6|full)$/ },
    {
      pattern:
        /^(rounded|rounded-(md|lg|xl|2xl|full)|border|border-(2|dashed)|shadow|shadow-(sm|md|lg))$/,
    },
    { pattern: /^text-(xs|sm|base|lg|xl|2xl|3xl|4xl|left|center|right)$/ },
    { pattern: /^font-(normal|medium|semibold|bold|heading|body|mono)$/ },
    {
      pattern:
        /^(uppercase|capitalize|truncate|tracking-wide|tracking-wider|leading-tight|leading-relaxed|overflow-hidden|overflow-auto|relative|absolute)$/,
    },
  ],
} satisfies Config;
