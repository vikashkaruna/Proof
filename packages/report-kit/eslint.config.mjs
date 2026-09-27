import shared from '@axiom/eslint-config';

const config = [
  ...shared,
  {
    files: ['**/*.{ts,mjs}'],
    rules: {
      '@next/next/no-html-link-for-pages': 'off',
      '@next/next/no-img-element': 'off',
      '@next/next/no-page-custom-font': 'off',
    },
  },
];

export default config;
