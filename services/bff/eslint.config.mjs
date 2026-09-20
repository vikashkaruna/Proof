import shared from '@axiom/eslint-config';

/**
 * W9 · R-11 — the BFF is the authoritative security gate and was not linted.
 *
 * Its `lint` script was `echo 'no lint config'`, so the package that decides
 * every authorisation in the product was the one package no static analysis
 * ever looked at. `pnpm lint` reported success for it on every run.
 */
const config = [
  ...shared,
  {
    files: ['src/**/*.ts'],
    rules: {
      // The BFF is where the service-role key legitimately lives, so the
      // restriction apps/web carries does not apply here. What does apply is
      // that a privileged client must not escape into a shared helper by
      // accident, which review covers and a rule cannot.
      //
      // `no-console` matters here for a different reason: structured logs are
      // how a security refusal becomes visible to an operator, and a stray
      // console.log bypasses the redaction the logger applies.
      'no-console': ['error', { allow: ['warn', 'error'] }],

      // The shared config is Next-flavoured because the apps need it. The
      // rules that assume a React page tree do not apply to a Hono server, and
      // leaving them on produces noise that trains people to ignore the lint.
      '@next/next/no-html-link-for-pages': 'off',
      '@next/next/no-img-element': 'off',
      '@next/next/no-page-custom-font': 'off',
    },
  },
  {
    // The logger is the one place console belongs: it is what every other
    // module calls INSTEAD of console.
    files: ['src/lib/logger.ts'],
    rules: { 'no-console': 'off' },
  },
];

export default config;
