import shared from '@axiom/eslint-config';

const config = [
  ...shared,
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@axiom/supabase',
              importNames: ['createSupabaseAdmin'],
              message: 'Privileged writes belong in the BFF. Use the user-scoped tenant context.',
            },
          ],
          patterns: ['@axiom/supabase/**/admin*'],
        },
      ],
    },
  },
];

export default config;
