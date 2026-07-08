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
        // shader-dsl's src tests are EXCLUDED from the package tsconfig.json
        // (compiled test JS must not ride into dist/ — #763 V6) and live only
        // in tsconfig.tests.json, which project-service discovery (it walks
        // tsconfig.json files only) cannot see. Without this, typed lint fails
        // to parse any newly STAGED src test file in pre-commit. Lint them via
        // the default project; their real type gate stays the package build's
        // `tsc -p tsconfig.tests.json` noEmit pass. (examples/ and
        // playground/e2e/ solved the same gap with their own tsconfig.json —
        // possible there because those directories contain no non-test files
        // a nested tsconfig would hijack from the package project.)
        projectService: {
          allowDefaultProject: [
            'shader-dsl/src/core/*.test.ts',
            'shader-dsl/src/core/backends/*.test.ts',
            'shader-dsl/src/core/diagnostics/*.test.ts',
            'shader-dsl/src/core/fp64/*.test.ts',
            'shader-dsl/src/core/ir/*.test.ts',
            'shader-dsl/src/core/passes/*.test.ts',
            'shader-dsl/src/core/passes/lint/*.test.ts',
            'shader-dsl/src/core/passes/lint/rules/*.test.ts',
            'shader-dsl/src/core/passes/opt/*.test.ts',
            // Repo scripts (precheck, matrix tooling, snapshot capture) live
            // outside every package tsconfig's `include`, so project-service
            // discovery can't parse a newly STAGED one in pre-commit. Lint them
            // via the default project, same as the src tests above.
            'scripts/*.ts',
          ],
          // the default cap is 8 matched files per run; a refactor staging many
          // test files at once must still lint (70 test files exist today).
          maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 96,
        },
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
