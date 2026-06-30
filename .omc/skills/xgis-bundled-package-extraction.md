---
name: xgis-bundled-package-extraction
description: Extracting a bundled workspace package (@xgis/engine, @xgis/map, @xgis/compiler) in X-GIS — package.json MUST export src not dist, only a from-scratch build reproduces CI, importer rewrite must sweep site/ too
triggers:
  - "Failed to resolve entry for package \"@xgis"
  - "Could not resolve" runtime/src/engine import from site
  - extract @xgis/map
  - extract @xgis/engine
  - bundled workspace package exports dist vs src
  - from-scratch bun run build engine dist absent
  - p3-package-extraction
  - "@xgis/site build" could not resolve runtime internals
---

# Extracting a Bundled Workspace Package in X-GIS

## The Insight

X-GIS workspace packages (`@xgis/engine`, `@xgis/map`, `@xgis/compiler`, `@xgis/shared`,
`@xgis/shader-dsl`) are **bundled INTO** `runtime` by Vite — they are NOT external npm
packages. `runtime/vite.config.ts` (~line 13-17) lists them as bundled-in, so the bundler and
vitest resolve them through `package.json` `main`/`exports`. That means those fields MUST point
at **source**:

```jsonc
// engine/package.json AND map/package.json
"main": "./src/index.ts",
"exports": { ".": "./src/index.ts" }   // NOT "./dist/index.js"
```

`tsc` still resolves types via `runtime/tsconfig.json` `paths` → `../engine/dist/index.d.ts`
(built by project references). So `tsc --build` and the bundler take **different** resolution
paths and both must work simultaneously — dist for types, src for bundling.

## Why This Matters

If you point `exports` at `./dist/index.js` (the instinctive "published package" shape), local
builds pass because your `engine/dist` is already built — but **CI fails**. CI runs a
from-scratch `bun run build` that is **NOT topologically ordered**: `runtime` builds BEFORE
`engine`, so `engine/dist` does not exist yet →

```
@xgis/runtime build: Failed to resolve entry for package "@xgis/engine".
The package may have incorrect main/module/exports specified in its package.json.
```

This cost two separate CI-red pushes before the src-export shape was nailed.

## Recognition Pattern

- A new `@xgis/*` package was scaffolded or had files relocated into it.
- Local `bun run build` is green but CI is red with "Failed to resolve entry for package".
- Or CI red with `@xgis/site build: Could not resolve ".../runtime/src/engine/..."` — `site/`
  deep-imports runtime internals (relative `../../../../../runtime/src/engine/...`) for doc
  examples (e.g. `site/src/pages/docs/concepts/compute.astro`). A relocation that only swept
  `runtime/src` + `playground/` leaves those site paths dangling.

## The Approach

1. **Set `exports`/`main` to `./src/index.ts`** for any bundled-in workspace package. Keep
   `"build": "tsc --build"` and the `references` for the type side.
2. **Reproduce CI locally before pushing** — local dist masks the failure:
   ```bash
   rm -rf engine/dist map/dist && (cd runtime && bun run build)
   ```
   If that succeeds with the dist dirs absent, the export shape is correct. (Restore types
   afterward with `tsc --build --force` if your editor/tsc went red — incremental tsc won't
   rebuild a dist you manually deleted.)
3. **Sweep the FULL importer surface**, not just `runtime/src`: also grep `playground/**` and
   `site/**`. `site/` imports runtime internals via long relative paths for documentation; miss
   them and `@xgis/site build` fails in CI only.
4. **Trust `tsc --build` (exit 0) over LSP** after big moves — the LSP shows phantom "not a
   module" errors for ~minutes; `tsc --build -p runtime/tsconfig.json` is the authority.

## Example

The bug fix (engine/package.json + map/package.json), the from-scratch repro, and the site
repoint all live in PR #714. The same gotchas will recur for **P3 Steps 6-9** (extracting
`@xgis/map`) — plan in `docs/architecture/p3-package-extraction-plan.md`.
