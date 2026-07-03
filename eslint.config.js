// Flat ESLint config (ESLint v9). Type-aware via typescript-eslint's project
// service so `@typescript-eslint/no-deprecated` can see JSDoc `@deprecated`
// tags across the workspace. Kept PRAGMATIC: the repo predates linting, so the
// noisy stylistic rules are relaxed — the pre-commit lint-staged pass only ever
// lints the files you touch, so existing code is not retro-flagged. Prettier
// owns all formatting (eslint-config-prettier disables conflicting rules).
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '.claude/**',
      '**/__snapshots__/**',
      '**/*.snap',
      '**/coverage/**',
      'playground/dist/**',
      'site/dist/**',
      '**/*.d.ts',
      'eslint.config.js',
      'commitlint.config.js',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The load-bearing rule (the reason linting was requested): flag any use
      // of a JSDoc-`@deprecated` symbol as an error. Needs the type info above.
      '@typescript-eslint/no-deprecated': 'error',
      // Relaxations so the pre-existing tree is not a wall of errors. Tighten
      // incrementally later; lint-staged means only touched files are checked.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/no-empty-object-type': 'off',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'prefer-const': 'warn',
    },
  },
  // Config / script files: plain JS, no type-aware project.
  {
    files: ['**/*.{js,mjs,cjs}'],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
)
