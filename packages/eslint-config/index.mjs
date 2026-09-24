import nextVitals from 'eslint-config-next/core-web-vitals';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * Shared ESLint flat config for the Next.js applications.
 *
 * Why this package exists
 * ----------------------
 * The repo builds on TypeScript 7. `typescript-eslint` 8.70 — the latest
 * published — hard-throws on import against TS 7 (upstream tracking issue
 * typescript-eslint#10940; support is expected for TS >= 7.1). Because
 * `eslint-config-next` imports `typescript-eslint` transitively, and
 * `typescript-eslint` cannot parse TS without it, linting the two Next apps
 * was crashing outright rather than reporting findings.
 *
 * `typescript` is a *peer* dependency of `typescript-eslint`, so it resolves
 * from the graph of whichever package imports it — which means a pnpm
 * `overrides` entry cannot redirect it. Giving the ESLint toolchain its own
 * package does work: pnpm installs TypeScript 6 here, `typescript-eslint`
 * resolves that, and the version check passes.
 *
 * This is the side-by-side arrangement Microsoft documents for TS 7. Nothing
 * else changes: `tsc`, the editor and every build still run TypeScript 7. The
 * TS 6 copy is used only to satisfy the linter's compiler API.
 *
 * Remove this package's `typescript` pin once typescript-eslint ships TS 7
 * support, and the apps can depend on `eslint-config-next` directly again.
 */
const config = [
  ...nextVitals,
  {
    // Flat config resolves a rule's plugin from the object the rule is
    // declared in, so an override that *changes* a plugin rule must re-declare
    // the plugin. (Turning one off does not, which is why the entry below it
    // worked without this.)
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react/no-unescaped-entities': 'off',

      'react-hooks/set-state-in-effect': 'error',
    },
  },
  {
    // Code-scanning parity (CodeQL js/insecure-randomness, js/incomplete-url-
    // substring-sanitization) caught while editing instead of at CI time.
    files: ['**/*.{ts,tsx,js,jsx,mjs}'],
    ignores: ['**/*.test.*', '**/*.spec.*', '**/tests/**'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message:
            'Math.random is predictable. Use crypto.randomUUID()/crypto.getRandomValues(); never invent ids, hashes or scores.',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.property.name='includes'][arguments.0.value=/^([a-z0-9-]+\\.)+[a-z]{2,}$/i]",
          message:
            'Do not match a host by substring. Parse with new URL() and compare hostname exactly or by "." + domain suffix.',
        },
      ],
    },
  },
  {
    // Tracked debt: these screens still fabricate ids/hashes/scores with
    // Math.random (display-provenance defect, Docs 11-16 follow-up). Remove a
    // file from this list when it is fixed; new files are never added here.
    files: [
      'src/app/(app)/approval/approval-client.tsx',
      'src/app/(app)/dsars/dsar-client.tsx',
      'src/app/(app)/evidence/evidence-client.tsx',
      'src/app/(app)/regwatch/regwatch-client.tsx',
      'src/app/(app)/reports/reports-client.tsx',
    ],
    rules: { 'no-restricted-properties': 'off' },
  },
];

export default config;
