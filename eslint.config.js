// Flat ESLint config (ESLint v9). Type-aware via typescript-eslint's project
// service so `@typescript-eslint/no-deprecated` can see JSDoc `@deprecated`
// tags across the workspace. Kept PRAGMATIC: the repo predates linting, so the
// noisy stylistic rules are relaxed — the pre-commit lint-staged pass only ever
// lints the files you touch, so existing code is not retro-flagged. Prettier
// owns all formatting (eslint-config-prettier disables conflicting rules).
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'

// Node/Bun runtime globals for the repo's plain-JS config & script files (they
// run under Bun/Node, not the browser). typescript-eslint disables core
// `no-undef` for typed .ts, but ESLint keeps it ON for js/mjs/cjs — so without
// this it flags process/console/Buffer/Bun in e.g. playground/_dc0-diff.mjs
// (the DC=0 relocation differ) and any future node script. (#1055 Wave 5.)
const nodeScriptGlobals = {
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  Bun: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  fetch: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
}

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
            // playground/playwright.config.ts sits at the package root, outside
            // both playground/tsconfig.json (src/** only) and e2e/tsconfig.json
            // (e2e/** only) — same gap, same fix as the scripts above.
            'playground/playwright.config.ts',
            // @xgis/pipeline offline bake tools (csv-to-odb, seoul-openapi-bake)
            // live outside the package tsconfig's `include` (src/**) for the same
            // reason — they are devDep scripts, not shipped package code.
            'pipeline/tools/*.ts',
            // The root vitest.config.ts is a workspace-level config that no
            // package tsconfig `include`s, and the root tsconfig.json only holds
            // project references (`files: []`) — same discovery gap as the scripts
            // and playwright config above. Lint it via the default project.
            'vitest.config.ts',
            // The remaining project-service gaps from the #1055 lint-debt ledger
            // (Appendix A) — the same class as the entries above, closed wholesale:
            // compiler's package-root micro-bench, a devDep script outside the
            // package tsconfig's `include` (src/**), same as pipeline/tools.
            'compiler/bench-geojson-vt-encode.ts',
            // Runnable research prototypes live under docs/, which no package
            // tsconfig covers at all.
            'docs/research/prototypes/*.ts',
            // playground's package-root capture script, the render-verify harness,
            // and its probe scripts sit outside playground/tsconfig.json (src/**
            // only) and e2e/tsconfig.json (e2e/** only) — same gap as the
            // playwright config above.
            'playground/capture-shader-thumbnails.mts',
            'playground/render-verify/*.ts',
            'playground/render-verify/matrix/*.ts',
            'playground/scripts/*.ts',
            // Per-package vite configs sit at the package root, outside their
            // package tsconfig's `include` — same gap as the root vitest.config.ts.
            'playground/vite.config.ts',
            'runtime/vite.config.ts',
            // runtime's build/inspect scripts — devDep scripts outside the package
            // tsconfig's `include`, same as the repo scripts above.
            'runtime/scripts/*.ts',
          ],
          // the default cap is 8 matched files per run; a refactor staging many
          // test files at once must still lint. 117 files match today (86 shader-dsl
          // src tests + the script/config/bench globs above). Keep real headroom: at
          // a zero-headroom 96 the 97th match (vitest.config.ts) failed to parse the
          // day one new repo script landed (#1055 Wave 2).
          maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 160,
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
  // Those plain-JS files run under Node/Bun — give them the runtime globals so
  // core `no-undef` doesn't flag process/console/Buffer/Bun. Kept a separate
  // block so its `languageOptions.globals` MERGES with (rather than clobbers)
  // disableTypeChecked's `languageOptions.parserOptions` above.
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: { globals: nodeScriptGlobals },
  },
  prettier,
)
