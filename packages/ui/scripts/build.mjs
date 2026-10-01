// Compiles the library for consumers that need a built artifact (the design-sync
// pipeline). The workspace itself keeps resolving @axiom/ui to ./src through package.json,
// so this build is additive. Declarations come from tsc (tsconfig.build.json) and the
// stylesheet from the Tailwind CLI (see the "build" script).
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  sourcemap: true,
  // Published libraries leave their dependencies to the host; @axiom/design-tokens is
  // workspace TypeScript with no build of its own, so it is bundled in.
  external: [
    'react',
    'react-dom',
    'react/jsx-runtime',
    '@radix-ui/react-slot',
    'class-variance-authority',
    'clsx',
    'lucide-react',
    'tailwind-merge',
  ],
  logLevel: 'info',
});
